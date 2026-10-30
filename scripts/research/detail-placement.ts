import { createHash } from 'node:crypto'
import {
  compileNoiseReduction,
  compileDetailSharpening,
  denoiseDetailTile,
  sharpenDetailTile,
  SPATIAL_DETAIL_VERSION,
} from '../../src/shared/spatial-detail.ts'
import {
  cropGeometry,
  fitCrop,
  identityCrop,
  CROP_GEOMETRY_VERSION,
} from '../../src/shared/crop.ts'
import { resampleCropTile, CROP_FILTER_VERSION } from '../../src/shared/crop-filter.ts'
import {
  inverseMatrix,
  whiteBalanceMatrix,
  WHITE_BALANCE_MODEL,
  type WhiteBalance,
  type WhiteBalanceProfile,
} from '../../src/shared/white-balance.ts'
import type { ColorPrimaries } from '../../src/shared/color-model.ts'

/** CC0-1.0 known-truth order experiment. No application integration or photo decoding. */
export const DETAIL_PLACEMENT_VERSION = 'native-detail-placement-comparison-1'
export const placementSeeds = [1, 12345, 3735928559, 1515870810] as const
type Coefficients = Record<ColorPrimaries, readonly number[]>
interface Frame {
  width: number
  height: number
  data: Float32Array
}
interface Scene {
  name: string
  clean: Frame
  entering: Frame
  luminance: number
  chroma: number
}
type Operator = 'noise' | 'sharpen'
type Order = 'before' | 'after'
interface Measurement {
  samples: number
  beforeSse: number[]
  afterSse: number[]
  errorSum: number[]
  textureNumerator: number
  enteringTextureNumerator: number
  textureDenominator: number
  rgbSse: number
  gradientNumerator: number
  gradientDenominator: number
  centralSlopeGain?: number
}
interface Row extends Measurement {
  primaries: ColorPrimaries
  seed: number
  operator: Operator
  context: string
  order: Order
  scene: string
  enteringSha256: string
  outputSha256: string
  editedRgbRms?: number
}
const hash = (frame: Frame) =>
  createHash('sha256')
    .update(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength))
    .digest('hex')
