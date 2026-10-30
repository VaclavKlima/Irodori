import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('The Rust native export codec currently targets Linux x64.')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const archiveDirectory = resolve(
  process.env.IRODORI_CODEC_ARCHIVE_DIR ?? join(root, 'artifacts/ultrahdr-native-build'),
)
const archives = {
  'source.tar.gz': 'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c',
  'jpeg.tar.gz': '35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285',
}
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
for (const [name, expected] of Object.entries(archives)) {
  const path = join(archiveDirectory, name)
  if (!existsSync(path) || digest(path) !== expected)
    throw new Error(
      `Missing or unverified ${path}. Supply the pinned archives documented in native/irodori-codec/README.md; this build does not download or update dependencies.`,
    )
}

const artifactRoot = join(root, 'artifacts/native-codec-build')
mkdirSync(artifactRoot, { recursive: true })
const working = mkdtempSync(join(artifactRoot, 'build-'))
const steps = []
const run = (command, args, env = process.env) => {
  steps.push({ command, args })
  return execFileSync(command, args, {
    cwd: working,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim()
}
const cmake = process.env.IRODORI_CODEC_CMAKE ?? 'cmake'
const cargo = process.env.IRODORI_CODEC_CARGO ?? 'cargo'
const compiler = process.env.CXX ?? 'c++'
const versions = {
  compiler: run(compiler, ['--version']).split('\n')[0],
  cargo: run(cargo, ['--version']),
  cmake: run(cmake, ['--version']).split('\n')[0],
}
for (const name of Object.keys(archives)) run('tar', ['-xzf', join(archiveDirectory, name)])

const source = join(working, 'libultrahdr-2.0.2')
const jpegSource = join(working, 'libjpeg-turbo-3.1.0')
const jpegBuild = join(working, 'jpeg-build')
const codecBuild = join(working, 'codec-build')
run(cmake, [
  '-S',
  jpegSource,
  '-B',
  jpegBuild,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
  `-DCMAKE_C_COMPILER=${process.env.CC ?? 'cc'}`,
  '-DENABLE_SHARED=OFF',
  '-DWITH_SIMD=ON',
  '-DWITH_TURBOJPEG=OFF',
])
run(cmake, ['--build', jpegBuild, '-j', '4', '--target', 'jpeg-static'])
run(cmake, [
  '-S',
  source,
  '-B',
  codecBuild,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
  `-DCMAKE_CXX_COMPILER=${compiler}`,
  '-DBUILD_SHARED_LIBS=OFF',
  '-DUHDR_BUILD_EXAMPLES=OFF',
  '-DUHDR_BUILD_TESTS=OFF',
  '-DUHDR_ENABLE_INSTALL=OFF',
  '-DUHDR_ENABLE_INTRINSICS=ON',
  '-DUHDR_ENABLE_HEIF=OFF',
  '-DUHDR_WRITE_XMP=OFF',
  '-DUHDR_WRITE_ISO=ON',
  `-DCMAKE_CXX_FLAGS=-I${jpegBuild} -ffp-contract=off -fno-fast-math`,
  `-DJPEG_LIBRARY=${join(jpegBuild, 'libjpeg.a')}`,
  `-DJPEG_INCLUDE_DIR=${join(jpegSource, 'src')}`,
])
run(cmake, ['--build', codecBuild, '-j', '4'])
const target = join(working, 'cargo')
run(
  cargo,
  [
    'build',
    '--release',
    '--locked',
    '--offline',
    '--manifest-path',
    join(root, 'native/irodori-codec/Cargo.toml'),
    '--target-dir',
    target,
  ],
  {
    ...process.env,
    CXX: compiler,
    IRODORI_CODEC_SOURCE: source,
    IRODORI_CODEC_LIBRARY: codecBuild,
    IRODORI_CODEC_JPEG_LIBRARY: jpegBuild,
  },
)

const binary = join(target, 'release/irodori-codec')
const manifest = {
  implementation: 'rust-ultrahdr-v1',
  platform: process.platform,
  arch: process.arch,
  archives,
  versions,
  upstreamThreads: 'Unmodified libultrahdr maximum of four encoder threads.',
  jpegDct: 'Unmodified accurate integer DCT (JDCT_ISLOW).',
  sources: Object.fromEntries(
    [
      'scripts/ultrahdr/build-linux.mjs',
      'scripts/ultrahdr/bridge.cpp',
      'native/irodori-codec/Cargo.toml',
      'native/irodori-codec/Cargo.lock',
      'native/irodori-codec/build.rs',
      'native/irodori-codec/probe.cpp',
      'native/irodori-codec/src/main.rs',
    ].map((name) => [name, digest(join(root, name))]),
  ),
  steps,
  binaryHash: digest(binary),
}
writeFileSync(join(working, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const destination = join(root, 'vendor/ultrahdr/native/linux-x64')
mkdirSync(destination, { recursive: true })
const staged = join(destination, `irodori-ultrahdr-${process.pid}.tmp`)
copyFileSync(binary, staged)
chmodSync(staged, 0o755)
renameSync(staged, join(destination, 'irodori-ultrahdr'))
writeFileSync(join(destination, 'SHA256SUMS'), `${manifest.binaryHash}  irodori-ultrahdr\n`)
writeFileSync(join(destination, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(
  JSON.stringify({ binary: join(destination, 'irodori-ultrahdr'), evidence: working }, null, 2),
)
