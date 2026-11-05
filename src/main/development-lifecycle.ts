import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  readDevelopmentMessages,
  sendDevelopmentMessage,
} from '../../scripts/development-protocol.mjs'
import type { ShutdownOutcome, ShutdownReason } from './shutdown'

/** Unpackaged main only. SIGTERM remains owned by electron-vite's automatic restarts. */
export function connectDevelopmentSupervisor(
  request: (reason: ShutdownReason) => Promise<ShutdownOutcome>,
  env = process.env,
) {
  const port = Number(env.IRODORI_DEV_SUPERVISOR_PORT)
  const token = env.IRODORI_DEV_SUPERVISOR_TOKEN
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    return undefined
  const socket = createConnection({ host: '127.0.0.1', port })
  if (env === process.env) {
    delete process.env.IRODORI_DEV_SUPERVISOR_PORT
    delete process.env.IRODORI_DEV_SUPERVISOR_TOKEN
  }
  const instance = randomUUID()
  let ending = false
  let lossSeen = false
  let pending = false
  let deferredLoss = false
  const run = async (reason: ShutdownReason) => {
    if (ending || pending) return
    pending = true
    try {
      const outcome = await request(reason)
      sendDevelopmentMessage(socket, { type: 'outcome', instance, outcome })
    } finally {
      pending = false
      if (deferredLoss && !ending) {
        deferredLoss = false
        void run('development-lost')
      }
    }
  }
  const lost = () => {
    if (ending || lossSeen) return
    lossSeen = true
    if (pending) deferredLoss = true
    else void run('development-lost')
  }
  socket.on('connect', () =>
    sendDevelopmentMessage(socket, {
      type: 'register',
      token,
      instance,
      pid: process.pid,
    }),
  )
  socket.on('error', () => {})
  socket.once('close', lost)
  readDevelopmentMessages(socket, (message) => {
    if (message.type === 'shutdown' && message.reason === 'stop') void run('development-stop')
    else if (message.type === 'development-lost') lost()
    else if (message.type !== 'registered') socket.destroy()
  })
  return {
    closing(code: number) {
      ending = true
      sendDevelopmentMessage(socket, { type: 'outcome', instance, outcome: 'closing', code })
    },
  }
}
