// Test-only file transport for the existing, checksummed shipping WASM decoder.
// The independent ISO oracle lives in TypeScript and never uses these decoded pixels as its base.
import { createHash } from 'node:crypto'
import { lstat, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_INPUT_BYTES = 128 * 1024 ** 2
const MAX_PIXELS = 33_554_432
const MAX_CODEC_BYTES = 2 * 1024 ** 3
const MAX_FRAME_BYTES = 512 * 1024 ** 2
const sha = (value) => createHash('sha256').update(value).digest('hex')

async function decode() {
  const [bundle, inputPath, outputPath, manifestPath, headroomText] = process.argv.slice(2)
  const headroom = Number(headroomText)
  if (process.argv.length !== 7 || !Number.isFinite(headroom) || headroom < 1 || headroom > 10.0001)
    throw new Error(
      'Expected a bundle, private input/output/manifest paths and supported headroom.',
    )
  const bundleManifest = await readFile(join(bundle, 'SHA256SUMS')),
    entries = bundleManifest.toString('utf8').trim().split('\n')
  if (entries.length !== 2) throw new Error('Incomplete decoder checksum manifest.')
  const files = new Map()
  for (const entry of entries) {
    const [expected, name] = entry.split(/\s+/)
    if (
      !['irodori-ultrahdr.mjs', 'irodori-ultrahdr.wasm'].includes(name) ||
      files.has(name) ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error('Invalid decoder checksum manifest.')
    const bytes = await readFile(join(bundle, name))
    if (sha(bytes) !== expected) throw new Error('Decoder bundle checksum mismatch.')
    files.set(name, { bytes, sha256: expected })
  }
  const inputStat = await lstat(inputPath)
  if (
    !inputStat.isFile() ||
    inputStat.isSymbolicLink() ||
    inputStat.size < 1 ||
    inputStat.size > MAX_INPUT_BYTES
  )
    throw new Error('Unsupported full-size decoder input.')
  const jpeg = await readFile(inputPath)
  if (jpeg.byteLength !== inputStat.size || jpeg.byteLength > MAX_INPUT_BYTES)
    throw new Error('The private decoder input changed.')
  const module = await import(pathToFileURL(join(bundle, 'irodori-ultrahdr.mjs')).href)
  const wasm = await module.default({ wasmBinary: files.get('irodori-ultrahdr.wasm').bytes })
  const check = (ok) => {
    if (!ok) throw new Error(wasm.UTF8ToString(wasm._irodori_error()) || 'HDR decoder failed.')
    if (wasm.HEAPU8.buffer.byteLength > MAX_CODEC_BYTES)
      throw new Error('The decoder exceeded its fixed 2 GiB heap cap.')
  }
  let inputPointer = 0,
    metadataPointer = 0,
    output,
    manifest,
    outputCreated = false,
    manifestCreated = false,
    succeeded = false,
    cleanupFailure
  try {
    inputPointer = wasm._malloc(jpeg.byteLength)
    if (!inputPointer) throw new Error('Cannot allocate bounded JPEG input.')
    wasm.HEAPU8.set(jpeg, inputPointer)
    check(wasm._irodori_probe(inputPointer, jpeg.byteLength, headroom))
    metadataPointer = wasm._malloc(22 * 4)
    if (!metadataPointer) throw new Error('Cannot allocate decoder metadata.')
    wasm._irodori_info(metadataPointer)
    const info = Array.from(wasm.HEAPF32.subarray(metadataPointer / 4, metadataPointer / 4 + 22))
    const [width, height, gainWidth, gainHeight] = info.slice(18)
    const count = width * height
    if (
      !info.every(Number.isFinite) ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 32768 ||
      height > 32768 ||
      count > MAX_PIXELS ||
      count * 16 > MAX_FRAME_BYTES ||
      gainWidth !== width ||
      gainHeight !== height
    )
      throw new Error('Unsupported full-size HDR/gain-map geometry.')
    check(wasm._irodori_decode())
    const stride = wasm._irodori_stride(),
      gamut = wasm._irodori_gamut(),
      start = wasm._irodori_pixels(),
      bytes = stride * height * 8
    if (
      !Number.isSafeInteger(stride) ||
      stride < width ||
      !Number.isSafeInteger(start) ||
      start < 1 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_FRAME_BYTES ||
      start + bytes > wasm.HEAPU8.byteLength ||
      gamut !== 2
    )
      throw new Error('Unsupported bounded Rec.2020 RGBA16 decoder output.')
    output = await open(outputPath, 'wx', 0o600)
    outputCreated = true
    const digest = createHash('sha256')
    let written = 0,
      largestWriteBytes = 0
    for (let top = 0; top < height; top += 64) {
      const rows = Math.min(64, height - top),
        length = rows * stride * 8
      if (length > 16 * 1024 ** 2) throw new Error('Decoder stripe exceeds 16 MiB.')
      // Borrow only this stripe; do not make a complete Node RGBA copy.
      const stripe = new Uint8Array(wasm.HEAPU8.buffer, start + top * stride * 8, length)
      digest.update(stripe)
      let offset = 0
      while (offset < length) {
        const result = await output.write(stripe, offset, length - offset, written + offset)
        if (!result.bytesWritten) throw new Error('Incomplete private HDR stripe write.')
        offset += result.bytesWritten
      }
      written += length
      largestWriteBytes = Math.max(largestWriteBytes, length)
    }
    await output.close()
    output = undefined
    if (written !== bytes || (await lstat(outputPath)).size !== bytes)
      throw new Error('Incomplete private HDR frame.')
    const moduleAfterSha256 = sha(await readFile(join(bundle, 'irodori-ultrahdr.mjs'))),
      wasmAfterSha256 = sha(await readFile(join(bundle, 'irodori-ultrahdr.wasm'))),
      bundleManifestAfterSha256 = sha(await readFile(join(bundle, 'SHA256SUMS')))
    if (
      moduleAfterSha256 !== files.get('irodori-ultrahdr.mjs').sha256 ||
      wasmAfterSha256 !== files.get('irodori-ultrahdr.wasm').sha256 ||
      bundleManifestAfterSha256 !== sha(bundleManifest)
    )
      throw new Error('The checksummed decoder inputs changed during decoding.')
    manifest = await open(manifestPath, 'wx', 0o600)
    manifestCreated = true
    await manifest.writeFile(
      JSON.stringify({
        protocol: 'irodori-test-hdr-rgba16-file-v1',
        width,
        height,
        stride,
        gamut,
        headroom,
        info,
        bytes,
        sha256: digest.digest('hex'),
        inputBytes: jpeg.byteLength,
        inputSha256: sha(jpeg),
        heapBytes: wasm.HEAPU8.buffer.byteLength,
        maximumRowsPerWrite: 64,
        largestWriteBytes,
        node: process.version,
        nodeExecutable: process.execPath,
        nodeExecutableSha256: sha(await readFile(process.execPath)),
        moduleSha256: files.get('irodori-ultrahdr.mjs').sha256,
        wasmSha256: files.get('irodori-ultrahdr.wasm').sha256,
        moduleAfterSha256,
        wasmAfterSha256,
        bundleManifestSha256: sha(bundleManifest),
        bundleManifestAfterSha256,
        layout: 'little-endian-binary16-interleaved-rgba-with-stride',
      }) + '\n',
    )
    await manifest.close()
    manifest = undefined
    succeeded = true
  } finally {
    // Drain every owned resource independently; one close failure cannot skip the rest.
    const drain = async (action) => {
      try {
        await action()
      } catch (error) {
        cleanupFailure ??= error
      }
    }
    await drain(() => output?.close())
    await drain(() => manifest?.close())
    await drain(() => wasm._irodori_release())
    if (inputPointer) await drain(() => wasm._free(inputPointer))
    if (metadataPointer) await drain(() => wasm._free(metadataPointer))
    if (!succeeded) {
      if (outputCreated) await drain(() => rm(outputPath, { force: true }))
      if (manifestCreated) await drain(() => rm(manifestPath, { force: true }))
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure
}

try {
  await decode()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
}
