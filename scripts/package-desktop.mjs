import { packager } from '@electron/packager'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { installLauncher } from './desktop-launcher.mjs'

const root = resolve('.'),
  require = createRequire(import.meta.url)
if (!['darwin', 'linux'].includes(process.platform))
  throw new Error('Local packaging currently supports macOS and Linux hosts.')
const options = process.argv.slice(2)
if (options.some((arg) => !['--install-launcher'].includes(arg)))
  throw new Error('Usage: npm run package:desktop -- [--install-launcher]')
if (options.includes('--install-launcher') && process.platform !== 'linux')
  throw new Error('Launcher installation requires Linux.')
await access(join(root, 'out/main/index.js'))
const stageRoot = join(root, 'artifacts/packaging')
await mkdir(stageRoot, { recursive: true })
const stage = await mkdtemp(join(stageRoot, 'stage-'))
try {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  await writeFile(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName,
        version: pkg.version,
        description: pkg.description,
        type: 'module',
        main: pkg.main,
        license: pkg.license,
        dependencies: pkg.dependencies,
        optionalDependencies: pkg.optionalDependencies,
      },
      null,
      2,
    ),
  )
  await cp('out', join(stage, 'out'), { recursive: true })
  await cp('LICENSE', join(stage, 'LICENSE'))
  await mkdir(join(stage, 'licenses'), { recursive: true })
  await cp('assets/app/fonts/lato/OFL.txt', join(stage, 'licenses/Lato-OFL.txt'))
  await cp('assets/app/icons/manifest.json', join(stage, 'licenses/Little-Jizo-provenance.json'))
  const packages = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((p) => p !== root)
  const excluded = new Set([
    'node_modules',
    '.git',
    'tests',
    'test',
    'fixtures',
    '__tests__',
    'examples',
    'benchmarks',
    'benchmark',
  ])
  for (const source of packages) {
    const target = join(stage, relative(root, source))
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        !relative(source, path)
          .split(sep)
          .some((part) => excluded.has(part)),
    })
  }
  const paths = await packager({
    dir: stage,
    out: join(root, 'dist'),
    name: 'Irodori',
    executableName: process.platform === 'darwin' ? 'Irodori' : 'irodori',
    appBundleId: 'io.github.vaclavklima.Irodori',
    appCategoryType: 'public.app-category.photography',
    platform: process.platform,
    arch: process.arch,
    electronVersion: require('electron/package.json').version,
    icon: resolve(
      process.platform === 'darwin'
        ? 'assets/app/icons/generated/irodori.icns'
        : 'assets/app/icons/generated/icon-256.png',
    ),
    asar: false,
    prune: false,
    overwrite: true,
    osxSign: false,
    osxNotarize: false,
    darwinDarkModeSupport: true,
  })
  if (options.includes('--install-launcher'))
    console.log(`Launcher: ${await installLauncher(paths[0])}`)
  console.log(`Unsigned local application: ${paths.join(', ')}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}
