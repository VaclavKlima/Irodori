import { build } from 'esbuild'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
if (process.argv.length !== 3) throw new Error('Supply one fresh artifact output directory.')
const output = resolve(process.argv[2])
const insideArtifacts = relative(resolve(root, 'artifacts'), output)
if (!insideArtifacts || insideArtifacts.startsWith('..') || isAbsolute(insideArtifacts))
  throw new Error('Research bundles belong under artifacts/.')
const bundle = resolve(output, 'bundle.cjs'),
  metafile = resolve(output, 'metafile.json')
for (const file of [bundle, metafile])
  if (
    await stat(file).then(
      () => true,
      (error) => {
        if (error.code !== 'ENOENT') throw error
        return false
      },
    )
  )
    throw new Error('Preserve the earlier research bundle; choose a fresh directory.')
await mkdir(output, { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/research/strong-noise/gpu-child.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'external',
  outfile: bundle,
  metafile: true,
  legalComments: 'linked',
  logLevel: 'silent',
})
await writeFile(metafile, JSON.stringify(result.metafile, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(JSON.stringify({ bundle, metafile }) + '\n')
