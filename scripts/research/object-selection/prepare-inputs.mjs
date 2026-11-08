import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'

const exec = promisify(execFile)
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  if (at < 0 || !args[at + 1]) throw new Error(`Provide ${name}.`)
  return args[at + 1]
}
const root = resolve(option('--root'))
const manifest = JSON.parse(await readFile(option('--inputs'), 'utf8'))
const output = resolve(option('--output'))
const previewModule = pathToFileURL(resolve(option('--preview-module'))).href
const { PreviewProcess } = await import(previewModule)
const decoder = new PreviewProcess(join(root, 'out/main/preview-worker.js'))
const prepared = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true })
try {
  for (const entry of manifest.images) {
    const source = resolve(root, entry.source)
    const local = relative(root, source)
    if (isAbsolute(local) || local === '..' || local.startsWith('../'))
      throw new Error('Research acceptance sources must be inside the checkout.')
    await exec('git', ['ls-files', '--error-unmatch', '--', local], { cwd: root })
    if (hash(await readFile(source)) !== entry.sha256) throw new Error(`Changed input: ${entry.id}`)
    if (!/^[a-z0-9-]+$/.test(entry.id)) throw new Error('Invalid research image ID.')
    const directory = join(output, entry.id)
    await mkdir(directory, { recursive: true })
    const started = performance.now()
    const metadata = await decoder.inspect(source, new AbortController().signal)
    const frame = await decoder.renderFull(source, directory, new AbortController().signal, {
      metadata,
      revision: 0,
      settings: { distortion: false, vignetting: false, chromaticAberration: false },
      processing:
        metadata.hdrEligible || metadata.hdrJpeg?.state === 'supported'
          ? 'hdr-v1'
          : 'display-referred-v1',
      adjustments: {
        whiteBalance: { mode: 'as-shot' },
        exposureEv: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        whites: 0,
        blacks: 0,
        saturation: 0,
        vibrance: 0,
      },
    })
    if (frame.width * frame.height > 24_000_000)
      throw new Error('Research input exceeds the declared 24 MP preparation bound.')
    const rgba = await readFile(join(directory, 'full.rgba'))
    if (rgba.byteLength !== frame.width * frame.height * 4 || hash(rgba) !== frame.sha256)
      throw new Error(`Incomplete decoded frame: ${entry.id}`)
    const path = join(directory, 'neutral-sdr.png')
    await sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } })
      .removeAlpha()
      .withIccProfile('srgb')
      .png()
      .toFile(path)
    prepared.push({
      ...entry,
      path,
      width: frame.width,
      height: frame.height,
      preparedSha256: hash(await readFile(path)),
      preparationMs: performance.now() - started,
      inputPolicy: 'full-native-once-oriented-neutral-sdr-no-lens-no-crop-no-local-edits-v1',
      geometry: frame.maskGeometry ?? frame.linear?.maskGeometry ?? frame.linear?.hdr?.maskGeometry,
    })
    await writeFile(
      join(output, 'prepared-inputs.json'),
      JSON.stringify({ version: 1, images: prepared }, null, 2) + '\n',
    )
    console.log(
      JSON.stringify({
        id: entry.id,
        width: frame.width,
        height: frame.height,
        preparationMs: prepared.at(-1).preparationMs,
      }),
    )
  }
} finally {
  await decoder.close(true)
}
console.log(`Prepared ${prepared.length} tracked originals; no application library was opened.`)
