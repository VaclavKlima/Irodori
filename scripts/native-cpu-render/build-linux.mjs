// Build and stage the Linux native CPU renderer using the existing pinned research recipe.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const [existingManifest, ...extra] = process.argv.slice(2)
if (process.platform !== 'linux' || process.arch !== 'x64' || extra.length)
  throw new Error(
    'Usage on Linux x64: node scripts/native-cpu-render/build-linux.mjs [OWNED_BUILD_MANIFEST]',
  )
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
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bounded = (path, maximum) => {
  const file = lstatSync(path)
  if (!file.isFile() || file.size < 1 || file.size > maximum)
    throw new Error(`Invalid bounded build input: ${path}`)
  return readFileSync(path)
}
let manifestPath
// This explicit argument is coordinator-only replay of a known retained build.
// Hash/recipe integrity is checked here; current app-math compatibility still
// requires separate exact replay/integration evidence and is never inferred.
if (existingManifest) manifestPath = resolve(existingManifest)
else {
  const built = JSON.parse(
    execFileSync(process.execPath, [join(root, 'scripts/research/build-native-cpu-render.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024,
    }).trim(),
  )
  manifestPath = join(built.directory, 'build-manifest.json')
}
const buildRoot = join(root, 'artifacts/native-cpu-render-build')
if (
  !manifestPath.startsWith(`${buildRoot}/build-`) ||
  !/^build-[A-Za-z0-9]+$/.test(dirname(manifestPath).slice(buildRoot.length + 1)) ||
  manifestPath !== join(dirname(manifestPath), 'build-manifest.json')
)
  throw new Error('Only an owned native CPU build manifest can be staged.')
const manifestBytes = bounded(manifestPath, 1024 ** 2),
  manifest = JSON.parse(manifestBytes.toString('utf8'))
const executable = join(dirname(manifestPath), 'irodori-cpu-render')
if (
  manifest.implementation !== 'float64-ctl-cpu-strip-v1' ||
  manifest.platform !== 'linux' ||
  manifest.arch !== 'x64' ||
  manifest.status !== 'built-unverified' ||
  manifest.executable?.path !== executable ||
  !/^[a-f0-9]{64}$/.test(manifest.executable.sha256) ||
  manifest.nativeMask?.mode !== '--mask-v1' ||
  !/^[a-f0-9]{64}$/.test(manifest.nativeMask.arithmeticSha256) ||
  !/^[a-f0-9]{64}$/.test(manifest.nativeMask.capabilitiesSha256) ||
  manifest.nativeMask.arithmeticVersion !== 'native-hdr-mask-arithmetic-v3-electron-llvm' ||
  !matchesReference(manifest.nativeMask.reference) ||
  JSON.stringify(manifest.nativeMask.maskCompilerFlags) !== JSON.stringify(maskCompilerFlags) ||
  JSON.stringify(manifest.maskCompilerFlags) !== JSON.stringify(maskCompilerFlags) ||
  !manifest.compilerFlags?.includes('-ffp-contract=off') ||
  !manifest.compilerFlags?.includes('-fno-fast-math')
)
  throw new Error('The native CPU build manifest does not match the pinned recipe.')
const binary = bounded(executable, 128 * 1024 ** 2)
if (hash(binary) !== manifest.executable.sha256)
  throw new Error('The native CPU build executable checksum does not match its provenance.')
const license = bounded(join(root, 'third_party/aces-core/LICENSE'), 64 * 1024)
const llvmLicense = bounded(join(root, maskUpstream, 'llvm-libc/LICENSE.TXT'), 64 * 1024)
const shim = bounded(join(root, 'native/irodori-cpu-render/electron-atan2.h'), 64 * 1024)
const sourceInventoryBytes = bounded(join(root, maskUpstream, 'sources.json'), 128 * 1024)
const sourceInventory = JSON.parse(sourceInventoryBytes.toString('utf8'))
if (
  hash(license) !== manifest.sources?.['third_party/aces-core/LICENSE'] ||
  hash(llvmLicense) !== manifest.sources?.[`${maskUpstream}/llvm-libc/LICENSE.TXT`] ||
  hash(shim) !== manifest.sources?.['native/irodori-cpu-render/electron-atan2.h'] ||
  hash(sourceInventoryBytes) !== manifest.sources?.[`${maskUpstream}/sources.json`] ||
  sourceInventory.version !== 'electron-mask-llvm-sources-v1' ||
  !matchesReference(sourceInventory.reference) ||
  !Array.isArray(sourceInventory.files) ||
  !sourceInventory.files.length ||
  sourceInventory.files.length > 256 ||
  sourceInventory.files.some(
    ({ path, sha256 }) =>
      typeof path !== 'string' ||
      path.length > 256 ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) ||
      path.split('/').some((part) => part === '.' || part === '..') ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      manifest.sources?.[`${maskUpstream}/${path}`] !== sha256,
  ) ||
  new Set(sourceInventory.files.map(({ path }) => path)).size !== sourceInventory.files.length
)
  throw new Error(
    'The distributed LLVM license/shim/provenance must match the selected native build.',
  )
