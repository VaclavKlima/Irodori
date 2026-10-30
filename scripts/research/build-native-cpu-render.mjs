// Source-only entry point for the isolated CPU renderer research build.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { arch, cpus, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
if (process.argv.length !== 2 || platform() !== 'linux' || arch() !== 'x64')
  throw new Error('Usage on Linux x64: node scripts/research/build-native-cpu-render.mjs')
const directory = join(root, 'artifacts/native-cpu-render-build')
mkdirSync(directory, { recursive: true })
const working = mkdtempSync(join(directory, 'build-'))
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const maskReference = {
  electron: '44.3.0',
  v8: '15.2.124.19-electron.0',
  chromium: '152.0.7977.78',
  llvmLibcRevision: '3ea89f4304312567e31a8eb45e0737577e65b676',
}
const matchesReference = (value) =>
  value &&
  Object.keys(value).length === 4 &&
  Object.entries(maskReference).every(([key, expected]) => value[key] === expected)
const maskCompilerFlags = ['-mno-fma', '-mno-avx', '-mno-sse4.2']
const maskUpstream = 'native/irodori-cpu-render/upstream/electron-llvm'
const sourceInventory = JSON.parse(readFileSync(join(root, maskUpstream, 'sources.json'), 'utf8'))
if (
  sourceInventory.version !== 'electron-mask-llvm-sources-v1' ||
  !matchesReference(sourceInventory.reference) ||
  !Array.isArray(sourceInventory.files) ||
  !sourceInventory.files.length ||
  sourceInventory.files.length > 256 ||
  sourceInventory.files.some(
    ({ path }) =>
      typeof path !== 'string' ||
      path.length > 256 ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..'),
  ) ||
  new Set(sourceInventory.files.map(({ path }) => path)).size !== sourceInventory.files.length
)
  throw new Error('Expected the exact bounded Electron LLVM source inventory.')
