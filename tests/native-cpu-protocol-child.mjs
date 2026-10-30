// SYNTHETIC PROTOCOL FIXTURE ONLY. Its RGBA bytes are a known test pattern,
// not ACES math, a photograph, or application performance evidence.
import { access, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [configPath, requestPath, inputMode, threadText] = process.argv.slice(2)
const config = JSON.parse(await readFile(configPath, 'utf8'))
const request = await readFile(requestPath)
if (request.length !== 832 || request.subarray(0, 8).toString() !== 'IRODCPU3' || inputMode !== '-')
  throw new Error('Invalid synthetic protocol-fixture invocation.')
const generation = Number(request.readBigUInt64LE(32)),
  threads = Number(threadText),
  phase = requestPath.endsWith('before-request.bin') ? 'before' : 'after'
let terminating = false
const audit = (event, extra = {}) =>
  appendFile(
    join(config.directory, 'events.jsonl'),
    `${JSON.stringify({ event, generation, pid: process.pid, phase, ...extra })}\n`,
  )
const marker = (name) => join(config.directory, `${name}-${generation}`)
function gate(name, stopOnTermination = true) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (stopOnTermination && terminating) {
        clearInterval(timer)
        reject(new Error('Synthetic child was terminated.'))
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
  // Keep a REAL process alive after TERM. The test releases it explicitly and
  // observes that the controller has not released its source before child close.
  void (async () => {
    await audit('sigterm')
    await gate('allow-exit', false)
    await audit('exiting', { code: 73 })
    process.exit(73)
  })().catch(() => process.exit(74))
})
const write = (bytes) =>
  new Promise((resolve, reject) => {
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
  })

try {
  await audit('started')
  let inputBytes = 0
  for await (const bytes of process.stdin) inputBytes += bytes.length
  if (inputBytes !== Number(request.readBigUInt64LE(120)))
    throw new Error('Synthetic input length mismatch.')
  await audit('input-ended')
  if (
    config.holdGenerations.includes(generation) ||
    (phase === 'before' && config.holdBeforeGenerations?.includes(generation))
  ) {
    await audit('held-before-output')
    await gate('allow-output')
  }
  if (terminating) throw new Error('Synthetic child was terminated.')
  const header = Buffer.alloc(848)
  header.write('IRODRGB1')
  header.writeUInt32LE(832, 8)
  request.copy(header, 12)
  header.writeUInt32LE(threads, 844)
  await write(header)
  const width = request.readUInt32LE(24),
    height = request.readUInt32LE(28)
  let strips = 0
  for (let row = 0; row < height; row += 64) {
    const count = Math.min(64, height - row),
      planeBytes = width * count * 4
    const record = Buffer.alloc(24),
      after = Buffer.alloc(planeBytes),
      before = Buffer.alloc(planeBytes)
    record.write('IRODROW1')
    record.writeUInt32LE(row, 8)
    record.writeUInt32LE(count, 12)
    record.writeUInt32LE(planeBytes, 16)
    for (let pixel = 0; pixel < planeBytes / 4; pixel++) {
      const y = row + Math.floor(pixel / width),
        x = pixel % width,
        at = pixel * 4
      after.set([x % 251, y % 251, generation % 251, 255], at)
      before.set([generation % 251, x % 251, y % 251, 255], at)
    }
    await write(record)
    await write(after)
    await write(before)
    strips++
  }
  const metrics = Buffer.from(
    JSON.stringify({
      implementation: 'float64-ctl-cpu-strip-v1',
      threads,
      renderedStrips: strips,
      sourceHashVerifiedByChild: false,
      preparationMs: 0,
      readMs: 0,
      renderMs: 0,
      outputMs: 0,
      elapsedMs: 0,
      plannedStripAndWorkerBytes: 0,
    }),
  )
  const trailer = Buffer.alloc(12)
  trailer.write('IRODEND1')
  trailer.writeUInt32LE(metrics.length, 8)
  await write(trailer)
  await write(metrics)
  await new Promise((resolve) => process.stdout.end(resolve))
  await audit('output-ended')
  const code = config.nonzeroGenerations.includes(generation) ? 42 : 0
  await audit('exiting', { code })
  process.exit(code)
} catch (error) {
  if (!terminating) {
    await audit('failed', { error: String(error) })
    process.stderr.write(String(error))
    process.exit(75)
  }
  // The TERM owner above retains the process until its explicit release marker.
}