const provenanceLicenses = [
  ['electron-LICENSE', 'provenance-electron-MIT.txt'],
  ['chromium-LICENSE', 'provenance-chromium-BSD.txt'],
  ['v8-LICENSE', 'provenance-v8-BSD.txt'],
].map(([source, destination]) => {
  const name = `provenance/${source}`
  const bytes = bounded(join(root, maskUpstream, name), 16 * 1024)
  if (hash(bytes) !== manifest.sources[`${maskUpstream}/${name}`])
    throw new Error('A distributed provenance-source license changed from the selected build.')
  return { destination, bytes }
})
const capabilities = bounded(join(dirname(manifestPath), 'capabilities.json'), 64 * 1024)
const arithmetic = bounded(join(dirname(manifestPath), 'mask-arithmetic.json'), 64 * 1024)
if (
  hash(capabilities) !== manifest.nativeMask.capabilitiesSha256 ||
  hash(arithmetic) !== manifest.nativeMask.arithmeticSha256
)
  throw new Error('The retained native CPU mask capability files changed.')
const capability = JSON.parse(capabilities.toString('utf8'))
const receipt = JSON.parse(arithmetic.toString('utf8'))
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  )
}
if (
  capability.version !== 'native-cpu-capabilities-v1' ||
  capability.presentation !== 'IRODCPU3' ||
  capability.mask?.request !== 'MASKCPU3' ||
  capability.mask.output !== 'MASKOUT1' ||
  capability.mask.terminal !== 'MASKDONE' ||
  capability.mask.mode !== '--mask-v1' ||
  capability.mask.arithmeticSha256 !== manifest.nativeMask.arithmeticSha256 ||
  hash(canonical(capability.mask.arithmetic)) !== manifest.nativeMask.arithmeticSha256 ||
  receipt.version !== 'native-hdr-mask-arithmetic-v3-electron-llvm' ||
  !matchesReference(receipt.reference) ||
  JSON.stringify(receipt.maskCompilerFlags) !== JSON.stringify(maskCompilerFlags) ||
  receipt.llvmShimSha256 !== hash(shim) ||
  receipt.upstreamManifestSha256 !== hash(sourceInventoryBytes) ||
  receipt.normalBridgeSha256 !== manifest.sources['native/irodori-cpu-render/bridge.cpp'] ||
  receipt.maskBridgeSha256 !== manifest.sources['native/irodori-cpu-render/mask-bridge.cpp'] ||
  receipt.maskHostSha256 !== manifest.sources['native/irodori-cpu-render/src/mask.rs'] ||
  receipt.prepareSourceSha256 !== manifest.sources['native/irodori-cpu-render/prepare-mask.py'] ||
  receipt.creativeHeaderSha256 !== manifest.sources['native/irodori-cpu-render/creative-color.h'] ||
  receipt.creativeAbiSha256 !==
    manifest.sources['native/irodori-cpu-render/creative-color-params.h'] ||
  receipt.creativeHostSha256 !== manifest.sources['native/irodori-cpu-render/src/creative.rs'] ||
  receipt.ordinaryGeneratedSha256 !== manifest.nativeMask.generated?.['aces_math.inc'] ||
  receipt.maskGeneratedSha256 !== manifest.nativeMask.generated?.['mask_aces_math.inc'] ||
  receipt.maskContextSha256 !== manifest.nativeMask.generated?.['mask-context.inc'] ||
  Object.keys(receipt.upstreamSourcePins ?? {}).length !== sourceInventory.files.length ||
  sourceInventory.files.some(({ path, sha256 }) => receipt.upstreamSourcePins?.[path] !== sha256)
)
  throw new Error(
    'The retained native CPU capability does not match the Electron LLVM build receipt.',
  )
