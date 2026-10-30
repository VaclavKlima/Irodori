import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const build = resolve(root, 'artifacts/research-build', `${process.platform}-${process.arch}`)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
function run(executable, args, cwd = root) {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 ** 2,
    env: { ...process.env, OMP_NUM_THREADS: '1', OMP_DYNAMIC: 'FALSE' },
  }).trim()
}
export function buildNative(component, directory = build) {
  mkdirSync(directory, { recursive: true })
  const compiler = process.env.CXX || (process.platform === 'darwin' ? 'clang++' : 'c++')
  const version = run(compiler, ['--version'])
  const flags = ['-std=c++17', '-O3', '-ffp-contract=off', '-pthread']
  const binary = join(directory, component)
  const sources = [],
    libraries = {}
  if (component === 'pointwise')
    sources.push(resolve(root, 'scripts/research/native/pointwise.cpp'))
  else if (component === 'libraw' || component === 'opencv') {
    const pkg = component === 'libraw' ? 'libraw' : 'opencv4'
    const requiredVersion = component === 'libraw' ? '0.22.1' : '4.13.0'
    let available = false
    if (process.env.IRODORI_RESEARCH_PINNED_SOURCES !== '1') {
      try {
        libraries[pkg] = run('pkg-config', ['--modversion', pkg])
        available = true
      } catch {
        /* Use explicitly downloaded, pinned research sources below. */
      }
    }
    if (available) {
      if (libraries[pkg] !== requiredVersion)
        throw new Error(
          `${pkg} ${requiredVersion} is required for equivalence; found ${libraries[pkg]}. Use IRODORI_RESEARCH_PINNED_SOURCES=1 with the verified archives.`,
        )
      flags.push(...run('pkg-config', ['--cflags', pkg]).split(/\s+/).filter(Boolean))
      libraries.flags = run('pkg-config', ['--libs', pkg]).split(/\s+/).filter(Boolean)
    } else if (component === 'libraw') {
      const archive = resolve(root, 'artifacts/research-build/LibRaw-0.22.1.tar.gz')
      const expected = 'a789dc4e2409e2901d93793a4e0b80c7b49d0d97cf6ad71c850eb7616acfd786'
      if (hash(archive) !== expected) throw new Error('Unverified LibRaw source archive.')
      run('tar', ['-xzf', archive, '-C', directory])
      const source = join(directory, 'LibRaw-0.22.1')
      const configure = [
        '-f',
        'Makefile.dist',
        '-j',
        '4',
        'lib/libraw.a',
        `CXX=${compiler}`,
        'CFLAGS=-O3 -ffp-contract=off -I.',
      ]
      run('make', configure, source)
      flags.push(`-I${source}`)
      libraries.flags = [join(source, 'lib/libraw.a')]
      libraries.libraw = '0.22.1'
      libraries.archive = expected
      libraries.configure = configure
    } else {
      const archive = resolve(root, 'artifacts/research-build/opencv-4.13.0.tar.gz')
      const expected = '1d40ca017ea51c533cf9fd5cbde5b5fe7ae248291ddf2af99d4c17cf8e13017d'
      if (hash(archive) !== expected) throw new Error('Unverified OpenCV source archive.')
      run('tar', ['-xzf', archive, '-C', directory])
      const source = join(directory, 'opencv-4.13.0'),
        output = join(directory, 'opencv-build')
      const cmake = [
        '-S',
        source,
        '-B',
        output,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CXX_STANDARD=17',
        '-DBUILD_LIST=core,imgproc,features2d,calib3d,video',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DBUILD_TESTS=OFF',
        '-DBUILD_PERF_TESTS=OFF',
        '-DBUILD_EXAMPLES=OFF',
        '-DBUILD_opencv_apps=OFF',
        '-DBUILD_opencv_gapi=OFF',
        '-DBUILD_JAVA=OFF',
        '-DWITH_IPP=OFF',
        '-DWITH_LAPACK=OFF',
        '-DWITH_CAROTENE=OFF',
        '-DWITH_KLEIDICV=OFF',
        '-DWITH_ITT=OFF',
        '-DWITH_OPENCL=OFF',
        '-DWITH_FFMPEG=OFF',
        '-DWITH_GSTREAMER=OFF',
        '-DWITH_PROTOBUF=OFF',
        '-DBUILD_ZLIB=OFF',
        '-DWITH_ZLIB=OFF',
        '-DWITH_PNG=OFF',
        '-DWITH_JPEG=OFF',
        '-DWITH_TIFF=OFF',
        '-DWITH_OPENEXR=OFF',
      ]
      run('cmake', cmake)
      run('cmake', ['--build', output, '-j', '4'])
      for (const module of ['core', 'imgproc', 'features2d', 'flann', 'calib3d', 'video'])
        flags.push(`-I${join(source, 'modules', module, 'include')}`)
      flags.push(`-I${output}`)
      libraries.flags = ['video', 'calib3d', 'features2d', 'flann', 'imgproc', 'core'].map(
        (module) => join(output, `lib/libopencv_${module}.a`),
      )
      libraries.flags.push('-lz')
      libraries.opencv4 = '4.13.0'
      libraries.archive = expected
      libraries.cmake = cmake
    }
    sources.push(resolve(root, `scripts/research/native/${component}.cpp`))
  } else if (/^hdr-[124]$/.test(component)) {
    // The unchanged production bridge relies on a transitive integer header on
    // macOS. Supply it explicitly for this isolated GCC research build.
    if (process.platform === 'linux') flags.push('-include', 'cstdint')
    const threads = Number(component.slice(-1)),
      upstream = resolve(root, 'artifacts/ultrahdr-native-build')
    for (const [archive, expected] of Object.entries({
      'source.tar.gz': 'aa8d193bb887c348c419780511dd03b374f4e07af8812b6d3f80c8537cf1ef2c',
      'jpeg.tar.gz': '35fec2e1ddfb05ecf6d93e50bc57c1e54bc81c16d611ddf6eff73fff266d8285',
    }))
      if (hash(join(upstream, archive)) !== expected)
        throw new Error(`Unverified research source: ${archive}`)
    const owned = join(directory, `uhdr-${threads}`)
    mkdirSync(owned, { recursive: true })
    run('tar', ['-xzf', join(upstream, 'source.tar.gz'), '-C', owned])
    run('tar', ['-xzf', join(upstream, 'jpeg.tar.gz'), '-C', owned])
    const source = join(owned, 'libultrahdr-2.0.2'),
      jpeg = join(owned, 'libjpeg-turbo-3.1.0')
    const cpu = join(source, 'lib/src/jpegr.cpp'),
      text = readFileSync(cpu, 'utf8')
    const original =
      'unsigned int GetCPUCoreCount() { return (std::max)(1u, std::thread::hardware_concurrency()); }'
    if (text.split(original).length !== 2)
      throw new Error('Pinned Ultra HDR threading function changed.')
    // Research-only source copy. Production and vendored binaries are untouched.
    writeFileSync(
      cpu,
      text.replace(original, `unsigned int GetCPUCoreCount() { return ${threads}u; }`),
    )
    const jpegBuild = join(owned, 'jpeg-build'),
      hdrBuild = join(owned, 'build')
    run('cmake', [
      '-S',
      jpeg,
      '-B',
      jpegBuild,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DENABLE_SHARED=OFF',
      '-DWITH_SIMD=ON',
      '-DWITH_TURBOJPEG=OFF',
    ])
    run('cmake', ['--build', jpegBuild, '-j', '4', '--target', 'jpeg-static'])
    run('cmake', [
      '-S',
      source,
      '-B',
      hdrBuild,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DUHDR_BUILD_EXAMPLES=OFF',
      '-DUHDR_BUILD_TESTS=OFF',
      '-DUHDR_ENABLE_INSTALL=OFF',
      '-DUHDR_ENABLE_INTRINSICS=ON',
      '-DUHDR_ENABLE_HEIF=OFF',
      '-DUHDR_WRITE_XMP=OFF',
      '-DUHDR_WRITE_ISO=ON',
      `-DCMAKE_CXX_FLAGS=-I${jpegBuild}`,
      `-DJPEG_LIBRARY=${join(jpegBuild, 'libjpeg.a')}`,
      `-DJPEG_INCLUDE_DIR=${join(jpeg, 'src')}`,
    ])
    run('cmake', ['--build', hdrBuild, '-j', '4'])
    flags.push(`-I${source}`)
    sources.push(
      resolve(root, 'scripts/research/native/hdr.cpp'),
      resolve(root, 'scripts/ultrahdr/bridge.cpp'),
    )
    libraries.flags = [join(hdrBuild, 'libuhdr.a'), join(jpegBuild, 'libjpeg.a')]
    libraries.threads = threads
    libraries.upstream = {
      libultrahdr: '2.0.2',
      libjpegTurbo: '3.1.0',
      modifiedSource: hash(cpu),
      patch: `GetCPUCoreCount returns ${threads}`,
    }
  } else throw new Error('Choose pointwise, libraw, opencv, hdr-1, hdr-2, or hdr-4.')
  run(compiler, [...flags, ...sources, ...(libraries.flags || []), '-o', binary])
  const manifest = {
    component,
    compiler: version,
    flags,
    libraries,
    sources: Object.fromEntries(sources.map((s) => [s.slice(root.length + 1), hash(s)])),
    binaryHash: hash(binary),
    platform: process.platform,
    arch: process.arch,
  }
  writeFileSync(`${binary}.json`, JSON.stringify(manifest, null, 2))
  return { binary, manifest }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(buildNative(process.argv[2]), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
