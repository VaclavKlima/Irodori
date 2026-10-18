import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '../..'),
  fixtureRoot = join(root, 'tests/fixtures/research-sony'),
  manifestBytes = await readFile(join(fixtureRoot, 'manifest.json')),
  manifest = JSON.parse(manifestBytes.toString('utf8')),
  manifestHash = createHash('sha256').update(manifestBytes).digest('hex'),
  [mode = 'check', separator, ...command] = process.argv.slice(2)
if (
  !['check', 'noise', 'hdr'].includes(mode) ||
  (separator !== undefined && (separator !== '--' || command.length === 0)) ||
  (mode === 'check' && separator !== undefined)
)
  throw new Error(
    'Usage: node scripts/research/sony-fixtures.mjs check|noise|hdr [-- command args]',
  )

const pathsFor = (sequenceId) => {
  const sequence = manifest.sequences.find((sequence) => sequence.id === sequenceId)
  if (!sequence) throw new Error(`Missing fixture sequence: ${sequenceId}`)
  return sequence.files.map((name) => {
    const entry = manifest.files.find((file) => file.name === name)
    if (!entry) throw new Error(`Missing fixture manifest entry: ${name}`)
    return resolve(fixtureRoot, entry.path)
  })
}

async function checkFiles() {
  const files = []
  for (const entry of manifest.files) {
    const path = resolve(fixtureRoot, entry.path)
    if (!path.startsWith(`${fixtureRoot}${sep}`)) throw new Error('Invalid fixture manifest path.')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    const sha256 = hash.digest('hex'),
      bytes = (await stat(path)).size
    if (sha256 !== entry.sha256 || bytes !== entry.bytes)
      throw new Error(`Fixture changed or incomplete: ${entry.name}`)
    files.push({ name: entry.name, sha256, bytes })
  }
  return { checkedAt: new Date().toISOString(), files }
}

const record = {
  startedAt: new Date().toISOString(),
  manifestHash,
  mode,
  command,
  cwd: root,
  node: process.version,
  before: null,
  after: null,
  exitCode: 0,
  signal: null,
  error: null,
}
try {
  record.before = await checkFiles()
  console.log(
    `Verified ${record.before.files.length} Sony originals; manifest SHA-256 ${manifestHash}.`,
  )
  if (command.length) {
    const brackets = pathsFor('hdr-brk'),
      sequence = pathsFor(mode === 'hdr' ? 'hdr-brk' : 'noise-burst'),
      child = spawn(command[0], command.slice(1), {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          LUMA_MERGE_BRACKETS: JSON.stringify(brackets),
          LUMA_MERGE_SONY_SEQUENCE: JSON.stringify(sequence),
          LUMA_MERGE_SONY_MODE: mode,
        },
      }),
      interrupt = () => child.kill('SIGINT'),
      terminate = () => child.kill('SIGTERM')
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          record.signal = signal
          record.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
          resolve()
        })
      })
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
  }
} catch (error) {
  record.error = String(error)
  record.exitCode = 1
  console.error(record.error)
} finally {
  try {
    record.after = await checkFiles()
    console.log(`Verified ${record.after.files.length} Sony originals after the command.`)
  } catch (error) {
    record.error = [record.error, String(error)].filter(Boolean).join('\n')
    record.exitCode = 1
    console.error(String(error))
  }
  // Preserve the verification runner's artifact-free selection preview.
  if (!command.includes('--plan')) {
    const directory = join(root, 'artifacts/fixture-integrity')
    await mkdir(directory, { recursive: true })
    const evidence = join(directory, `${record.startedAt.replaceAll(':', '-')}-${process.pid}.json`)
    await writeFile(evidence, `${JSON.stringify(record, null, 2)}\n`)
    console.log(`Fixture integrity evidence: ${evidence}`)
  }
  process.exitCode = record.exitCode
}
