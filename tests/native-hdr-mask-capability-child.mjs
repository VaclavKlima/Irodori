// Synthetic capability/lifecycle fixture only. Receipt hashes do not describe a
// compiled image engine and this process is never numerical/performance evidence.
import { closeSync, writeSync } from 'node:fs'
import { access, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [configPath, argument, extra] = process.argv.slice(2),
  config = JSON.parse(await readFile(configPath, 'utf8'))
if (argument !== '--capabilities' || extra !== undefined)
  throw new Error('Invalid capability fixture invocation.')
const audit = (event) =>
  appendFile(
    join(config.directory, 'events.jsonl'),
    `${JSON.stringify({ event, pid: process.pid })}\n`,
  )
process.on('SIGTERM', () => {
  void audit('sigterm')
})
// A real process remains alive independently of its stdout/stderr descriptor
// lifetimes. Output-bound cancellation must escalate through actual close.
const alive = setInterval(() => undefined, 1000)
await audit('started')
const payload = Buffer.from(config.payload, 'base64')
for (let offset = 0; offset < payload.length;)
  offset += writeSync(1, payload, offset, payload.length - offset)
if (config.mode === 'oversized-ignore-term') {
  await audit('output-written')
} else {
  // Explicit OS descriptor closure makes this a genuine pipe-EOF-before-child-
  // close control. No Node stdout/stderr stream is initialized or reused.
  closeSync(1)
  closeSync(2)
  await audit('eof-complete')
  if (config.mode === 'held-after-eof') {
    const poll = setInterval(() => {
      void access(join(config.directory, 'allow-exit')).then(
        async () => {
          clearInterval(poll)
          clearInterval(alive)
          await audit('exiting')
          process.exit(0)
        },
        () => undefined,
      )
    }, 5)
  } else {
    clearInterval(alive)
    await audit('exiting')
    process.exit(0)
  }
}
