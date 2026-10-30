import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MergeMatrix } from '../../shared/merge'
import type { Plane } from './math'
import { identityMatrix } from './matrix'

interface Wasm {
  _irodori_patch_stats(output: number, reset: number): void
  _irodori_features(
    image: number,
    mask: number,
    width: number,
    height: number,
    points: number,
    descriptors: number,
  ): number
  _irodori_descriptors(
    ak: number,
    ad: number,
    an: number,
    bk: number,
    bd: number,
    bn: number,
    points: number,
  ): number
  _irodori_patches(
    a: number,
    b: number,
    width: number,
    height: number,
    afirst: number,
    arows: number,
    bfirst: number,
    brows: number,
    matrix: number,
    centers: number,
    count: number,
    edge: number,
    fraction: number,
    out: number,
    tiles: number,
    columns: number,
    identical: number,
  ): number
  HEAPU8: Uint8Array
  HEAPF32: Float32Array
  HEAPF64: Float64Array
  _malloc(bytes: number): number
  _free(pointer: number): void
  _irodori_matches(
    a: number,
    b: number,
    am: number,
    bm: number,
    w: number,
    h: number,
    out: number,
  ): number
  _irodori_fit(
    points: number,
    count: number,
    projective: number,
    threshold: number,
    matrix: number,
    mask: number,
  ): number
  _irodori_ecc(
    a: number,
    b: number,
    am: number,
    bm: number,
    w: number,
    h: number,
    matrix: number,
    motion: number,
    iterations: number,
  ): number
}
let instance: Promise<Wasm> | undefined
const descriptors = new WeakMap<Plane, { keys: Float32Array; data: Uint8Array; count: number }>()
const matches = new WeakMap<Plane, WeakMap<Plane, number[][]>>()
async function load(): Promise<Wasm> {
  const directory = existsSync(join(import.meta.dirname, 'opencv'))
    ? join(import.meta.dirname, 'opencv')
    : resolve(import.meta.dirname, '../../../vendor/opencv')
  const checksums = await readFile(join(directory, 'SHA256SUMS'), 'utf8')
  const entries = checksums.trim().split('\n')
  if (entries.length !== 2 || new Set(entries.map((line) => line.split(/\s+/)[1])).size !== 2)
    throw new Error('Incomplete OpenCV checksum manifest.')
  for (const line of entries) {
    const [expected, name] = line.split(/\s+/)
    if (!['irodori-opencv.mjs', 'irodori-opencv.wasm'].includes(name))
      throw new Error('Invalid OpenCV checksum manifest.')
    if (
      createHash('sha256')
        .update(await readFile(join(directory, name)))
        .digest('hex') !== expected
    )
      throw new Error('Bundled OpenCV checksum mismatch.')
  }
  const module = await import(
    /* @vite-ignore */ pathToFileURL(join(directory, 'irodori-opencv.mjs')).href
  )
  return module.default({ wasmBinary: await readFile(join(directory, 'irodori-opencv.wasm')) })
}
export async function openCv() {
  const cv = await (instance ??= load())
  // Heap views may change after malloc. Copy only through the current heap.
  function scope<T>(
    operation: (alloc: (value: Uint8Array | Float32Array | Float64Array) => number) => T,
  ): T {
    const allocations: number[] = []
    try {
      return operation((value) => {
        const p = cv._malloc(value.byteLength)
        if (!p) throw new Error('OpenCV allocation limit reached.')
        allocations.push(p)
        cv.HEAPU8.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), p)
        return p
      })
    } finally {
      for (const p of allocations) cv._free(p)
    }
  }
  const mask = (p: Plane) => p.mask ?? Uint8Array.from(p.data, (v) => (v > 0 ? 255 : 0))
  return {
    memory: () => cv.HEAPU8.buffer.byteLength,
    matches(a: Plane, b: Plane): number[][] {
      let others = matches.get(a)
      if (!others) matches.set(a, (others = new WeakMap()))
      const cached = others.get(b)
      if (cached) return cached
      const found = scope((alloc) => {
        const features = (p: Plane) => {
          let found = descriptors.get(p)
          if (!found) {
            const pixels = new Uint8Array(p.data.length)
            for (let i = 0; i < pixels.length; i++)
              pixels[i] = Math.max(0, Math.min(255, Math.round(p.data[i] * 255)))
            const image = alloc(pixels),
              valid = alloc(mask(p)),
              keys = alloc(new Float32Array(8000)),
              data = alloc(new Uint8Array(4000 * 32)),
              count = cv._irodori_features(image, valid, p.width, p.height, keys, data)
            if (count < 0 || count > 4000) throw new Error('OpenCV feature extraction failed.')
            found = {
              keys: new Float32Array(cv.HEAPF32.slice(keys / 4, keys / 4 + count * 2)),
              data: new Uint8Array(cv.HEAPU8.slice(data, data + count * 32)),
              count,
            }
            descriptors.set(p, found)
          }
          return found
        }
        const af = features(a),
          bf = features(b),
          ak = alloc(af.keys),
          ad = alloc(af.data),
          bk = alloc(bf.keys),
          bd = alloc(bf.data),
          out = alloc(new Float32Array(16000))
        const count = cv._irodori_descriptors(ak, ad, af.count, bk, bd, bf.count, out)
        if (count < 0) throw new Error('OpenCV feature matching failed.')
        return Array.from({ length: count }, (_, i) =>
          Array.from(cv.HEAPF32.subarray(out / 4 + i * 4, out / 4 + i * 4 + 4)),
        )
      })
      others.set(b, found)
      return found
    },
    patchStats(reset = false) {
      return scope((alloc) => {
        const output = alloc(new Float64Array(4))
        cv._irodori_patch_stats(output, Number(reset))
        const p = cv.HEAPF64.subarray(output / 8, output / 8 + 4)
        return { samplingMs: p[0], optimizationMs: p[1], count: p[2], pixels: p[3] }
      })
    },
    patches(
      a: { data: Float32Array; first: number; rows: number },
      b: { data: Float32Array; first: number; rows: number },
      width: number,
      height: number,
      matrix: MergeMatrix,
      centers: number[][],
      edge: number,
      fraction: number,
      tiles?: import('../../shared/merge').MergeTransform['tiles'],
      identical = false,
      coarse = false,
    ) {
      return scope((alloc) => {
        const ap = alloc(a.data),
          bp = alloc(b.data),
          m = alloc(Float64Array.from(matrix)),
          cp = alloc(Float32Array.from(centers.flat())),
          out = alloc(new Float32Array(centers.length * 5)),
          count = cv._irodori_patches(
            ap,
            bp,
            width,
            height,
            a.first,
            a.rows,
            b.first,
            b.rows,
            m,
            cp,
            centers.length,
            edge,
            fraction,
            out,
            alloc(Float32Array.from(tiles?.offsets ?? [0, 0])),
            tiles?.columns ?? 0,
            Number(identical) | (Number(coarse) << 1),
          )
        if (count < 0 || count > centers.length)
          throw new Error('OpenCV patch registration failed.')
        return Array.from({ length: count }, (_, i) => {
          const p = cv.HEAPF32.subarray(out / 4 + i * 5, out / 4 + i * 5 + 5)
          return { x: p[0], y: p[1], dx: p[2], dy: p[3], correlation: p[4], accepted: false }
        })
      })
    },
    fit(points: number[][], projective: boolean, threshold: number) {
      if (points.length < 4) return undefined
      return scope((alloc) => {
        const p = alloc(Float32Array.from(points.flat())),
          m = alloc(new Float64Array(9)),
          mask = alloc(new Uint8Array(points.length))
        const count = cv._irodori_fit(p, points.length, Number(projective), threshold, m, mask)
        if (count < 4) return undefined
        return {
          matrix: Array.from(cv.HEAPF64.subarray(m / 8, m / 8 + 9)) as MergeMatrix,
          inliers: Array.from(cv.HEAPU8.subarray(mask, mask + points.length)).map(Boolean),
        }
      })
    },
    ecc(a: Plane, b: Plane, matrix: MergeMatrix = identityMatrix(), motion = 3, iterations = 80) {
      return scope((alloc) => {
        const ap = alloc(a.data),
          bp = alloc(b.data),
          am = alloc(mask(a)),
          bm = alloc(mask(b)),
          m = alloc(Float64Array.from(matrix))
        const correlation = cv._irodori_ecc(
          ap,
          bp,
          am,
          bm,
          a.width,
          a.height,
          m,
          motion,
          iterations,
        )
        return {
          correlation,
          matrix: Array.from(cv.HEAPF64.subarray(m / 8, m / 8 + 9)) as MergeMatrix,
        }
      })
    },
  }
}
