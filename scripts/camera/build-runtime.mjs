import { execFileSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { assertRuntimeBinary, checkoutRoot, runtimePlatform } from './runtime.ts'
import { packRuntimeArchive, sha256 } from './archive.ts'

if (process.argv.length !== 2)
  throw new Error('Usage: npm run camera:build (maintainer build on the target host).')
const platform = runtimePlatform()
const lockPath = 'assets/app/camera-runtime/sources.lock.json'
const lock = JSON.parse(await readFile(join(checkoutRoot, lockPath), 'utf8'))
const parent = join(checkoutRoot, 'artifacts/camera/runtime-build')
await mkdir(parent, { recursive: true })
const working = await mkdtemp(join(parent, `${platform}-`))
const output = join(working, 'distribution')
const runtime = join(working, 'runtime')
await mkdir(output)
await mkdir(join(runtime, 'bin'), { recursive: true })
const commands = []
function run(command, args, cwd = working, env = process.env) {
  commands.push({ command, args, cwd })
  return execFileSync(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 ** 2,
  })
}
const sourceFiles = [
  lockPath,
  'LICENSE',
  'scripts/camera/image-capture.swift',
  'scripts/camera/build-runtime.mjs',
  'scripts/camera/runtime.ts',
  'scripts/camera/archive.ts',
  'assets/app/camera-runtime/README.md',
]
const sources = []
for (const path of sourceFiles)
  sources.push({ path, mode: 0o644, bytes: await readFile(join(checkoutRoot, path)) })