class Noise {
  constructor(private state: number) {}
  uniform() {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0
    return (this.state + 0.5) / 4294967296
  }
  normal() {
    return Math.sqrt(-2 * Math.log(this.uniform())) * Math.cos(2 * Math.PI * this.uniform())
  }
}
function rgb(l: number, a: number, b: number, coefficients: readonly number[]) {
  const y = 0.18 * Math.sinh(l),
    s = Math.hypot(y, 0.18),
    u = s * Math.sinh(a),
    v = s * Math.sinh(b)
  return [y + u, y - (coefficients[0] * u + coefficients[2] * v) / coefficients[1], y + v, 1]
}
export function placementScenes(seed: number, coefficients: readonly number[]): Scene[] {
  return ['flat-luminance', 'flat-chroma', 'period-2', 'period-4', 'soft-edge'].map((name) => {
    const width = 32,
      height = 24,
      clean = new Float32Array(width * height * 4),
      entering = new Float32Array(clean.length),
      noise = new Noise(seed)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let l = 1,
          a = 0.08,
          b = -0.04
        if (name === 'period-2') l += 0.024 * (x % 2 ? -1 : 1)
        if (name === 'period-4') l += 0.03 * Math.sin((2 * Math.PI * x) / 4)
        if (name === 'soft-edge') {
          l = 0.7 + 0.35 * Math.tanh(x + 0.5 - 16)
          a = b = 0
        }
        const sl = name === 'flat-chroma' || name === 'soft-edge' ? 0 : 0.012,
          sc = name === 'flat-chroma' ? 0.012 : 0,
          nl = noise.normal(),
          na = noise.normal(),
          nb = noise.normal()
        clean.set(rgb(l, a, b, coefficients), (y * width + x) * 4)
        entering.set(rgb(l + sl * nl, a + sc * na, b + sc * nb, coefficients), (y * width + x) * 4)
      }
    return {
      name,
      clean: { width, height, data: clean },
      entering: { width, height, data: entering },
      luminance: name === 'flat-chroma' ? 0 : 50,
      chroma: name === 'flat-chroma' ? 50 : 0,
    }
  })
}
const profile: WhiteBalanceProfile = {
  provider: 'synthetic-order-study',
  version: '1',
  identity: 'synthetic-order-study-1',
  model: WHITE_BALANCE_MODEL,
  asShotGains: [2, 1, 1.5],
  xyzToCamera: [0.7, 0.2, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8],
  cameraToWorking: [1.4, -0.3, -0.1, -0.1, 1.2, -0.1, 0, -0.1, 1.1],
  ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
  estimate: { kelvin: 6500, tint: 0 },
}
function transform(frame: Frame, matrix: number[] | null): Frame {
  if (!matrix) return frame
  const data = new Float32Array(frame.data.length)
  for (let i = 0; i < data.length; i += 4) {
    for (let row = 0; row < 3; row++)
      data[i + row] =
        matrix[row * 3] * frame.data[i] +
        matrix[row * 3 + 1] * frame.data[i + 1] +
        matrix[row * 3 + 2] * frame.data[i + 2]
    data[i + 3] = frame.data[i + 3]
  }
  return { ...frame, data }
}
function filter(frame: Frame, scene: Scene, operator: Operator, primaries: ColorPrimaries): Frame {
  const tile = { left: 0, top: 0, width: frame.width, height: frame.height },
    source = { ...tile, data: frame.data }
  return {
    ...frame,
    data:
      operator === 'noise'
        ? denoiseDetailTile(
            frame,
            tile,
            source,
            compileNoiseReduction({ version: 1, luminance: scene.luminance, chroma: scene.chroma }),
            primaries,
          )
        : sharpenDetailTile(
            frame,
            tile,
            source,
            compileDetailSharpening({ version: 1, amount: 50, radius: 1, threshold: 50 }),
            primaries,
          ),
  }
}
function feature(data: Float32Array, at: number, coefficients: readonly number[]) {
  const y =
      data[at] * coefficients[0] + data[at + 1] * coefficients[1] + data[at + 2] * coefficients[2],
    s = Math.hypot(y, 0.18)
  return [Math.asinh(y / 0.18), Math.asinh((data[at] - y) / s), Math.asinh((data[at + 2] - y) / s)]
}
function measure(
  clean: Frame,
  entering: Frame,
  output: Frame,
  coefficients: readonly number[],
): Measurement {
  const beforeSse = [0, 0, 0],
    afterSse = [0, 0, 0],
    errorSum = [0, 0, 0],
    truth: number[] = [],
    input: number[] = [],
    filtered: number[] = []
  let rgbSse = 0,
    gradientNumerator = 0,
    gradientDenominator = 0
  const yAt = (frame: Frame, at: number) =>
    frame.data[at] * coefficients[0] +
    frame.data[at + 1] * coefficients[1] +
    frame.data[at + 2] * coefficients[2]
  for (let y = 4; y < clean.height - 4; y++)
    for (let x = 4; x < clean.width - 4; x++) {
      const at = (y * clean.width + x) * 4,
        c = feature(clean.data, at, coefficients),
        e = feature(entering.data, at, coefficients),
        o = feature(output.data, at, coefficients)
      truth.push(c[0])
      input.push(e[0])
      filtered.push(o[0])
      for (let channel = 0; channel < 3; channel++) {
        beforeSse[channel] += (e[channel] - c[channel]) ** 2
        afterSse[channel] += (o[channel] - c[channel]) ** 2
        errorSum[channel] += o[channel] - c[channel]
        rgbSse += (output.data[at + channel] - clean.data[at + channel]) ** 2
      }
      for (const offset of [4, clean.width * 4]) {
        const dc = yAt(clean, at + offset) - yAt(clean, at),
          df = yAt(output, at + offset) - yAt(output, at)
        gradientNumerator += dc * df
        gradientDenominator += dc * dc
      }
    }
  const samples = truth.length,
    mean = (v: number[]) => v.reduce((sum, value) => sum + value, 0) / samples,
    mc = mean(truth),
    me = mean(input),
    mo = mean(filtered)
  let textureNumerator = 0,
    enteringTextureNumerator = 0,
    textureDenominator = 0
  for (let i = 0; i < samples; i++) {
    const p = truth[i] - mc
    textureNumerator += (filtered[i] - mo) * p
    enteringTextureNumerator += (input[i] - me) * p
    textureDenominator += p * p
  }
  const center = (Math.floor(clean.height / 2) * clean.width + Math.floor(clean.width / 2)) * 4,
    centralSlopeGain =
      (yAt(output, center) - yAt(output, center - 4)) /
      (yAt(clean, center) - yAt(clean, center - 4))
  return {
    samples,
    beforeSse,
    afterSse,
    errorSum,
    textureNumerator,
    enteringTextureNumerator,
    textureDenominator,
    rgbSse,
    gradientNumerator,
    gradientDenominator,
    centralSlopeGain: Number.isFinite(centralSlopeGain) ? centralSlopeGain : undefined,
  }
}
function maximumRatio(a: Frame, b: Frame, margin = 0): number {
  let maximum = 0
  for (let y = margin; y < a.height - margin; y++)
    for (let x = margin; x < a.width - margin; x++)
      for (let channel = 0; channel < 3; channel++) {
        const i = (y * a.width + x) * 4 + channel
        maximum = Math.max(
          maximum,
          Math.abs(a.data[i] - b.data[i]) / (2e-6 + 2e-5 * Math.abs(a.data[i])),
        )
      }
  return maximum
}
export function detailPlacementStudy(coefficients: Coefficients) {
  const started = performance.now(),
    rows: Row[] = [],
    geometryDiagnostics: {
      primaries: ColorPrimaries
      seed: number
      operator: Operator
      scene: string
      kind: string
      maximumRatio: number
      interiorMaximumRatio: number
    }[] = [],
    wb: { name: string; value: WhiteBalance; matrix: number[] | null }[] = [
      { name: 'as-shot', value: { mode: 'as-shot' }, matrix: null },
      ...[
        { kelvin: 2800, tint: -25 },
        { kelvin: 6500, tint: 0 },
        { kelvin: 12000, tint: 35 },
      ].map((value) => ({
        name: `${value.kelvin}-${value.tint}`,
        value: { mode: 'custom' as const, ...value },
        matrix: whiteBalanceMatrix({ mode: 'custom', ...value }, profile),
      })),
    ]
  for (const primaries of ['srgb', 'rec2020'] as const)
    for (const seed of placementSeeds)
      for (const scene of placementScenes(seed, coefficients[primaries])) {
        const operators: Operator[] =
          scene.name === 'soft-edge'
            ? ['sharpen']
            : scene.name === 'flat-luminance'
              ? ['noise', 'sharpen']
              : ['noise']
        for (const operator of operators) {
          const native = filter(scene.entering, scene, operator, primaries),
            add = (
              context: string,
              order: Order,
              clean: Frame,
              entering: Frame,
              output: Frame,
              editedRgbRms?: number,
            ) =>
              rows.push({
                primaries,
                seed,
                operator,
                context,
                order,
                scene: scene.name,
                enteringSha256: hash(entering),
                outputSha256: hash(output),
                editedRgbRms,
                ...measure(clean, entering, output, coefficients[primaries]),
              })
          for (const balance of wb) {
            const editedClean = transform(scene.clean, balance.matrix),
              editedInput = transform(scene.entering, balance.matrix),
              inverse = balance.matrix ? inverseMatrix(balance.matrix) : null,
              beforeEdited = transform(native, balance.matrix),
              afterEdited = balance.matrix
                ? filter(editedInput, scene, operator, primaries)
                : native
            for (const [order, edited] of [
              ['before', beforeEdited],
              ['after', afterEdited],
            ] as const)
              add(
                `wb/${balance.name}`,
                order,
                scene.clean,
                scene.entering,
                transform(edited, inverse),
                Math.sqrt(
                  measure(editedClean, editedInput, edited, coefficients[primaries]).rgbSse /
                    ((edited.width - 8) * (edited.height - 8) * 3),
                ),
              )
          }
          for (const [kind, settings] of [
            ['integer-crop', { ...identityCrop, width: 0.75, height: 2 / 3 }],
            [
              'rotate-7',
              fitCrop(scene.clean, {
                ...identityCrop,
                angle: 7,
                centerX: 0.503,
                centerY: 0.487,
                width: 0.75,
                height: 2 / 3,
              }),
            ],
            ['quarter-turn', { ...identityCrop, quarterTurns: 1 as const }],
          ] as const) {
            const geometry = cropGeometry(scene.clean, settings),
              tile = { left: 0, top: 0, width: geometry.width, height: geometry.height },
              crop = (frame: Frame): Frame => ({
                width: geometry.width,
                height: geometry.height,
                data: resampleCropTile(geometry, tile, {
                  left: 0,
                  top: 0,
                  width: frame.width,
                  height: frame.height,
                  data: frame.data,
                }),
              }),
              clean = crop(scene.clean),
              entering = crop(scene.entering),
              before = crop(native),
              after = filter(entering, scene, operator, primaries)
            add(`geometry/${kind}`, 'before', clean, entering, before)
            add(`geometry/${kind}`, 'after', clean, entering, after)
            geometryDiagnostics.push({
              primaries,
              seed,
              operator,
              scene: scene.name,
              kind,
              maximumRatio: maximumRatio(before, after),
              interiorMaximumRatio: maximumRatio(before, after, operator === 'noise' ? 4 : 3),
            })
          }
        }
      }
  const grouped = new Map<string, Row[]>()
  for (const row of rows) {
    const key = [row.primaries, row.operator, row.context, row.order, row.scene].join(':')
    const group = grouped.get(key) ?? []
    group.push(row)
    grouped.set(key, group)
  }
  const aggregates = [...grouped.entries()].map(([key, group]) => {
    const first = group[0],
      sum = (get: (row: Row) => number) => group.reduce((total, row) => total + get(row), 0),
      samples = sum((row) => row.samples),
      rmsRatio = (after: number, before: number) =>
        before > 1e-14 * samples ? Math.sqrt(after / before) : null,
      luminanceRmsRatio = rmsRatio(
        sum((row) => row.afterSse[0]),
        sum((row) => row.beforeSse[0]),
      ),
      chromaRmsRatio = rmsRatio(
        sum((row) => row.afterSse[1] + row.afterSse[2]),
        sum((row) => row.beforeSse[1] + row.beforeSse[2]),
      ),
      bias = [0, 1, 2].map((c) => sum((row) => row.errorSum[c]) / samples),
      textureRetention = first.scene.startsWith('period-')
        ? sum((row) => row.textureNumerator) / sum((row) => row.textureDenominator)
        : null,
      enteringTextureRetention = first.scene.startsWith('period-')
        ? sum((row) => row.enteringTextureNumerator) / sum((row) => row.textureDenominator)
        : null,
      gradientGain =
        first.scene === 'soft-edge'
          ? sum((row) => row.gradientNumerator) / sum((row) => row.gradientDenominator)
          : null,
      gates: Record<string, boolean> = {}
    if (first.scene === 'flat-luminance') {
      gates.noise =
        luminanceRmsRatio !== null && luminanceRmsRatio <= (first.operator === 'noise' ? 0.55 : 1.1)
      if (first.operator === 'noise') gates.bias = Math.abs(bias[0]) <= 0.003
    }
    if (first.scene === 'flat-chroma') {
      gates.noise = chromaRmsRatio !== null && chromaRmsRatio <= 0.45
      gates.bias = Math.max(Math.abs(bias[1]), Math.abs(bias[2])) <= 0.003
    }
    if (first.scene.startsWith('period-'))
      gates.texture =
        textureRetention !== null && textureRetention >= 0.9 && textureRetention <= 1.05
    if (first.scene === 'soft-edge' && first.context.startsWith('wb/'))
      gates.softEdge = group.every((row) => row.centralSlopeGain! >= 1.05)
    return {
      key,
      primaries: first.primaries,
      operator: first.operator,
      context: first.context,
      order: first.order,
      scene: first.scene,
      seeds: group.map((row) => row.seed),
      samples,
      luminanceRmsRatio,
      chromaRmsRatio,
      meanBias: bias,
      textureRetention,
      enteringTextureRetention,
      gradientGain,
      centralSlopeGains: group.map((row) => row.centralSlopeGain),
      gates,
    }
  })
  return {
    version: DETAIL_PLACEMENT_VERSION,
    operatorVersion: SPATIAL_DETAIL_VERSION,
    cropGeometryVersion: CROP_GEOMETRY_VERSION,
    cropFilterVersion: CROP_FILTER_VERSION,
    license: 'CC0-1.0',
    seeds: placementSeeds,
    profile,
    coefficients,
    wb,
    perSeed: rows,
    aggregates,
    geometryDiagnostics,
    missingRatioMeaning:
      'Null means no relevant reference energy, texture or soft-edge measurement; required gates reject an unavailable measurement.',
    elapsedSeconds: (performance.now() - started) / 1000,
    limitations: [
      'Small synthetic native fields only',
      'WB profile is synthetic, not camera calibration',
      'Known-truth recipes and coefficients are independent; operator composition uses already referenced production kernels',
      'No real-source, foreground or full-size performance acceptance',
      'After-visible-geometry does not retain off-crop neighbors',
    ],
  }
}