const destination = join(root, 'vendor/native-cpu-render/linux-x64'),
  licenses = join(destination, 'licenses')
mkdirSync(licenses, { recursive: true })
const temporary = join(destination, `irodori-cpu-render-${process.pid}.tmp`)
writeFileSync(temporary, binary, { flag: 'wx', mode: 0o755 })
chmodSync(temporary, 0o755)
renameSync(temporary, join(destination, 'irodori-cpu-render'))
writeFileSync(
  join(destination, 'SHA256SUMS'),
  `${manifest.executable.sha256}  irodori-cpu-render\n`,
)
writeFileSync(join(destination, 'build-manifest.json'), manifestBytes)
writeFileSync(join(destination, 'capabilities.json'), capabilities)
writeFileSync(join(destination, 'mask-arithmetic.json'), arithmetic)
writeFileSync(join(licenses, 'aces-core-Apache-2.0.txt'), license)
writeFileSync(join(licenses, 'llvm-libc-Apache-2.0-with-LLVM-exception.txt'), llvmLicense)
writeFileSync(join(licenses, 'electron-llvm-source-provenance.json'), sourceInventoryBytes)
for (const { destination, bytes } of provenanceLicenses)
  writeFileSync(join(licenses, destination), bytes)
writeFileSync(
  join(licenses, 'NOTICE.txt'),
  [
    'Irodori native CPU preview renderer',
    'Derived from Academy Color Encoding System (ACES) reference CTL.',
    'Copyright Contributors to the ACES Project.',
    `Upstream revision: ${manifest.acesRevision}`,
    'Upstream source: https://github.com/aces-aswf/aces-core',
    'Irodori generates a C++ Float64 implementation and adds bounded Rust transport.',
    'The upstream Apache-2.0 license is included unchanged in this directory.',
    'The mask-only atan2 uses unmodified LLVM libc headers with the exact Chromium source pin.',
    `Reference: Electron ${maskReference.electron}, Chromium ${maskReference.chromium}, V8 ${maskReference.v8}.`,
    `LLVM libc revision: ${maskReference.llvmLibcRevision}`,
    'Upstream source: https://github.com/llvm/llvm-project/tree/' +
      maskReference.llvmLibcRevision +
      '/libc',
    'The complete upstream LICENSE.TXT is included unchanged (Apache-2.0 with LLVM exceptions and additional notices).',
    'The local provenance inventory retains exact source URLs, byte lengths and SHA-256 values.',
    'No V8 implementation source is compiled into this helper; V8/Chromium/Electron source pins document its runtime provenance.',
    'Their source-provenance licenses are retained separately with the uncompiled snapshots and copied into this directory.',
    `Mask arithmetic SHA-256: ${manifest.nativeMask.arithmeticSha256}`,
    'System Rust/C++/C runtime dependencies are not bundled by this staging step.',
    '',
  ].join('\n'),
)
console.log(
  JSON.stringify({
    executable: join(destination, 'irodori-cpu-render'),
    sha256: manifest.executable.sha256,
    sourceBuildManifest: manifestPath,
    coordinatorSelectedRetainedBuild: Boolean(existingManifest),
    currentAppMathCompatibilityVerified: false,
    stagedOnly: true,
    applicationAcceptance: false,
  }),
)
