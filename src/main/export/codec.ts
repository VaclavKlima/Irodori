import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface Wasm {
  HEAPU8: Uint8Array
  HEAPF32: Float32Array
  _malloc(bytes: number): number
  _free(pointer: number): void
  UTF8ToString(pointer: number): string
  _luma_encode(
    half: number,
    width: number,
    height: number,
    jpeg: number,
    size: number,
    quality: number,
    headroom: number,
  ): number
  _luma_output(): number
  _luma_size(): number
  _luma_error(): number
  _luma_release(): void
  _luma_probe(jpeg: number, size: number, boost: number): number
  _luma_info(out: number): void
  _luma_map(): number
  _luma_map_size(): number
  _luma_decode(): number
  _luma_pixels(): number
  _luma_stride(): number
  _luma_gamut(): number
}
export async function verifyUltraHdrBundle(
  directory = [
    join(import.meta.dirname, 'ultrahdr'),
    join(import.meta.dirname, '..', 'ultrahdr'),
    resolve('vendor/ultrahdr'),
  ]
    .map((path) => path.replace('app.asar/', 'app.asar.unpacked/'))
    .find((path) => existsSync(join(path, 'SHA256SUMS'))) ?? resolve('vendor/ultrahdr'),
) {
  const entries = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n')
  if (entries.length !== 2 || new Set(entries.map((line) => line.split(/\s+/)[1])).size !== 2)
    throw new Error('Incomplete Ultra HDR checksum manifest.')
  for (const line of entries) {
    const [expected, name] = line.split(/\s+/)
    if (
      !['luma-ultrahdr.mjs', 'luma-ultrahdr.wasm'].includes(name) ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256')
        .update(await readFile(join(directory, name)))
        .digest('hex') !== expected
    )
      throw new Error('Bundled Ultra HDR checksum mismatch.')
  }
  return directory
}
export async function loadUltraHdr(directory?: string) {
  if (process.versions.electron)
    throw new Error('The HDR JPEG encoder requires the isolated Node worker.')
  directory = await verifyUltraHdrBundle(directory)
  const module = await import(
    /* @vite-ignore */ pathToFileURL(join(directory, 'luma-ultrahdr.mjs')).href
  )
  const wasm: Wasm = await module.default({
    wasmBinary: await readFile(join(directory, 'luma-ultrahdr.wasm')),
  })
  const allocate = (bytes: Uint8Array) => {
    const p = wasm._malloc(bytes.byteLength)
    if (!p)
      throw new Error(
        'HDR JPEG exceeds the 2 GiB encoder allocation limit. Choose smaller dimensions.',
      )
    wasm.HEAPU8.set(bytes, p)
    return p
  }
  const check = (ok: number) => {
    if (!ok) throw new Error(wasm.UTF8ToString(wasm._luma_error()) || 'HDR JPEG encoder failed.')
  }
  return {
    memory: () => wasm.HEAPU8.buffer.byteLength,
    encode(
      half: Uint8Array,
      width: number,
      height: number,
      jpeg: Uint8Array,
      quality: number,
      headroom = 10,
    ) {
      const pixels = width * height
      if (
        !Number.isSafeInteger(pixels) ||
        pixels < 1 ||
        pixels * 16 > 512 * 1024 ** 2 ||
        half.byteLength !== pixels * 8 ||
        pixels * 56 + jpeg.byteLength * 3 + 128 * 1024 ** 2 > 2 * 1024 ** 3 ||
        !Number.isFinite(headroom) ||
        headroom < 1 ||
        headroom > 10
      )
        throw new Error(
          'HDR JPEG exceeds the supported encoder allocation limit. Choose smaller dimensions.',
        )
      let hp = 0,
        jp = 0
      try {
        hp = allocate(half)
        jp = allocate(jpeg)
        check(wasm._luma_encode(hp, width, height, jp, jpeg.byteLength, quality, headroom))
        const start = wasm._luma_output(),
          length = wasm._luma_size()
        if (!start || !length) throw new Error('HDR JPEG encoder returned no image.')
        return Buffer.from(wasm.HEAPU8.slice(start, start + length))
      } finally {
        wasm._luma_release()
        if (hp) wasm._free(hp)
        if (jp) wasm._free(jp)
      }
    },
    inspect(jpeg: Uint8Array, decodeBoost?: number) {
      if (jpeg.byteLength > 256 * 1024 ** 2)
        throw new Error('HDR JPEG exceeds the 256 MiB input limit.')
      let jp = 0,
        meta = 0
      try {
        jp = allocate(jpeg)
        check(wasm._luma_probe(jp, jpeg.byteLength, decodeBoost ?? 0))
        meta = wasm._malloc(22 * 4)
        if (!meta) throw new Error('HDR JPEG metadata allocation failed.')
        wasm._luma_info(meta)
        const info = Array.from(wasm.HEAPF32.slice(meta / 4, meta / 4 + 22))
        const start = wasm._luma_map(),
          size = wasm._luma_map_size()
        const map = Buffer.from(wasm.HEAPU8.slice(start, start + size))
        let pixels: Uint16Array | undefined
        let stride: number | undefined
        let gamut: number | undefined
        if (decodeBoost !== undefined) {
          const count = info[18] * info[19]
          if (!Number.isSafeInteger(count) || count < 1 || count * 16 > 512 * 1024 ** 2)
            throw new Error('HDR JPEG exceeds the floating-point image limit.')
          check(wasm._luma_decode())
          stride = wasm._luma_stride()
          gamut = wasm._luma_gamut()
          if (
            !Number.isSafeInteger(stride) ||
            stride < info[18] ||
            stride * info[19] * 8 > 512 * 1024 ** 2
          )
            throw new Error('Invalid HDR JPEG decoder stride.')
          const p = wasm._luma_pixels()
          const bytes = wasm.HEAPU8.slice(p, p + stride * info[19] * 8)
          pixels = new Uint16Array(bytes.buffer)
        }
        return { info, map, pixels, stride, gamut }
      } finally {
        wasm._luma_release()
        if (jp) wasm._free(jp)
        if (meta) wasm._free(meta)
      }
    },
  }
}
/** Round-to-nearest-even IEEE binary16; input is display-linear Rec.2020. */
export function halfFloat(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 65504)
    throw new Error('Invalid HDR encoder pixels.')
  if (value === 0) return 0
  const exp = Math.floor(Math.log2(value))
  const step = 2 ** Math.max(-24, exp - 10)
  const scaled = value / step,
    floor = Math.floor(scaled),
    fraction = scaled - floor
  const rounded = floor + Number(fraction > 0.5 || (fraction === 0.5 && floor % 2 === 1))
  if (exp < -14) return rounded
  return (exp + 15) * 1024 + rounded - 1024
}
