import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { MergeProcess } from '../src/main/merge/process'
import { runMerge } from '../src/main/merge/engine'
import { inverse, point } from '../src/main/merge/matrix'
import type { MergeMatrix } from '../src/shared/merge'
import { luminance } from '../src/shared/hdr'
import type { MergeSource, MergeSettings } from '../src/shared/merge'
import { unavailableProfile } from '../src/main/processing/metadata'
import { PROCESSING_METADATA_VERSION } from '../src/shared/lens'

export async function syntheticMerge(
  scales: number[],
  options: {
    noise?: number
    motion?: boolean | 'large'
    deghost?: boolean
    width?: number
    height?: number
    reference?: number
    worker?: boolean
    comparisons?: boolean
    edge?: boolean
    isoVariation?: boolean
    autoAlign?: boolean
    transforms?: MergeMatrix[]
    parallax?: boolean
    textures?: Float32Array[]
    scratchRoot?: string
  } = {},
) {
  const directory = await mkdtemp(join(options.scratchRoot ?? tmpdir(), 'irodori-merge-test-')),
    output = join(directory, 'output')
  const width = options.width ?? 160,
    height = options.height ?? 96,
    reference = options.reference ?? Math.floor(scales.length / 2)
  const clean = new Float32Array(width * height * 4),
    frames: Float32Array[] = []
  let seed = 719
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed + 0.5) / 4294967296
  }
  const field = (x: number, y: number, source = reference) => {
    if (options.textures) {
      const data = options.textures[source],
        px = Math.max(0, Math.min(width - 1, x)),
        py = Math.max(0, Math.min(height - 1, y)),
        ix = Math.floor(px),
        iy = Math.floor(py),
        dx = px - ix,
        dy = py - iy,
        nx = Math.min(width - 1, ix + 1),
        ny = Math.min(height - 1, iy + 1)
      return (
        (data[iy * width + ix] * (1 - dx) + data[iy * width + nx] * dx) * (1 - dy) +
        (data[ny * width + ix] * (1 - dx) + data[ny * width + nx] * dx) * dy
      )
    }
    const cell = 24
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell)
    const hash = (Math.imul(gx + 129, 374761393) ^ Math.imul(gy + 137, 668265263)) >>> 0
    const amplitude = 0.06 + (hash % 1024) / 2048
    const fx = ((x % cell) + cell) % cell,
      fy = ((y % cell) + cell) % cell
    return (
      0.08 + amplitude * Math.sin((Math.PI * fx) / cell) ** 2 * Math.sin((Math.PI * fy) / cell) ** 2
    )
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        v = options.autoAlign
          ? field(x, y)
          : options.edge
            ? x < width / 2
              ? 0.15
              : 0.65
            : 0.03 + 1.9 * (x / (width - 1)) ** 2
      clean.set([v, v * 0.7, -v * 0.025, 1], i)
    }
  const sources: MergeSource[] = scales.map((scale, i) => ({
    photo: {
      id: String(i + 1).padStart(64, '0'),
      filename: `source-${i}.ARW`,
      width,
      height,
      format: 'ARW',
      bytes: 1,
      importedAt: '2026-09-29',
      thumbnailUrl: '',
      previewUrl: '',
      previewSource: 'decoded',
    },
    capture: {
      shutterSeconds: scale / 100 / (options.isoVariation && i % 2 ? 2 : 1),
      iso: options.isoVariation && i % 2 ? 200 : 100,
      aperture: 2.8,
      focalLength: 9.4,
    },
    relativeEv: Math.log2(scale),
    metadata: {
      version: PROCESSING_METADATA_VERSION,
      model: 'ZV-1',
      make: 'Sony',
      hdrEligible: true,
      lensProfile: unavailableProfile,
      whiteBalance: {
        identity: 'synthetic',
        provider: 'test',
        version: '1',
        model: 'irodori-kang2002-ucs-1',
        ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
        estimate: { kelvin: 6500, tint: 0 },
        asShotGains: [1, 1, 1],
        cameraToWorking: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        xyzToCamera: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
    },
  }))
  // A deterministic synthetic reference profile only enters isolated numerical tests.
  for (let s = 0; s < scales.length; s++) {
    const data = new Float32Array(clean.length),
      planeRatio = Math.min(1, 1024 / Math.max(width, height)),
      planeWidth = Math.floor(width * planeRatio),
      planeHeight = Math.floor(height * planeRatio),
      plane = new Float32Array(planeWidth * planeHeight)
    const inv = options.transforms ? inverse(options.transforms[s]) : undefined
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const [qx, qy] = inv ? point(inv, x, y) : [x, y]
        let signal = field(
          qx + (options.parallax && s !== reference ? (qx < width / 2 ? 3 : -3) : 0),
          qy,
          s,
        )
        if (
          options.motion === 'large' &&
          qx > width * 0.2 &&
          qx < width * 0.8 &&
          qy > height * 0.15 &&
          qy < height * 0.95
        ) {
          const moving = s !== reference
          const dx = !moving ? 0 : qy < height * 0.4 ? 6 : qy < height * 0.7 ? -7 : 4
          const dy = !moving ? 0 : qy < height * 0.4 ? -4 : qy < height * 0.7 ? 3 : 5
          signal = 0.15 + field(qx + 317 + dx, qy + 521 + dy)
        }
        for (let c = 0; c < 3; c++)
          data[i + c] =
            (options.autoAlign ? signal * [1, 0.7, -0.025][c] : clean[i + c]) * scales[s] +
            (options.noise
              ? options.noise *
                Math.sqrt(-2 * Math.log(random())) *
                Math.cos(2 * Math.PI * random())
              : 0)
        if (options.motion === true && x > 20 + s * 12 && x < 35 + s * 12 && y > 25 && y < 65)
          for (let c = 0; c < 3; c++) data[i + c] = 0.6 * scales[s]
        data[i + 3] = Number(data[i] < 1)
        plane[
          Math.min(planeHeight - 1, Math.floor(y * planeRatio)) * planeWidth +
            Math.min(planeWidth - 1, Math.floor(x * planeRatio))
        ] = data[i + 3] ? Math.max(0, luminance([data[i], data[i + 1], data[i + 2]])) : 0
      }
    if (!options.worker) frames.push(data)
    const path = join(directory, `source-${s}.f32`)
    await writeFile(path, Buffer.from(data.buffer))
    await writeFile(
      join(directory, `source-${s}.json`),
      JSON.stringify({
        reference: sources[reference].photo.id,
        source: {
          path,
          strips: Array.from({ length: Math.ceil(height / 64) }, (_, row) =>
            createHash('sha256')
              .update(
                Buffer.from(data.buffer).subarray(
                  row * 64 * width * 16,
                  Math.min(data.byteLength, (row + 1) * 64 * width * 16),
                ),
              )
              .digest('hex'),
          ),
          width,
          height,
          plane: { width: planeWidth, height: planeHeight, data: Array.from(plane) },
          decoder: 'synthetic-independent-v1',
          cameraProfile: 'synthetic',
          normalization: {
            black: [0, 0, 0, 0],
            maximum: 1,
            gains: [1, 1, 1, 1],
            restoreGain: 1,
            referenceWhite: 1,
            sourceSaturation: null,
          },
        },
      }),
    )
  }
  const settings: MergeSettings = {
    mode: scales.every((s) => s === scales[0]) ? 'noise' : 'hdr',
    referenceId: sources[reference].photo.id,
    autoAlign: options.autoAlign ?? false,
    deghost: options.deghost ?? false,
    strength: 50,
    autoCrop: true,
  }
  await mkdir(output)
  try {
    const job = {
      directory,
      output,
      comparisons: options.comparisons,
      paths: sources.map((s) => s.photo.filename),
      sources,
      settings,
    }
    const result = options.worker
      ? await new MergeProcess(resolve('out/main/merge-worker.js')).run(
          job,
          new AbortController().signal,
          () => {},
        )
      : await runMerge(job)
    const bytes = await readFile(join(output, 'linear.f32'))
    return {
      directory,
      output,
      job,
      result,
      sources,
      frames,
      clean,
      pixels: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      close: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (e) {
    await rm(directory, { recursive: true, force: true })
    throw e
  }
}