const notices = []
const tools = { node: process.version, os: release(), architecture: process.arch }
let modules
const executable = platform === 'darwin-arm64' ? 'bin/image-capture' : 'bin/gphoto2'
try {
  if (platform === 'darwin-arm64') {
    tools.swift = run('xcrun', ['swiftc', '--version']).toString().trim()
    run('xcrun', [
      'swiftc',
      '-swift-version',
      '5',
      '-O',
      '-target',
      'arm64-apple-macosx14.0',
      '-module-cache-path',
      join(working, 'module-cache'),
      join(checkoutRoot, 'scripts/camera/image-capture.swift'),
      '-o',
      join(runtime, executable),
    ])
    const linked = run('otool', ['-L', join(runtime, executable)]).toString()
    for (const line of linked
      .split('\n')
      .slice(1)
      .filter((line) => line.trim())) {
      const library = line.trim().split(' (')[0]
      if (!library.startsWith('/System/Library/') && !library.startsWith('/usr/lib/'))
        throw new Error(`Non-system macOS dependency: ${library}`)
    }
    const load = run('otool', ['-l', join(runtime, executable)]).toString()
    if (!/minos 14\.0/.test(load) || /LC_RPATH/.test(load))
      throw new Error('Invalid macOS deployment target or rpath.')
    await writeFile(join(output, 'macos-linkage.txt'), linked + '\n' + load)
    notices.push(
      'ImageCaptureCore helper: Irodori Apache-2.0. Apple system frameworks are not redistributed.',
    )
    await mkdir(join(runtime, 'licenses'))
    await copyFile(join(checkoutRoot, 'LICENSE'), join(runtime, 'licenses/Irodori-LICENSE'))
  } else {
    tools.cc = run('cc', ['--version']).toString().split('\n')[0]
    tools.patchelf = run('patchelf', ['--version']).toString().trim()
    const archives = join(parent, 'sources')
    const prefix = join(working, 'prefix')
    await mkdir(archives, { recursive: true })
    const env = {
      ...process.env,
      LC_ALL: 'C',
      PKG_CONFIG_LIBDIR: join(prefix, 'lib/pkgconfig'),
      PKG_CONFIG_PATH: '',
      CPPFLAGS: `-I${prefix}/include`,
      CFLAGS: `-O2 -fPIC -ffile-prefix-map=${working}=/camera-build`,
      LDFLAGS: `-L${prefix}/lib`,
      LD_LIBRARY_PATH: join(prefix, 'lib'),
      LTDLINCL: `-I${prefix}/include`,
      LIBLTDL: `-L${prefix}/lib -lltdl`,
    }
    const configurations = {
      libusb: ['--disable-udev'],
      libtool: ['--enable-ltdl-install'],
      popt: ['--disable-nls'],
      libgphoto2: [
        '--disable-nls',
        '--disable-rpath',
        '--with-camlibs=ptp2',
        '--with-libusb-1.0=' + prefix,
        '--without-libusb',
        '--disable-serial',
        '--disable-ttylock',
        '--disable-lockdev',
        '--disable-disk',
        '--disable-ptpip',
        '--disable-vusb',
        '--without-jpeg',
        '--with-libxml-2.0=no',
        '--with-libcurl=no',
        '--with-gdlib=no',
        '--with-libtiff-4=no',
        '--with-libexif=no',
      ],
      gphoto2: [
        '--disable-nls',
        '--disable-rpath',
        '--without-readline',
        '--without-cdk',
        '--without-aalib',
        '--without-jpeg',
      ],
    }
    for (const source of lock.sources) {
      const archive = join(archives, source.archive)
      let bytes
      try {
        bytes = await readFile(archive)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        run('curl', [
          '--fail',
          '--location',
          '--retry',
          '3',
          '--max-time',
          '120',
          source.url,
          '-o',
          archive,
        ])
        bytes = await readFile(archive)
      }
      if (sha256(bytes) !== source.sha256)
        throw new Error(`Pinned source checksum mismatch: ${source.archive}`)
      sources.push({ path: `upstream/${source.archive}`, mode: 0o644, bytes })
      run('tar', ['-xf', archive, '-C', working])
      const directory = join(working, source.directory)
      const args = [
        `--prefix=${prefix}`,
        `--libdir=${prefix}/lib`,
        '--disable-static',
        '--enable-shared',
        ...configurations[source.name],
      ]
      run('./configure', args, directory, env)
      run('make', ['-j', String(Math.min(cpus().length, 4))], directory, env)
      run('make', ['install'], directory, env)
      await mkdir(join(runtime, 'licenses', source.name), { recursive: true })
      for (const notice of source.notices)
        await copyFile(
          join(directory, notice),
          join(runtime, 'licenses', source.name, basename(notice)),
        )
      notices.push(
        `${source.name} ${source.version}: ${source.license}; ${source.url}; SHA-256 ${source.sha256}`,
      )
    }
    await copyFile(join(prefix, 'bin/gphoto2'), join(runtime, executable))
    async function copyLibraries(directory, relative = 'lib') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const target = join(runtime, relative, entry.name)
        if (entry.isDirectory()) await copyLibraries(path, `${relative}/${entry.name}`)
        else if (/\.so(?:\.|$)/.test(entry.name)) {
          await mkdir(dirname(target), { recursive: true })
          // Dereference SONAME links so the installer can reject all links.
          await copyFile(await realpath(path), target)
        }
      }
    }
    await copyLibraries(join(prefix, 'lib'))
    modules = {
      cameras: 'lib/libgphoto2/' + (await readdir(join(runtime, 'lib/libgphoto2')))[0],
      ports: 'lib/libgphoto2_port/' + (await readdir(join(runtime, 'lib/libgphoto2_port')))[0],
    }
    await writeFile(
      join(output, 'linux-configurations.json'),
      JSON.stringify(configurations, null, 2) + '\n',
    )
    // Delete access to the install prefix before smoke checks: the packaged copy
    // must load every library and both module families from the relocated tree.
    await rename(prefix, `${prefix}-unavailable`)
    async function checkLinkage(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await checkLinkage(path)
        else if (entry.name === 'gphoto2' || /\.so(?:\.|$)/.test(entry.name)) {
          const rpath = '$ORIGIN:$ORIGIN/..:$ORIGIN/../lib:$ORIGIN/../..'
          run('patchelf', ['--set-rpath', rpath, path])
          const dynamic = run('readelf', ['-d', path]).toString()
          if (dynamic.includes(prefix) || /NEEDED.*\[\//.test(dynamic))
            throw new Error(`Absolute build dependency: ${path}`)
          const linked = run('ldd', [path], working, {
            ...env,
            LD_LIBRARY_PATH: join(runtime, 'lib'),
          }).toString()
          if (/not found/.test(linked)) throw new Error(linked)
          for (const line of linked.split('\n')) {
            const dependency = line.trim().split(' => ')[0]
            if (!line.includes(' => ') || line.includes(join(runtime, 'lib'))) continue
            if (!/^(libc|libm|libdl|libpthread|librt)\.so\./.test(dependency))
              throw new Error(`Unbundled non-glibc dependency: ${line}`)
          }
          await writeFile(join(output, 'linux-linkage.txt'), `${path}\n${dynamic}\n${linked}\n`, {
            flag: 'a',
          })
        }
      }
    }
    await checkLinkage(runtime)
    const smokeEnv = {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      LD_LIBRARY_PATH: join(runtime, 'lib'),
      CAMLIBS: join(runtime, modules.cameras),
      IOLIBS: join(runtime, modules.ports),
      XDG_CONFIG_HOME: join(working, 'isolated-config'),
    }
    const version = run(join(runtime, executable), ['--version'], working, smokeEnv).toString()
    if (!version.includes('gphoto2 2.5.32') || !version.includes('libgphoto2 2.5.34'))
      throw new Error(version)
    const cameras = run(join(runtime, executable), ['--list-cameras'], working, smokeEnv).toString()
    if (!/Sony ZV-1/.test(cameras))
      throw new Error('Packaged PTP camera module did not load Sony support.')
    const ports = run(join(runtime, executable), ['--list-ports'], working, smokeEnv).toString()
    if (!/usb:/i.test(ports)) throw new Error('Packaged USB module did not load.')
    const discovery = run(
      join(runtime, executable),
      ['--auto-detect'],
      working,
      smokeEnv,
    ).toString()
    await writeFile(join(output, 'linux-smoke.txt'), version + '\n' + ports + '\n' + discovery)
  }
  const build = {
    schema: 1,
    version: lock.version,
    platform,
    commit: run('git', ['rev-parse', 'HEAD'], checkoutRoot).toString().trim(),
    tools,
    sources: sources.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
    modules,
    requirements:
      platform === 'darwin-arm64'
        ? 'macOS 14+, Apple Silicon; system frameworks only'
        : 'Linux x64, glibc 2.35+, host USB permissions; PTP/USB only',
  }
  await writeFile(join(runtime, 'build.json'), JSON.stringify(build, null, 2) + '\n')
  await writeFile(
    join(runtime, 'NOTICE.txt'),
    notices.join('\n\n') +
      '\n\nMatching source archives and build scripts accompany this distribution in the dedicated camera runtime release.\n',
  )
  const files = []
  async function collect(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await collect(join(directory, entry.name), path)
      else {
        const mode = path === executable || /\.so(?:\.|$)/.test(path) ? 0o755 : 0o644
        await chmod(join(directory, entry.name), mode)
        files.push({ path, mode, bytes: await readFile(join(directory, entry.name)) })
      }
    }
  }
  await collect(runtime)
  assertRuntimeBinary(files.find((file) => file.path === executable).bytes, platform)
  const archive = `irodori-camera-${lock.version}-${platform}.tar.gz`
  const bytes = packRuntimeArchive(files)
  const distribution = {
    version: lock.version,
    platform,
    archive,
    url: `https://github.com/VaclavKlima/Irodori/releases/download/camera-runtime-v${lock.version}/${archive}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    executable,
    ...(modules ? { modules } : {}),
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      bytes: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
  }
  const sourceArchive = `irodori-camera-${lock.version}-${platform}-sources.tar.gz`
  const sourceBytes = packRuntimeArchive(sources)
  await writeFile(join(output, archive), bytes)
  await writeFile(join(output, sourceArchive), sourceBytes)
  await writeFile(
    join(output, `candidate-${platform}.json`),
    JSON.stringify(distribution, null, 2) + '\n',
  )
  await writeFile(
    join(output, `${archive}.sha256`),
    `${sha256(bytes)}  ${archive}\n${sha256(sourceBytes)}  ${sourceArchive}\n`,
  )
  await writeFile(join(output, 'build.json'), JSON.stringify(build, null, 2) + '\n')
  console.log(output)
} finally {
  await writeFile(join(working, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
}
