import { spawn, type IPty } from 'node-pty'
import { execFile } from 'node:child_process'
import {
  AGENT_INPUT_LIMIT,
  AGENT_OUTPUT_LIMIT,
  agentTerminalSize,
  terminalChunks,
} from '../../shared/agent'

let terminal: IPty | undefined
let outstanding = 0,
  sequence = 0,
  stopping = false
const sent = new Map<number, number>()
const send = (value: unknown) => {
  if (process.connected) process.send?.(value)
}
function killTree(signal: NodeJS.Signals) {
  if (!terminal) return
  if (process.platform === 'win32') {
    execFile(
      'taskkill',
      ['/PID', String(terminal.pid), '/T', '/F'],
      { windowsHide: true },
      () => {},
    )
  } else {
    try {
      process.kill(-terminal.pid, signal)
    } catch {
      try {
        terminal.kill(signal)
      } catch {
        /* Already exited. */
      }
    }
  }
}
function close() {
  if (stopping) return
  stopping = true
  killTree('SIGTERM')
  setTimeout(() => {
    killTree('SIGKILL')
    process.exit(0)
  }, 750)
}
process.once('disconnect', () => {
  killTree('SIGKILL')
  process.exit(0)
})
process.on(
  'message',
  (message: {
    type: string
    executable?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    columns?: number
    rows?: number
    data?: string
    sequence?: number
  }) => {
    try {
      if (message.type === 'start') {
        if (
          terminal ||
          !message.executable ||
          !message.cwd ||
          !message.env ||
          !Array.isArray(message.args)
        )
          throw new Error('Invalid terminal startup.')
        const size = agentTerminalSize(message.columns!, message.rows!)
        terminal = spawn(message.executable, message.args, {
          cwd: message.cwd,
          env: message.env,
          name: 'xterm-256color',
          cols: size.columns,
          rows: size.rows,
        })
        terminal.onData((data) => {
          for (const part of terminalChunks(data, 8192)) {
            const bytes = Buffer.byteLength(part)
            sequence++
            outstanding += bytes
            sent.set(sequence, bytes)
            if (outstanding > AGENT_OUTPUT_LIMIT)
              throw new Error('The terminal output consumer stopped responding.')
            send({ type: 'output', sequence, data: part })
          }
          if (outstanding >= 64 * 1024) terminal?.pause()
        })
        terminal.onExit((event) => {
          killTree('SIGKILL')
          send({ type: 'exit', code: event.exitCode })
          setTimeout(() => process.exit(0), 10)
        })
        send({ type: 'ready', pid: terminal.pid })
      } else if (message.type === 'input') {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > AGENT_INPUT_LIMIT)
          throw new Error('Terminal input is too large.')
        terminal?.write(message.data)
      } else if (message.type === 'resize') {
        const size = agentTerminalSize(message.columns!, message.rows!)
        terminal?.resize(size.columns, size.rows)
      } else if (message.type === 'interrupt') terminal?.write('\x03')
      else if (message.type === 'ack') {
        const bytes = sent.get(message.sequence!)
        if (bytes !== undefined) {
          sent.delete(message.sequence!)
          outstanding -= bytes
        }
        if (outstanding < 32 * 1024) terminal?.resume()
      } else if (message.type === 'close') close()
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      close()
    }
  },
)
process.on('uncaughtException', (error) => {
  send({ type: 'error', message: error.message })
  close()
})
