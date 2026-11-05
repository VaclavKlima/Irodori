import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { readDevelopmentMessages, sendDevelopmentMessage } from './development-protocol.mjs'

export async function processExists(pid) {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false
    }
    return true
  } catch (error) {
    return error.code !== 'ESRCH' && error.code !== 'ENOENT'
  }
}

function groupApplications(group) {
  if (process.platform === 'win32') return []
  // Include an Electron that has started but has not registered yet, and retiring instances.
  const result = spawnSync('ps', ['-eo', 'pid=,pgid=,comm='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot confirm development application disappearance.')
  return result.stdout.split('\n').flatMap((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return fields && Number(fields[2]) === group && /electron|irodori/i.test(fields[3])
      ? [Number(fields[1])]
      : []
  })
}

export async function createDevelopmentSupervisor({ log = console.log } = {}) {
  const token = randomBytes(32).toString('hex')
  const instances = new Map()
  const sockets = new Set()
  let child
  let childExited = false
  let childCode = 0
  let stopping = false
  let seenApplication = false
  let finishing = false
  let checking = false
  let interval
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    const authentication = setTimeout(() => socket.destroy(), 2000)
    let registered
    socket.on('close', () => {
      clearTimeout(authentication)
      sockets.delete(socket)
      if (registered) registered.socket = undefined
    })
    readDevelopmentMessages(socket, (message) => {
      if (!registered) {
        if (
          message.type !== 'register' ||
          typeof message.token !== 'string' ||
          message.token.length !== token.length ||
          !timingSafeEqual(Buffer.from(message.token), Buffer.from(token)) ||
          typeof message.instance !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(message.instance) ||
          !Number.isSafeInteger(message.pid) ||
          message.pid <= 0 ||
          instances.has(message.instance)
        )
          return socket.destroy()
        clearTimeout(authentication)
        registered = { pid: message.pid, socket, lossSent: false }
        instances.set(message.instance, registered)
        seenApplication = true
        sendDevelopmentMessage(socket, { type: 'registered' })
        if (childExited) notifyLoss(registered)
        else if (stopping) sendDevelopmentMessage(socket, { type: 'shutdown', reason: 'stop' })
      } else if (
        message.type === 'outcome' &&
        message.instance &&
        instances.get(message.instance) === registered
      ) {
        if (message.outcome === 'kept-open') {
          stopping = false
          log(
            childExited
              ? 'Irodori remains open. Development has ended; reloading may be unavailable.'
              : 'Development stop cancelled. Irodori and Vite remain running.',
          )
        } else if (message.outcome === 'closing') {
          if (message.code) childCode = 1
        } else socket.destroy()
      } else socket.destroy()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const notifyLoss = (instance) => {
    if (instance.lossSent || !instance.socket) return
    instance.lossSent = true
    sendDevelopmentMessage(instance.socket, { type: 'development-lost' })
  }
  const stopGroup = (signal) => {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  const check = async () => {
    if (checking || finishing || !child) return
    checking = true
    try {
      for (const [id, instance] of instances)
        if (!(await processExists(instance.pid))) {
          instance.socket?.destroy()
          instances.delete(id)
        }
      if (!childExited && !stopping) return
      if (!seenApplication && !childExited) return // A stop during startup waits for registration.
      if (instances.size || groupApplications(child.pid).length) return
      // Only actual application disappearance permits descendant cleanup. Closing/socket EOF is insufficient.
      finishing = true
      clearInterval(interval)
      stopGroup('SIGTERM')
      if (!childExited) await new Promise((resolve) => child.once('exit', resolve))
      await new Promise((resolve) => setTimeout(resolve, 150))
      stopGroup('SIGKILL')
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
      resolveDone(childCode)
    } catch (error) {
      // An inability to confirm exit must never turn into a kill of a potentially saving editor.
      log(`Development cleanup is waiting: ${error.message}`)
    } finally {
      checking = false
    }
  }
  return {
    env: {
      IRODORI_DEV_SUPERVISOR_PORT: String(server.address().port),
      IRODORI_DEV_SUPERVISOR_TOKEN: token,
    },
    done,
    attach(process) {
      child = process
      child.once('error', (error) => {
        log(`Could not start the Irodori development session: ${error.message}`)
        childExited = true
        childCode = 1
        for (const instance of instances.values()) notifyLoss(instance)
      })
      child.once('exit', (code) => {
        childExited = true
        childCode ||= finishing ? 0 : (code ?? 1)
        for (const instance of instances.values()) notifyLoss(instance)
      })
      interval = setInterval(() => {
        void check()
      }, 100)
    },
    requestStop() {
      if (finishing || stopping) return
      stopping = true
      log('Waiting for Irodori to save or choose a recovery action…')
      for (const instance of instances.values())
        if (instance.socket)
          sendDevelopmentMessage(instance.socket, { type: 'shutdown', reason: 'stop' })
    },
  }
}
