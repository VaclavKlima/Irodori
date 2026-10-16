import type { EditSettings } from '../../../src/shared/edits.ts'
import { type ImageSpec, type Json, type Recipe, type RecipeNode } from './contract.ts'
import { ResearchAssets } from './assets.ts'

export const imageSpec = (width = 128, height = 96): ImageSpec => ({
  width,
  height,
  channels: 4,
  domain: 'scene-linear-rec2020',
  precision: 'float32',
  alpha: 'straight-preserved',
  coordinates: 'source-pixels-v1',
})
export function pattern(spec: ImageSpec) {
  const data = new Float32Array(spec.width * spec.height * 4)
  for (let y = 0; y < spec.height; y++)
    for (let x = 0; x < spec.width; x++) {
      const at = (y * spec.width + x) * 4
      data[at] = (x % 2 ? 0.8 : 0.02) + (x / spec.width) * 2
      data[at + 1] = (y % 3 ? 0.3 : -0.03) + y / spec.height
      data[at + 2] =
        x === Math.floor(spec.width / 2) && y === Math.floor(spec.height / 2) ? 16 : 0.1
      data[at + 3] = (x + y) % 7 ? 1 : 0.25
    }
  return data
}
export function node(
  id: string,
  operation: string,
  inputs: Record<string, string>,
  output: ImageSpec,
  parameters: Record<string, Json> = {},
  cache: RecipeNode['cache'] = 'reusable',
): RecipeNode {
  return { id, operation, version: 1, inputs, output: structuredClone(output), parameters, cache }
}
export function workloads(assets = new ResearchAssets(), spec = imageSpec(), data = pattern(spec)) {
  const hash = assets.addImage(spec, data)
  const maskHash = assets.addMask({
    version: 1,
    coordinates: 'normalized-source-v1',
    center: [0.4, 0.5],
    radius: 0.24,
    feather: 0.6,
  })
  const maskSpec: ImageSpec = {
    ...spec,
    channels: 1,
    domain: 'coverage',
    alpha: 'separate-coverage',
  }
  const s = node('source', 'source', {}, spec, { asset: hash })
  const second = data.slice()
  for (let i = 0; i < second.length; i += 4) second[i] *= 0.6
  const secondHash = assets.addImage(spec, second)
  const s2 = node('second-source', 'source', {}, spec, { asset: secondHash })
  const e = node('exposure', 'exposure', { image: s.id }, spec, { ev: 0.7 })
  const m = node('mask', 'radial-mask', {}, maskSpec, { asset: maskHash })
  const local = node('local', 'blend', { base: s.id, effect: e.id, mask: m.id }, spec)
  const recipe = (nodes: RecipeNode[], output = nodes.at(-1)!.id): Recipe => ({
    version: 1,
    sourceHash: hash,
    nodes,
    output,
    assets: [maskHash],
  })
  const grading = node('grading', 'grading', { image: e.id }, spec, { amount: 0.25 })
  const makeBlur = (radius: number) => [
    node('blur-x', 'blur-x', { image: s.id }, spec, { radius }),
    node('blur-y', 'blur-y', { image: 'blur-x' }, spec, { radius }),
  ]
  const b = makeBlur(3)
  const maskedBlur = node('masked', 'blend', { base: s.id, effect: 'blur-y', mask: m.id }, spec)
  const analysis: ImageSpec = {
    width: 66,
    height: 1,
    channels: 1,
    domain: 'analysis',
    precision: 'float32',
    alpha: 'none',
    coordinates: 'histogram-log2-v1',
  }
  const a = node('histogram', 'histogram', { image: s.id }, analysis)
  const auto = node('auto', 'analysis-exposure', { image: s.id, analysis: a.id }, spec, {
    target: 0.18,
  })
  const geometry = {
    orientation: 90,
    lensK1: 0.08,
    crop: { x: 3, y: 5, width: spec.height - 6, height: spec.width - 10 },
  }
  const warped = {
    ...spec,
    width: geometry.crop.width,
    height: geometry.crop.height,
    coordinates: 'oriented-lens-crop-v1',
  }
  const warp = node('warp-image', 'warp', { image: s.id }, warped, { geometry })
  const warpMask = node(
    'warp-mask',
    'warp-mask',
    { image: m.id },
    {
      ...maskSpec,
      ...{ width: warped.width, height: warped.height, coordinates: warped.coordinates },
    },
    { geometry },
  )
  const warpExposure = node('warp-exposure', 'exposure', { image: warp.id }, warped, { ev: 0.7 })
  return {
    assets,
    spec,
    data,
    maskHash,
    sourceHash: hash,
    recipes: {
      grading: recipe([s, e, grading]),
      fused: recipe([s, { ...e, cache: 'transient' }, grading]),
      local: recipe([s, e, m, local]),
      ...Object.fromEntries(
        [0, 1, 3, 9].map((radius) => [`blur-${radius}`, recipe([s, ...makeBlur(radius)])]),
      ),
      masked: recipe([
        s,
        m,
        ...b,
        maskedBlur,
        node('grade', 'grading', { image: maskedBlur.id }, spec, { amount: 0.25 }),
      ]),
      geometry: recipe([
        s,
        m,
        warp,
        warpMask,
        warpExposure,
        node(
          'registered',
          'blend',
          { base: warp.id, effect: warpExposure.id, mask: warpMask.id },
          warped,
        ),
      ]),
      analysis: recipe([
        s,
        a,
        auto,
        node('grade', 'grading', { image: auto.id }, spec, { amount: 0.25 }),
      ]),
      multiple: recipe([s, s2, node('average', 'average', { first: s.id, second: s2.id }, spec)]),
    } as Record<string, Recipe>,
  }
}
/** Preserve all current settings as an opaque boundary; never approximate unsupported edits. */
export function adaptLegacy(
  settings: EditSettings,
  sourceHash: string,
  prepared: ImageSpec,
): Recipe {
  const s = node('prepared-current-settings', 'source', {}, prepared, { asset: sourceHash })
  return {
    version: 1,
    sourceHash,
    nodes: [s],
    output: s.id,
    assets: [],
    legacySettings: structuredClone(settings) as unknown as Json,
  }
}
