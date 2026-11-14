// Offline research only. The runner owns its child and never opens a managed library.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { mkdir, open } from 'node:fs/promises'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1]) throw new Error(`Missing ${name}.`)
  return args[index + 1]
}
const stage = option('--stage', 'baseline')
if (!['baseline', 'guided'].includes(stage)) throw new Error('Choose baseline or guided.')
const root = resolve(option('--root', '.'))
const studyArgument = option('--study', null)
if (!studyArgument) throw new Error('Provide an explicit --study artifact directory.')
const study = resolve(studyArgument)
const output = join(study, stage)
await mkdir(output, { recursive: true })
const helper = join(output, 'guided-worker.mjs')
await build({
  entryPoints: [join(root, 'scripts/research/refine-edge/guided-worker.mjs')],
  outfile: helper,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
if (stage === 'baseline') {
  await build({
    entryPoints: [join(root, 'src/main/object-selection/worker.ts')],
    outfile: join(output, 'object-selection-worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  })
}
const require = createRequire(import.meta.url)
const platform = process.platform === 'win32' ? 'win' : process.platform
const executable = join(
  dirname(require.resolve(`node-${platform}-${process.arch}/package.json`)),
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
)
const invocationId = `run-${Date.now()}`
const log = await open(join(output, `${invocationId}.log`), 'wx')
const env = { ...process.env, ORT_DISABLE_TELEMETRY: '1' }
delete env.NODE_OPTIONS
delete env.ELECTRON_RUN_AS_NODE
const selection = option('--ids', null)
const forwarded = [
  '--invocation-id',
  invocationId,
  ...(selection ? ['--ids', selection] : []),
  ...['--prepared', '--baseline-manifest', '--freeze-receipt'].flatMap((name) => {
    const value = option(name, null)
    return value ? [name, resolve(value)] : []
  }),
  ...(args.includes('--allow-confirmation') ? ['--allow-confirmation'] : []),
]
const child = spawn(
  executable,
  [helper, '--stage', stage, '--root', root, '--study', study, ...forwarded],
  {
    cwd: root,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
const stop = () => {
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
child.stdout.on('data', (data) => {
  void log.write(data)
  process.stdout.write(data)
})
child.stderr.on('data', (data) => {
  void log.write(data)
})
const result = await new Promise((accept, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => accept({ code, signal }))
}).finally(async () => {
  await log.close()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
})
if (result.code !== 0)
  throw new Error(`${stage} research child failed: ${JSON.stringify(result)}; inspect ${output}.`)