const sources = [
  'native/irodori-cpu-render/Cargo.toml',
  'native/irodori-cpu-render/Cargo.lock',
  'native/irodori-cpu-render/build.rs',
  'native/irodori-cpu-render/generate_math.py',
  'native/irodori-cpu-render/bridge.h',
  'native/irodori-cpu-render/bridge.cpp',
  'native/irodori-cpu-render/creative-color.h',
  'native/irodori-cpu-render/creative-color-params.h',
  'native/irodori-cpu-render/src/creative.rs',
  'native/irodori-cpu-render/src/main.rs',
  'native/irodori-cpu-render/src/mask.rs',
  'native/irodori-cpu-render/prepare-mask.py',
  'native/irodori-cpu-render/mask-bridge.cpp',
  'native/irodori-cpu-render/electron-atan2.h',
  'native/irodori-cpu-render/MASK-MATH.md',
  `${maskUpstream}/sources.json`,
  ...sourceInventory.files.map(({ path }) => `${maskUpstream}/${path}`),
  'native/irodori-cpu-render/README.md',
  'scripts/research/build-native-cpu-render.mjs',
  'scripts/native-cpu-render/build-linux.mjs',
  'third_party/aces-core/LICENSE',
  'scripts/research/compare-native-cpu-render.ts',
  'src/shared/hdr.ts',
  'src/shared/display-rendering.ts',
  'src/shared/aces-core.ts',
  'src/shared/hdr-display.ts',
  'src/shared/adjustments.ts',
  'src/shared/color-model.ts',
  'src/shared/color-intensity.ts',
  'src/shared/color-mixer.ts',
  'src/shared/color-grading.ts',
  'src/shared/creative-color.ts',
  'src/shared/creative-color-lab.ts',
  'src/shared/native-color-protocol.ts',
  'src/shared/white-balance.ts',
  'src/renderer/src/preview/hdr-ranges.ts',
  'src/renderer/src/preview/hdr-presentation-worker.ts',
  'tests/fixtures/aces-reference.json',
  ...['Utilities', 'Tonescale', 'OutputTransform', 'ColorSpaces'].map(
    (name) => `third_party/aces-core/lib/Lib.Academy.${name}.ctl`,
  ),
]
const manifest = {
  implementation: 'float64-ctl-cpu-strip-v1',
  status: 'building',
  productionIntegration: false,
  root,
  platform: platform(),
  arch: arch(),
  osRelease: release(),
  cpu: cpus()[0]?.model,
  acesRevision: '069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80',
  sources: Object.fromEntries(sources.map((name) => [name, digest(join(root, name))])),
  compilerFlags: ['-std=c++17', '-O3', '-fPIC', '-ffp-contract=off', '-fno-fast-math'],
  maskCompilerFlags,
  steps: [],
}
const save = () =>
  writeFileSync(join(working, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
save()
function run(command, args) {
  const started = performance.now()
  try {
    const stdout = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 ** 2,
    })
    manifest.steps.push({ command, args, elapsedMs: performance.now() - started, stdout })
    save()
    return stdout
  } catch (error) {
    manifest.steps.push({
      command,
      args,
      elapsedMs: performance.now() - started,
      error: String(error),
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    })
    manifest.status = 'failed'
    save()
    throw error
  }
}
const cargo = process.env.IRODORI_CPU_RENDER_CARGO ?? 'cargo'
manifest.toolchain = {
  cargo: run(cargo, ['--version']),
  rustc: run(process.env.IRODORI_CPU_RENDER_RUSTC ?? 'rustc', ['--version']),
  cxx: run(process.env.CXX ?? 'c++', ['--version']),
  python: run(process.env.PYTHON ?? 'python3', ['--version']),
}
run(cargo, [
  'build',
  '--locked',
  '--offline',
  '--release',
  '--manifest-path',
  'native/irodori-cpu-render/Cargo.toml',
  '--target-dir',
  join(working, 'target'),
])
const executable = join(working, 'irodori-cpu-render')
copyFileSync(join(working, 'target/release/irodori-cpu-render'), executable)
chmodSync(executable, 0o755)
manifest.executable = { path: executable, sha256: digest(executable) }
const buildDirectories = readdirSync(join(working, 'target/release/build'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('irodori-cpu-render-'))
  .map((entry) => join(working, 'target/release/build', entry.name, 'out'))
  .filter((path) => existsSync(join(path, 'capabilities.json')))
if (buildDirectories.length !== 1)
  throw new Error('Expected exactly one fresh native CPU capability build output.')
const generated = buildDirectories[0]
for (const name of [
  'capabilities.json',
  'mask-arithmetic.json',
  'aces_math.inc',
  'mask_aces_math.inc',
  'mask-context.inc',
])
  copyFileSync(join(generated, name), join(working, name))
const capabilities = JSON.parse(readFileSync(join(working, 'capabilities.json'), 'utf8'))
const arithmetic = capabilities.mask?.arithmetic
if (
  capabilities.version !== 'native-cpu-capabilities-v1' ||
  capabilities.presentation !== 'IRODCPU3' ||
  capabilities.mask?.request !== 'MASKCPU3' ||
  capabilities.mask.output !== 'MASKOUT1' ||
  capabilities.mask.terminal !== 'MASKDONE' ||
  capabilities.mask.mode !== '--mask-v1' ||
  !/^[a-f0-9]{64}$/.test(capabilities.mask.arithmeticSha256) ||
  digest(join(working, 'mask-arithmetic.json')) !== capabilities.mask.arithmeticSha256 ||
  arithmetic?.version !== 'native-hdr-mask-arithmetic-v3-electron-llvm' ||
  !matchesReference(arithmetic.reference) ||
  JSON.stringify(arithmetic.maskCompilerFlags) !== JSON.stringify(maskCompilerFlags) ||
  arithmetic.upstreamManifestSha256 !== manifest.sources[`${maskUpstream}/sources.json`] ||
  arithmetic.llvmShimSha256 !== manifest.sources['native/irodori-cpu-render/electron-atan2.h'] ||
  arithmetic.creativeHeaderSha256 !==
    manifest.sources['native/irodori-cpu-render/creative-color.h'] ||
  arithmetic.creativeAbiSha256 !==
    manifest.sources['native/irodori-cpu-render/creative-color-params.h'] ||
  arithmetic.creativeHostSha256 !== manifest.sources['native/irodori-cpu-render/src/creative.rs'] ||
  Object.keys(arithmetic.upstreamSourcePins ?? {}).length !== sourceInventory.files.length ||
  sourceInventory.files.some(
    ({ path, sha256 }) =>
      arithmetic.upstreamSourcePins?.[path] !== sha256 ||
      manifest.sources[`${maskUpstream}/${path}`] !== sha256,
  )
)
  throw new Error(
    'Native CPU mask capability derivation did not match its Electron LLVM source receipt.',
  )
manifest.nativeMask = {
  mode: '--mask-v1',
  arithmeticVersion: arithmetic.version,
  reference: arithmetic.reference,
  maskCompilerFlags,
  arithmeticSha256: capabilities.mask.arithmeticSha256,
  capabilitiesSha256: digest(join(working, 'capabilities.json')),
  generated: Object.fromEntries(
    ['aces_math.inc', 'mask_aces_math.inc', 'mask-context.inc'].map((name) => [
      name,
      digest(join(working, name)),
    ]),
  ),
}
manifest.status = 'built-unverified'
save()
writeFileSync(join(working, 'SHA256SUMS'), `${manifest.executable.sha256}  irodori-cpu-render\n`)
console.log(JSON.stringify({ directory: working, ...manifest.executable, status: manifest.status }))
