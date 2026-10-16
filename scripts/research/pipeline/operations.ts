import {
  canonical,
  sample,
  whole,
  type Frame,
  type ImageSpec,
  type Operation,
  type OperationContext,
  type RecipeNode,
} from './contract.ts'
import { geometry, outputToSource } from './geometry.ts'

const requirements = {
  precision: 'float32',
  domain: 'scene-linear-rec2020',
  alpha: 'straight-preserved',
} as const
const sameSize = (a: ImageSpec, b: ImageSpec) =>
  a.width === b.width && a.height === b.height && a.coordinates === b.coordinates
const requireInputs = (n: RecipeNode, names: string[]) => {
  if (canonical(Object.keys(n.inputs).sort()) !== canonical(names.sort()))
    throw new Error(`Invalid ${n.operation} input contract.`)
}
const imageInput = (n: RecipeNode, inputs: Record<string, ImageSpec>) => {
  requireInputs(n, ['image'])
  if (canonical(inputs.image) !== canonical(n.output))
    throw new Error('Pointwise/spatial image contract mismatch.')
}
const number = (n: RecipeNode, name: string, min: number, max: number) => {
  const v = n.parameters[name]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`Invalid ${name}.`)
  return v
}
function pixelKernel(point: NonNullable<Operation['point']>) {
  return ({ node, inputs, output }: OperationContext) => {
    const pixel = new Array<number>(node.output.channels)
    for (let i = 0; i < output.length; i += pixel.length) {
      for (let c = 0; c < pixel.length; c++) pixel[c] = inputs.image.data[i + c]
      point(pixel, node)
      output.set(pixel, i)
    }
  }
}
const exposurePoint: NonNullable<Operation['point']> = (pixel, node) => {
  const gain = 2 ** (node.parameters.ev as number)
  for (let c = 0; c < 3; c++) pixel[c] *= gain
}
const gradingPoint: NonNullable<Operation['point']> = (pixel, node) => {
  const amount = node.parameters.amount as number
  for (let c = 0; c < 3; c++) {
    const v = pixel[c]
    pixel[c] = v + (amount * v * Math.abs(v)) / (1 + Math.abs(v))
  }
}
export const source: Operation = {
  name: 'source',
  version: 1,
  kind: 'source',
  implementations: { cpu: 'owned-source-region-v1' },
  requirements,
  validate(n, inputs, assets) {
    requireInputs(n, [])
    if (
      Object.keys(inputs).length ||
      typeof n.parameters.asset !== 'string' ||
      canonical(assets.image(n.parameters.asset).spec) !== canonical(n.output)
    )
      throw new Error('Invalid source contract.')
  },
  inputRegions: () => ({}),
  cpu({ node, region, output, assets }) {
    const input = assets.image(node.parameters.asset as string)
    for (let y = 0; y < region.height; y++)
      for (let x = 0; x < region.width; x++)
        for (let c = 0; c < node.output.channels; c++)
          output[(y * region.width + x) * node.output.channels + c] = sample(
            input,
            x + region.x,
            y + region.y,
            c,
          )
  },
}
export const exposure: Operation = {
  name: 'exposure',
  version: 1,
  kind: 'pointwise',
  implementations: { cpu: 'float32-ordered-ev-v1' },
  requirements,
  validate(n, inputs) {
    imageInput(n, inputs)
    number(n, 'ev', -5, 5)
  },
  inputRegions: (_n, r) => ({ image: r }),
  point: exposurePoint,
  cpu: pixelKernel(exposurePoint),
}
export const grading: Operation = {
  name: 'grading',
  version: 1,
  kind: 'pointwise',
  implementations: { cpu: 'signed-rational-curve-v1' },
  requirements,
  validate(n, inputs) {
    imageInput(n, inputs)
    number(n, 'amount', -0.9, 1)
  },
  inputRegions: (_n, r) => ({ image: r }),
  point: gradingPoint,
  cpu: pixelKernel(gradingPoint),
}
export const radialMask: Operation = {
  name: 'radial-mask',
  version: 1,
  kind: 'source',
  implementations: { cpu: 'source-pixel-feather-v1' },
  requirements: { precision: 'float32', domain: 'coverage', alpha: 'separate-coverage' },
  assetReferences: (n) => [n.parameters.asset as string],
  validate(n, _inputs, assets) {
    requireInputs(n, [])
    if (
      n.output.channels !== 1 ||
      n.output.coordinates !== 'source-pixels-v1' ||
      typeof n.parameters.asset !== 'string'
    )
      throw new Error('Invalid mask contract.')
    assets.mask(n.parameters.asset)
  },
  fingerprint(n, r, assets) {
    const m = assets.mask(n.parameters.asset as string),
      s = n.output
    const cx = m.center[0] * s.width - 0.5,
      cy = m.center[1] * s.height - 0.5,
      radius = m.radius * Math.min(s.width, s.height)
    const dx = Math.max(r.x - cx, 0, cx - (r.x + r.width - 1)),
      dy = Math.max(r.y - cy, 0, cy - (r.y + r.height - 1))
    return Math.hypot(dx, dy) > radius ? 'zero-coverage-v1' : n.parameters
  },
  inputRegions: () => ({}),
  cpu({ node, region, assets, output }) {
    const m = assets.mask(node.parameters.asset as string),
      s = node.output
    const radius = m.radius * Math.min(s.width, s.height),
      feather = radius * m.feather
    for (let y = 0; y < region.height; y++)
      for (let x = 0; x < region.width; x++) {
        const distance = Math.hypot(
          x + region.x + 0.5 - m.center[0] * s.width,
          y + region.y + 0.5 - m.center[1] * s.height,
        )
        const t =
          feather === 0
            ? Number(distance < radius)
            : Math.max(0, Math.min(1, (radius - distance) / feather))
        output[y * region.width + x] = t * t * (3 - 2 * t)
      }
  },
}
export const blend: Operation = {
  name: 'blend',
  version: 1,
  kind: 'blend',
  implementations: { cpu: 'linear-separate-coverage-v1' },
  requirements,
  validate(n, inputs) {
    requireInputs(n, ['base', 'effect', 'mask'])
    if (
      canonical(inputs.base) !== canonical(n.output) ||
      canonical(inputs.effect) !== canonical(n.output) ||
      !sameSize(inputs.mask, n.output) ||
      inputs.mask.domain !== 'coverage' ||
      inputs.mask.channels !== 1
    )
      throw new Error('Invalid blend contract.')
  },
  inputRegions: (_n, r) => ({ base: r, effect: r, mask: r }),
  cpu({ inputs, output }) {
    for (let i = 0; i < inputs.mask.data.length; i++) {
      const coverage = inputs.mask.data[i]
      if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1)
        throw new Error('Invalid mask coverage.')
      for (let c = 0; c < 3; c++)
        output[i * 4 + c] =
          inputs.base.data[i * 4 + c] * (1 - coverage) + inputs.effect.data[i * 4 + c] * coverage
      output[i * 4 + 3] = inputs.base.data[i * 4 + 3]
    }
  },
}
export function blur(axis: 'x' | 'y'): Operation {
  return {
    name: `blur-${axis}`,
    version: 1,
    kind: 'neighborhood',
    implementations: { cpu: 'separable-source-pixel-box-v1' },
    requirements,
    validate(n, inputs) {
      imageInput(n, inputs)
      if (!Number.isInteger(number(n, 'radius', 0, 64)))
        throw new Error('Radius uses integer source pixels.')
    },
    inputRegions(n, r, inputs) {
      const radius = n.parameters.radius as number
      const x = Math.max(0, r.x - (axis === 'x' ? radius : 0)),
        y = Math.max(0, r.y - (axis === 'y' ? radius : 0))
      return {
        image: {
          x,
          y,
          width: Math.min(inputs.image.width, r.x + r.width + (axis === 'x' ? radius : 0)) - x,
          height: Math.min(inputs.image.height, r.y + r.height + (axis === 'y' ? radius : 0)) - y,
        },
      }
    },
    cpu({ node, region, inputs, output, signal }) {
      const radius = node.parameters.radius as number
      for (let y = 0; y < region.height; y++) {
        signal?.throwIfAborted()
        for (let x = 0; x < region.width; x++)
          for (let c = 0; c < 4; c++) {
            const at = (y * region.width + x) * 4 + c
            if (c === 3) {
              output[at] = sample(inputs.image, region.x + x, region.y + y, c)
              continue
            }
            let sum = 0
            for (let d = -radius; d <= radius; d++)
              sum += sample(
                inputs.image,
                region.x + x + (axis === 'x' ? d : 0),
                region.y + y + (axis === 'y' ? d : 0),
                c,
              )
            output[at] = sum / (radius * 2 + 1)
          }
      }
    },
  }
}
function bilinear(input: Frame, x: number, y: number, c: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy
  return (
    (sample(input, ix, iy, c) * (1 - fx) + sample(input, ix + 1, iy, c) * fx) * (1 - fy) +
    (sample(input, ix, iy + 1, c) * (1 - fx) + sample(input, ix + 1, iy + 1, c) * fx) * fy
  )
}
export function warp(mask = false): Operation {
  return {
    name: mask ? 'warp-mask' : 'warp',
    version: 1,
    kind: 'geometry',
    implementations: { cpu: 'explicit-bilinear-inverse-v1' },
    requirements: mask ? radialMask.requirements : requirements,
    validate(n, inputs) {
      requireInputs(n, ['image'])
      if (inputs.image.domain !== n.output.domain || inputs.image.channels !== n.output.channels)
        throw new Error('Geometry color/channel mismatch.')
      geometry(n.parameters.geometry, inputs.image, n.output)
    },
    inputRegions(n, r, inputs) {
      const s = inputs.image,
        g = geometry(n.parameters.geometry, s, n.output)
      // For |k1| <= .3 the radial map is monotone along its matching axis
      // (derivative >= 1 - 3*.3). Other-axis extrema occur at an edge or the
      // optical center. Include those center crossings, then the bilinear halo.
      const swapped = g.orientation === 90 || g.orientation === 270
      const centerX = ((swapped ? s.height : s.width) - 1) / 2 - g.crop.x
      const centerY = ((swapped ? s.width : s.height) - 1) / 2 - g.crop.y
      const xs = [r.x, r.x + r.width - 1],
        ys = [r.y, r.y + r.height - 1]
      if (centerX > xs[0] && centerX < xs[1]) xs.push(centerX)
      if (centerY > ys[0] && centerY < ys[1]) ys.push(centerY)
      const points = xs.flatMap((x) => ys.map((y) => outputToSource(x, y, s, g)))
      const x = Math.max(
          0,
          Math.min(s.width - 1, Math.floor(Math.min(...points.map((p) => p[0])))),
        ),
        y = Math.max(0, Math.min(s.height - 1, Math.floor(Math.min(...points.map((p) => p[1])))))
      return {
        image: {
          x,
          y,
          width:
            Math.min(
              s.width,
              Math.ceil(Math.max(0, Math.min(s.width - 1, Math.max(...points.map((p) => p[0]))))) +
                2,
            ) - x,
          height:
            Math.min(
              s.height,
              Math.ceil(Math.max(0, Math.min(s.height - 1, Math.max(...points.map((p) => p[1]))))) +
                2,
            ) - y,
        },
      }
    },
    cpu({ node, region, inputs, output }) {
      const g = geometry(node.parameters.geometry, inputs.image.spec, node.output)
      for (let y = 0; y < region.height; y++)
        for (let x = 0; x < region.width; x++) {
          const p = outputToSource(x + region.x, y + region.y, inputs.image.spec, g)
          for (let c = 0; c < node.output.channels; c++)
            output[(y * region.width + x) * node.output.channels + c] = bilinear(
              inputs.image,
              p[0],
              p[1],
              c,
            )
        }
    },
  }
}
export const histogram: Operation = {
  name: 'histogram',
  version: 1,
  kind: 'analysis',
  implementations: { cpu: 'streamed-linear-luminance-v1' },
  requirements: { precision: 'float32', domain: 'analysis', alpha: 'none' },
  validate(n, inputs) {
    requireInputs(n, ['image'])
    if (
      inputs.image.domain !== 'scene-linear-rec2020' ||
      n.output.width !== 66 ||
      n.output.height !== 1 ||
      n.output.channels !== 1
    )
      throw new Error('Invalid histogram contract.')
  },
  inputRegions: (_n, _r, inputs) => ({ image: whole(inputs.image) }),
  cpu: () => {
    throw new Error('Analysis must stream.')
  },
  reduction: {
    create: () => new Float64Array(66),
    add(state, input) {
      for (let i = 0; i < input.data.length; i += 4) {
        const luminance = Math.max(
          0,
          input.data[i] * 0.2627 + input.data[i + 1] * 0.678 + input.data[i + 2] * 0.0593,
        )
        const bin = Math.max(
          0,
          Math.min(63, Math.floor((Math.log2(Math.max(2 ** -16, luminance)) + 16) * 2)),
        )
        state[bin]++
        state[64] += luminance
        state[65]++
      }
    },
    finish(state, output) {
      output.set(state)
      output[64] /= Math.max(1, state[65])
    },
  },
}
export const analysisExposure: Operation = {
  name: 'analysis-exposure',
  version: 1,
  kind: 'pointwise',
  implementations: { cpu: 'bounded-mean-exposure-v1' },
  requirements,
  validate(n, inputs) {
    requireInputs(n, ['image', 'analysis'])
    if (
      canonical(inputs.image) !== canonical(n.output) ||
      inputs.analysis.domain !== 'analysis' ||
      inputs.analysis.width !== 66
    )
      throw new Error('Invalid analysis dependency.')
    number(n, 'target', 0.01, 1)
  },
  inputRegions: (_n, r, inputs) => ({ image: r, analysis: whole(inputs.analysis) }),
  cpu({ node, inputs, output }) {
    const gain = Math.max(
      1 / 32,
      Math.min(32, (node.parameters.target as number) / Math.max(1e-6, inputs.analysis.data[64])),
    )
    for (let i = 0; i < output.length; i++)
      output[i] = inputs.image.data[i] * (i % 4 === 3 ? 1 : gain)
  },
}
export const average: Operation = {
  name: 'average',
  version: 1,
  kind: 'blend',
  implementations: { cpu: 'ordered-multi-image-mean-v1' },
  requirements,
  validate(n, inputs) {
    if (
      Object.keys(inputs).length < 2 ||
      Object.values(inputs).some((s) => canonical(s) !== canonical(n.output))
    )
      throw new Error('Invalid multiple-image input.')
  },
  inputRegions: (_n, r, inputs) => Object.fromEntries(Object.keys(inputs).map((key) => [key, r])),
  cpu({ inputs, output }) {
    const frames = Object.values(inputs)
    for (let i = 0; i < output.length; i++)
      output[i] = frames.reduce((sum, f) => sum + f.data[i], 0) / frames.length
  },
}
export const operations = [
  source,
  exposure,
  grading,
  radialMask,
  blend,
  blur('x'),
  blur('y'),
  warp(),
  warp(true),
  histogram,
  analysisExposure,
  average,
]
