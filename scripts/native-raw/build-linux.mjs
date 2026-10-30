// Build only from an explicit pinned archive. No decoder, test or benchmark is run.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [archiveArg, noStage, ...extra] = process.argv.slice(2)
if (
  !archiveArg ||
  extra.length ||
  (noStage !== undefined && noStage !== '--no-stage') ||
  process.platform !== 'linux' ||
  process.arch !== 'x64'
)
  throw new Error(
    'Usage on Linux x64: node scripts/native-raw/build-linux.mjs PINNED_LIBRAW_ARCHIVE [--no-stage]',
  )
const archive = resolve(archiveArg)
const started = performance.now()
const archiveSha256 = 'a789dc4e2409e2901d93793a4e0b80c7b49d0d97cf6ad71c850eb7616acfd786'
const pinned = {
  'bridge.cpp': 'de11acca7a065ba1c8a3fba228c57b70ba01772176c0e55f09e2e6f4c95e4f6f',
  'rows-abi.h': '91b4dbc0765451ea532a201b3be90b40a8ab9411af720a1e5c4078f67633e559',
  'src/rows.rs': '9597328a7638cf5e01ae14f2cf053db19f8863904d85c6802d7d4dc945f3a89a',
  'src/parent_guard.rs': '5fe394a55f7bf54a396c83c8cdeb69d34da2e55854d476d984c61bcf3fb769fb',
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bounded = (path, maximum) => {
  const info = lstatSync(path)
  if (!info.isFile() || info.size < 1 || info.size > maximum)
    throw new Error(`Invalid bounded build input: ${path}`)
  return readFileSync(path)
}
const hash = (path, maximum = 16 * 1024 ** 2) => digest(bounded(path, maximum))
if (hash(archive, 64 * 1024 ** 2) !== archiveSha256)
  throw new Error('Pinned LibRaw archive mismatch.')
const sourceNames = [
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  'README.md',
  'bridge.cpp',
  'rows-abi.h',
  'src/main.rs',
  'src/parent_guard.rs',
  'src/rows.rs',
  'licenses/COPYRIGHT',
  'licenses/LICENSE.CDDL',
  'licenses/LICENSE.LGPL',
]
const host = join(root, 'native/raw-source')
for (const [name, expected] of Object.entries(pinned))
  if (hash(join(host, name)) !== expected)
    throw new Error(`Pinned native RAW source changed: ${name}`)
const buildRoot = join(root, 'artifacts/native-raw-source-build')
mkdirSync(buildRoot, { recursive: true })
const working = mkdtempSync(join(buildRoot, 'build-'))
const snapshot = join(working, 'host-source'),
  source = join(working, 'LibRaw-0.22.1')
mkdirSync(snapshot)
const sources = { 'scripts/native-raw/build-linux.mjs': hash(fileURLToPath(import.meta.url)) }
for (const name of sourceNames) {
  const bytes = bounded(join(host, name), 16 * 1024 ** 2)
  const path = join(snapshot, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes, { flag: 'wx' })
  sources[`native/raw-source/${name}`] = digest(bytes)
}
const compiler = process.env.CXX ?? 'c++',
  archiver = process.env.AR ?? 'ar'
const cargo = process.env.CARGO ?? 'cargo',
  rustc = process.env.RUSTC ?? 'rustc'
const buildEnv = {
  ...process.env,
  CXX: compiler,
  AR: archiver,
  RUSTC: rustc,
  RUSTFLAGS: '',
  CARGO_ENCODED_RUSTFLAGS: '',
  IRODORI_RAW_SOURCE: source,
}
const report = {
  implementation: 'irodori-owned-sony-arw2-rows-v1',
  status: 'building',
  applicationAcceptance: false,
  streamContract: 'irodori-parallel-sony-arw2-rows-v1',
  entry: '--owned-rows-v1',
  maximumTotalThreads: 8,
  descriptorLayout: {
    stdin: 'exact-start-token-and-EOF',
    stdout: 'sensor-stream',
    stderr: 'diagnostics',
    source: 3,
    readiness: 4,
  },
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  cpu: cpus()[0]?.model,
  node: process.version,
  startedAt: new Date().toISOString(),
  sources,
  pinnedSources: pinned,
  sourceArchive: { path: archive, sha256: archiveSha256, version: '0.22.1' },
  hostSourceSnapshot: snapshot,
  versions: {},
  steps: [],
}
const manifest = join(working, 'build-manifest.json')
const save = () => writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n')
const run = (command, args) => {
  const index = report.steps.length
  const step = {
    command,
    args,
    cwd: working,
    status: 'running',
    startedAt: new Date().toISOString(),
    stdoutLog: `step-${index}.stdout.log`,
    stderrLog: `step-${index}.stderr.log`,
  }
  report.steps.push(step)
  save()
  const at = performance.now()
  const result = spawnSync(command, args, {
    cwd: working,
    env: buildEnv,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 ** 2,
  })
  writeFileSync(join(working, step.stdoutLog), result.stdout ?? '')
  writeFileSync(join(working, step.stderrLog), result.stderr ?? '')
  Object.assign(step, {
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    elapsedMs: performance.now() - at,
    error: result.error ? String(result.error) : undefined,
  })
  save()
  if (step.status !== 'passed')
    throw new Error(`Build step failed: ${command}; see ${step.stderrLog}`)
  return result.stdout.trim()
}
try {
  save()
  report.versions = {
    compiler: run(compiler, ['--version']),
    archiver: run(archiver, ['--version']),
    cargo: run(cargo, ['--version', '--verbose']),
    rustc: run(rustc, ['--version', '--verbose']),
    make: run('make', ['--version']),
    tar: run('tar', ['--version']),
  }
  save()
  run('tar', ['-xzf', archive, '-C', working])
  const decoder = join(source, 'src/decoders/decoders_dcraw.cpp')
  const originalDecoderSha256 = 'e17e3faac2e9d5de0d1c3155b5fe37165010a09eab9a80f63523a391237d1658'
  const patchedDecoderSha256 = '9513732388a2010d842ff5893cfe8067c440089734a4487ddfe578c1760bf302'
  const pinnedHeaders = {
    'libraw/libraw.h': '48b3048304f42266ddb5bb5068f69427c249d574f80d8423387906d44bcae27d',
    'libraw/libraw_internal.h': '50a814b8f5d8308d57d31aa616f239215042f3d4befea50c9a8af983f4bf9c27',
  }
  if (hash(decoder) !== originalDecoderSha256) throw new Error('Pinned Sony decoder mismatch.')
  for (const [name, expected] of Object.entries(pinnedHeaders))
    if (hash(join(source, name)) !== expected)
      throw new Error(`Pinned LibRaw header mismatch: ${name}`)
  const before = readFileSync(decoder, 'utf8'),
    needle = 'void LibRaw::sony_arw2_load_raw()\n{\n'
  if (before.split(needle).length !== 2) throw new Error('Sony row dispatch seam is ambiguous.')
  const replacement =
    'extern "C" int irodori_parallel_sony_arw2(void*);\n' +
    needle +
    '  const int irodori_rows = irodori_parallel_sony_arw2(this);\n' +
    '  if (irodori_rows > 0) return;\n' +
    '  if (irodori_rows < 0) throw LIBRAW_EXCEPTION_IO_CORRUPT;\n'
  writeFileSync(join(working, 'decoders_dcraw.original.cpp'), before, { flag: 'wx' })
  writeFileSync(decoder, before.replace(needle, replacement))
  if (hash(decoder) !== patchedDecoderSha256)
    throw new Error('Pinned Sony dispatch patch mismatch.')
  report.patch = {
    originalDecoderSha256,
    patchedDecoderSha256,
    pinnedHeaders,
    scope: 'Sony function entry only; upstream fallback body unchanged',
  }
  save()
  run('make', [
    '-C',
    source,
    '-f',
    'Makefile.dist',
    '-j',
    '4',
    'lib/libraw.a',
    `CXX=${compiler}`,
    'CFLAGS=-O3 -fPIC -ffp-contract=off -fno-fast-math -I.',
  ])
  run(cargo, [
    'build',
    '--release',
    '--locked',
    '--offline',
    '--manifest-path',
    join(snapshot, 'Cargo.toml'),
    '--target-dir',
    join(working, 'cargo'),
  ])
  const binary = join(working, 'irodori-raw')
  copyFileSync(join(working, 'cargo/release/irodori-raw'), binary)
  chmodSync(binary, 0o755)
  Object.assign(report, {
    status: 'built-unverified',
    binary,
    binarySha256: hash(binary, 128 * 1024 ** 2),
    staticLibrarySha256: hash(join(source, 'lib/libraw.a'), 256 * 1024 ** 2),
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
  })
  save()
  if (!noStage) {
    const destination = join(root, 'vendor/native-raw/linux-x64')
    mkdirSync(join(destination, 'licenses'), { recursive: true })
    for (const name of ['COPYRIGHT', 'LICENSE.CDDL', 'LICENSE.LGPL'])
      copyFileSync(join(snapshot, 'licenses', name), join(destination, 'licenses', name))
    writeFileSync(
      join(destination, 'licenses/NOTICE.txt'),
      [
        'Irodori main-owned native RAW sensor source',
        'LibRaw 0.22.1; upstream LGPL/CDDL notices are included unchanged.',
        'Source: https://github.com/LibRaw/LibRaw/tree/0.22.1',
        'Irodori adds the pinned Sony dispatch hook, bounded Rust row kernel and owned FD/start entry.',
        `Corresponding original/modified LibRaw and host source: ${working}`,
        'No test, pixel/lifecycle acceptance or application performance is implied by staging.',
        '',
      ].join('\n'),
    )
    const temporary = join(destination, `irodori-raw-${process.pid}.tmp`)
    copyFileSync(binary, temporary, constants.COPYFILE_EXCL)
    chmodSync(temporary, 0o755)
    renameSync(temporary, join(destination, 'irodori-raw'))
    writeFileSync(join(destination, 'SHA256SUMS'), `${report.binarySha256}  irodori-raw\n`)
    report.staged = destination
  }
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  process.exitCode = 1
} finally {
  report.elapsedMs = performance.now() - started
  save()
  if (report.status === 'built-unverified' && report.staged) {
    try {
      copyFileSync(manifest, join(report.staged, 'build-manifest.json'))
    } catch (error) {
      report.status = 'failed'
      report.error = String(error)
      process.exitCode = 1
      save()
    }
  }
  console.log(
    JSON.stringify({
      status: report.status,
      manifest,
      binary: report.binary,
      binarySha256: report.binarySha256,
      staged: report.staged,
      applicationAcceptance: false,
    }),
  )
}
