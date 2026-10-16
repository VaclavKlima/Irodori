import {
  DISPLAY_RENDERING_VERSION,
  renderDisplay,
  type RenderingRGB,
  type RenderingTarget,
} from '../../../src/shared/display-rendering.ts'
import { digest } from './contract.ts'

/** Explicit preview approximation, never registered as an exact graph operation. */
export class PreviewLut {
  readonly data: Float32Array
  readonly identity: string
  fallbackCount = 0
  readonly lower = -0.25
  readonly upper = 64
  private low = Math.asinh(this.lower * 16)
  private high = Math.asinh(this.upper * 16)
  constructor(
    readonly edge: number,
    readonly target: RenderingTarget,
  ) {
    if (!Number.isInteger(edge) || edge < 3 || edge > 65)
      throw new Error('Invalid preview LUT dimension.')
    this.data = new Float32Array(edge ** 3 * 4)
    for (let b = 0; b < edge; b++)
      for (let g = 0; g < edge; g++)
        for (let r = 0; r < edge; r++) {
          const values = [r, g, b].map((v) => this.unshape(v / (edge - 1))) as RenderingRGB
          const rgb = renderDisplay(values, target).rgb
          this.data.set([...rgb, 1], ((b * edge + g) * edge + r) * 4)
        }
    this.identity = digest({
      rendering: DISPLAY_RENDERING_VERSION,
      target,
      edge,
      shaper: 'asinh16-v1',
      range: [this.lower, this.upper],
      interpolation: 'trilinear',
      policy: 'preview-only',
    })
  }
  private unshape(v: number) {
    return Math.sinh(this.low + v * (this.high - this.low)) / 16
  }
  sample(rgb: RenderingRGB, purpose: 'preview' | 'export' = 'preview'): RenderingRGB {
    if (purpose !== 'preview') throw new Error('Approximate LUT output is forbidden for export.')
    if (rgb.some((v) => !Number.isFinite(v))) throw new Error('Invalid LUT input.')
    if (rgb.some((v) => v < this.lower || v > this.upper)) {
      this.fallbackCount++
      return renderDisplay(rgb, this.target).rgb
    }
    const point = rgb.map((v) =>
      Math.max(
        0,
        Math.min(
          this.edge - 1,
          ((Math.asinh(v * 16) - this.low) / (this.high - this.low)) * (this.edge - 1),
        ),
      ),
    )
    const base = point.map(Math.floor),
      fraction = point.map((v, c) => v - base[c])
    const result: RenderingRGB = [0, 0, 0]
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const weight =
            (x ? fraction[0] : 1 - fraction[0]) *
            (y ? fraction[1] : 1 - fraction[1]) *
            (z ? fraction[2] : 1 - fraction[2])
          const index =
            ((Math.min(this.edge - 1, base[2] + z) * this.edge +
              Math.min(this.edge - 1, base[1] + y)) *
              this.edge +
              Math.min(this.edge - 1, base[0] + x)) *
            4
          for (let c = 0; c < 3; c++) result[c] += this.data[index + c] * weight
        }
    return result
  }
}
