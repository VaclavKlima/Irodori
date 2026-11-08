import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { open, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const [
  runtimeArgument,
  modelArgument,
  outputArgument,
  mode = 'normal',
  probe = 'runtime',
  ...probeArguments
] = process.argv.slice(2)
if (
  !runtimeArgument ||
  !modelArgument ||
  !outputArgument ||
  !['normal', 'cancel', 'refuse'].includes(mode) ||
  !['runtime', 'model', 'corpus'].includes(probe)
)
  throw new Error(
    'Usage: node run-runtime-probe.mjs <isolated-runtime-root> <model.onnx> <output-directory> [normal|cancel|refuse] [runtime|model|corpus] [probe arguments...]',
  )
const runtime = resolve(runtimeArgument),
  model = resolve(modelArgument),
  output = resolve(outputArgument)
await mkdir(output, { recursive: true })
const require = createRequire(import.meta.url)
const nodePackage = `node-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const executable = join(
  dirname(require.resolve(`${nodePackage}/package.json`)),
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
)
const env = { ...process.env, ORT_DISABLE_TELEMETRY: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const log = await open(join(output, 'process.log'), 'w')
const started = performance.now()
const childProbeArguments =
  probe === 'corpus'
    ? probeArguments.map((argument, index) => (index < 2 ? resolve(argument) : argument))
    : probeArguments
const child = spawn(
  executable,
  [
    resolve(
      import.meta.dirname,
      probe === 'runtime'
        ? 'probe-runtime.mjs'
        : probe === 'model'
          ? 'probe-model.mjs'
          : 'probe-corpus.mjs',
    ),
    runtime,
    model,
    output,
    ...childProbeArguments,
  ],
  {
    cwd: output,
    env,
    stdio: ['ignore', log.fd, log.fd, 'ipc'],
    detached: process.platform !== 'win32',
  },
)
let cancellationRequested = false,
  timedOut = false,
  lastPhase = null
const stop = () => {
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
const timeout = setTimeout(() => {
  timedOut = true
  stop()
}, 60000)
child.on('message', (message) => {
  lastPhase = message
  if (mode === 'cancel' && message?.phase === 'session-ready') {
    cancellationRequested = true
    stop()
  }
})
const outcome = await new Promise((accept, reject) => {
  child.once('error', reject)
  child.once('close', (exitCode, signal) => accept({ exitCode, signal }))
}).finally(async () => {
  clearTimeout(timeout)
  await log.close()
})
let alive = false
try {
  process.kill(child.pid, 0)
  alive = true
} catch (error) {
  if (error.code !== 'ESRCH') throw error
}
const resultFile =
  probe === 'runtime'
    ? 'runtime-result.json'
    : probe === 'model'
      ? 'model-result.json'
      : 'corpus-result.json'
const resultExists = await access(join(output, resultFile)).then(
  () => true,
  () => false,
)
const result = resultExists
  ? JSON.parse(await readFile(join(output, resultFile), 'utf8'))
  : undefined
const success =
  !timedOut &&
  !alive &&
  (mode === 'cancel'
    ? cancellationRequested && outcome.signal === 'SIGKILL' && !resultExists
    : mode === 'refuse'
      ? outcome.exitCode === 1 &&
        !outcome.signal &&
        result?.status === 'failed' &&
        /CPU EP.*fallback.*disabled|fallback to CPU EP has been explicitly disabled/i.test(
          result.error ?? '',
        )
      : outcome.exitCode === 0 && !outcome.signal && result?.status === 'passed')
const packageLock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8'))
const installed = packageLock.packages['node_modules/onnxruntime-node']
const binaryRoot = join(
  runtime,
  'node_modules/onnxruntime-node/bin/napi-v6',
  process.platform,
  process.arch,
)
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const evidence = {
  status: success ? 'passed' : 'failed',
  mode,
  probe,
  elapsedMs: performance.now() - started,
  process: {
    executable,
    pid: child.pid,
    ...outcome,
    cancellationRequested,
    lastPhase,
    timedOut,
    aliveAfterClose: alive,
    resultPublished: resultExists,
  },
  runtimePackage: {
    version: installed.version,
    integrity: installed.integrity,
    resolved: installed.resolved,
  },
  binary: {
    name: 'onnxruntime_binding.node',
    sha256: await hash(join(binaryRoot, 'onnxruntime_binding.node')),
  },
  scope:
    mode === 'cancel'
      ? `Owned ${probe} worker cancellation at the recorded phase; no GPU-memory-drain or production cancellation acceptance.`
      : probe === 'runtime'
        ? 'Native WebGPU synthetic runtime feasibility, no segmentation or cross-platform acceptance.'
        : `Native WebGPU ${probe} feasibility and numeric reference comparison; no production or cross-platform acceptance.`,
}
await writeFile(join(output, 'worker-evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
if (mode === 'refuse')
  await writeFile(
    join(output, 'summary.md'),
    `# Native WebGPU unsupported-operator refusal: ${evidence.status.toUpperCase()}\n\nStrict synthetic session refused before inference: ${result?.error?.split('\n')[0]}. No CPU retry. Original child failure is retained in runtime-result.json. Process alive after close: ${alive}.\n`,
  )
if (mode === 'cancel')
  await writeFile(
    join(output, 'summary.md'),
    `# Native WebGPU worker cancellation: ${evidence.status.toUpperCase()}\n\nBundled Node worker ${child.pid}; cancellation requested after ${lastPhase?.component ?? lastPhase?.phase ?? 'unknown phase'}. Exit signal ${outcome.signal}, process alive after close ${alive}, result published ${resultExists}. Duration ${evidence.elapsedMs.toFixed(2)} ms.\n\nNo CPU retry. This checks process ownership at the recorded phase; GPU peak memory and production interaction cancellation are not qualified.\n`,
  )
process.stdout.write(
  JSON.stringify({
    status: evidence.status,
    mode,
    evidence: join(output, 'worker-evidence.json'),
  }) + '\n',
)
if (!success) process.exitCode = 1
