// Test-only isolated Sharp decode: one bounded RGB8 plane stays outside the parent.
import { createHash } from 'node:crypto'
import { lstat, open, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const MAX_INPUT_BYTES = 128 * 1024 ** 2
const MAX_PIXELS = 33_554_432
const MAX_PLANE_BYTES = MAX_PIXELS * 3
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function identity() {
  const nativePaths = Object.keys(require.cache).filter((path) => {
    const name = basename(path)
    return name.endsWith('.node') && (name === 'sharp.node' || name.startsWith('sharp-'))
  })
  if (nativePaths.length !== 1) throw new Error('Cannot identify the one loaded Sharp addon.')
  const entrypoint = fileURLToPath(import.meta.resolve('sharp')),
    nativeAddon = nativePaths[0]
  return {
    nodeExecutable: process.execPath,
    nodeExecutableSha256: sha(await readFile(process.execPath)),
    sharpVersion: sharp.versions.sharp,
    sharpVersions: sharp.versions,
    sharpEntrypoint: entrypoint,
    sharpEntrypointSha256: sha(await readFile(entrypoint)),
    sharpNativeAddon: nativeAddon,
    sharpNativeAddonSha256: sha(await readFile(nativeAddon)),
  }
}

async function writeRgb() {
  const [inputPath, outputPath, manifestPath, mode, widthText, heightText] = process.argv.slice(2),
    width = Number(widthText),
    height = Number(heightText),
    pixels = width * height
  if (
    process.argv.length !== 8 ||
    !['color', 'gain'].includes(mode) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 32768 ||
    height > 32768 ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAX_PIXELS
  )
    throw new Error(
      'Expected private JPEG/RGB8/manifest paths, color or gain mode and bounded dimensions.',
    )
  const inputStat = await lstat(inputPath)
  if (
    !inputStat.isFile() ||
    inputStat.isSymbolicLink() ||
    inputStat.size < 1 ||
    inputStat.size > MAX_INPUT_BYTES
  )
    throw new Error('Unsupported RGB8 writer input.')
  const jpeg = await readFile(inputPath)
  if (jpeg.length !== inputStat.size || jpeg.length > MAX_INPUT_BYTES)
    throw new Error('RGB8 writer input changed.')
  const tool = await identity()
  sharp.concurrency(1)
  sharp.cache(false)
  const options = {
      ignoreIcc: mode === 'gain',
      limitInputPixels: MAX_PIXELS,
      sequentialRead: true,
    },
    metadata = await sharp(jpeg, options).metadata()
  if (
    metadata.format !== 'jpeg' ||
    metadata.width !== width ||
    metadata.height !== height ||
    metadata.channels !== 3
  )
    throw new Error('Unexpected three-channel RGB8 JPEG geometry.')
  // Sharp supports raw output through toBuffer, not toFile. This complete RGB8
  // plane is isolated here; the parent receives only private files and metadata.
  const { data, info } = await sharp(jpeg, options)
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  if (
    info.width !== width ||
    info.height !== height ||
    info.channels !== 3 ||
    data.length !== pixels * 3 ||
    data.length > MAX_PLANE_BYTES
  )
    throw new Error('Unsupported bounded RGB8 output plane.')
  let output,
    manifest,
    outputCreated = false,
    manifestCreated = false,
    succeeded = false,
    cleanupFailure
  try {
    output = await open(outputPath, 'wx', 0o600)
    outputCreated = true
    const digest = createHash('sha256')
    let written = 0,
      largestWriteBytes = 0
    for (let top = 0; top < height; top += 64) {
      const rows = Math.min(64, height - top),
        stripe = data.subarray(top * width * 3, (top + rows) * width * 3)
      if (stripe.length > 16 * 1024 ** 2) throw new Error('RGB8 write exceeds 16 MiB.')
      digest.update(stripe)
      let offset = 0
      while (offset < stripe.length) {
        const result = await output.write(stripe, offset, stripe.length - offset, written + offset)
        if (!result.bytesWritten) throw new Error('Incomplete private RGB8 stripe write.')
        offset += result.bytesWritten
      }
      written += stripe.length
      largestWriteBytes = Math.max(largestWriteBytes, stripe.length)
    }
    await output.close()
    output = undefined
    if (written !== data.length || (await lstat(outputPath)).size !== written)
      throw new Error('Incomplete private RGB8 file.')
    const entrypointAfterSha256 = sha(await readFile(tool.sharpEntrypoint)),
      nativeAddonAfterSha256 = sha(await readFile(tool.sharpNativeAddon)),
      inputAfterStat = await lstat(inputPath)
    if (
      !inputAfterStat.isFile() ||
      inputAfterStat.isSymbolicLink() ||
      inputAfterStat.size !== inputStat.size ||
      inputAfterStat.size > MAX_INPUT_BYTES
    )
      throw new Error('RGB8 writer input identity changed during decoding.')
    const inputAfterSha256 = sha(await readFile(inputPath))
    if (
      entrypointAfterSha256 !== tool.sharpEntrypointSha256 ||
      nativeAddonAfterSha256 !== tool.sharpNativeAddonSha256 ||
      inputAfterSha256 !== sha(jpeg)
    )
      throw new Error('RGB8 writer inputs changed during decoding.')
    manifest = await open(manifestPath, 'wx', 0o600)
    manifestCreated = true
    await manifest.writeFile(
      JSON.stringify({
        protocol: 'irodori-test-rgb8-file-v1',
        mode,
        width,
        height,
        channels: 3,
        layout: 'interleaved-rgb8',
        bytes: written,
        sha256: digest.digest('hex'),
        inputBytes: jpeg.length,
        inputSha256: sha(jpeg),
        inputAfterSha256,
        maximumPlaneBytes: MAX_PLANE_BYTES,
        maximumRowsPerWrite: 64,
        largestWriteBytes,
        tool,
        entrypointAfterSha256,
        nativeAddonAfterSha256,
      }) + '\n',
    )
    await manifest.close()
    manifest = undefined
    succeeded = true
  } finally {
    const drain = async (action) => {
      try {
        await action()
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    await drain(() => output?.close())
    await drain(() => manifest?.close())
    if (!succeeded) {
      if (outputCreated) await drain(() => rm(outputPath, { force: true }))
      if (manifestCreated) await drain(() => rm(manifestPath, { force: true }))
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
}

try {
  await writeRgb()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
