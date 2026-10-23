// Synthetic lifecycle/framing fixture only. Mask bits are a literal pattern;
// this process is never evidence of numerical quality or processing performance.
import { access, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [configPath, mode, requestPath, threadText] = process.argv.slice(2)
const config = JSON.parse(await readFile(configPath, 'utf8')),
  request = await readFile(requestPath),
  threads = Number(threadText)
if (
  mode !== '--mask-v1' ||
  request.length !== 416 ||
  request.subarray(0, 8).toString() !== 'MASKCPU1'
)
  throw new Error('Invalid synthetic mask fixture invocation.')
let prior = ''
try {
  prior = await readFile(join(config.directory, 'events.jsonl'), 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
// The controller permits one real child at a time. Count actual child starts,
// rather than deriving a request generation from an opaque identity digest.
const ordinal =
  prior
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === 'mask-started').length + 1
const fault = config.maskFaults[ordinal],
  marker = (name) => join(config.directory, `${name}-${ordinal}`)
const audit = (name, extra = {}) =>
  appendFile(
    join(config.directory, 'events.jsonl'),
    `${JSON.stringify({ event: `mask-${name}`, generation: ordinal, pid: process.pid, ...extra })}\n`,
  )
let terminating = false
function gate(name, stopOnTermination = true) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (stopOnTermination && terminating) {
        clearInterval(timer)
        reject(new Error('Terminated fixture.'))
        return
      }
      void access(marker(name)).then(
        () => {
          clearInterval(timer)
          resolve()
        },
        () => undefined,
      )
    }, 5)
  })
}
process.stdout.on('error', () => undefined)
process.stdin.on('error', () => undefined)
process.on('SIGTERM', () => {
  if (terminating) return
  terminating = true
  void (async () => {
    await audit('sigterm')
    await gate('allow-exit', false)
    await audit('exiting', { code: 73 })
    process.exit(73)
  })().catch(() => process.exit(74))
})
const write = (bytes) =>
  new Promise((resolve, reject) =>
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
  )
try {
  await audit('started')
  let inputBytes = 0
  for await (const bytes of process.stdin) inputBytes += bytes.length
  if (inputBytes !== Number(request.readBigUInt64LE(32)))
    throw new Error('Synthetic mask input length mismatch.')
  await audit('input-ended')
  if (config.maskHoldOutput.includes(ordinal)) {
    await audit('held-before-output')
    await gate('allow-output')
  }
  if (terminating) throw new Error('Terminated fixture.')
  const header = Buffer.alloc(432)
  header.write('MASKOUT1')
  header.writeUInt32LE(416, 8)
  request.copy(header, 12)
  header.writeUInt32LE(threads, 428)
  if (fault === 'echo') header[84] ^= 1
  await write(header)
  const width = request.readUInt32LE(16),
    height = request.readUInt32LE(20)
  let strips = 0
  for (let row = 0; row < height; row += 64) {
    const rows = Math.min(64, height - row),
      bytes = Buffer.alloc(width * rows),
      record = Buffer.alloc(16)
    record.write('STRP')
    record.writeUInt32LE(row, 4)
    record.writeUInt32LE(rows, 8)
    record.writeUInt32LE(bytes.length, 12)
    if (fault === 'order' && row === 0) record.writeUInt32LE(1, 4)
    for (let index = 0; index < bytes.length; index++) bytes[index] = (row * width + index) % 16
    if (fault === 'bits' && row === 0) bytes[0] = 16
    await write(record)
    await write(bytes)
    strips++
  }
  const terminal = Buffer.alloc(72)
  terminal.write('MASKDONE')
  terminal.writeBigUInt64LE(BigInt(width * height), 8)
  terminal.writeUInt32LE(strips, 16)
  terminal.writeBigUInt64LE(4096n, 56)
  terminal.writeBigUInt64LE(BigInt((threads - 1) * 512 * 1024), 64)
  await write(terminal)
  if (fault === 'excess') await write(Buffer.from([1]))
  await new Promise((resolve) => process.stdout.end(resolve))
  await audit('output-ended')
  if (config.maskHoldExit.includes(ordinal)) {
    await audit('held-after-output')
    await gate('allow-exit')
  }
  if (terminating) throw new Error('Terminated fixture.')
  const code = fault === 'nonzero' ? 42 : 0
  await audit('exiting', { code })
  process.exit(code)
} catch (error) {
  if (!terminating) {
    await audit('failed', { error: String(error) })
    process.stderr.write(String(error))
    process.exit(75)
  }
}
