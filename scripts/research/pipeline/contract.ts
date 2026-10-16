import { createHash } from 'node:crypto'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Region {
  x: number
  y: number
  width: number
  height: number
}
export interface ImageSpec {
  width: number
  height: number
  channels: 1 | 4
  domain: 'scene-linear-rec2020' | 'coverage' | 'analysis'
  precision: 'float32'
  alpha: 'straight-preserved' | 'separate-coverage' | 'none'
  coordinates: string
}
export interface Frame {
  spec: ImageSpec
  region: Region
  data: Float32Array
}
export interface RecipeNode {
  id: string
  operation: string
  version: number
  parameters: { [key: string]: Json }
  inputs: Record<string, string>
  output: ImageSpec
  cache: 'reusable' | 'transient'
}
export interface Recipe {
  version: 1
  sourceHash: string
  nodes: RecipeNode[]
  output: string
  // Immutable content hashes, retained by every history snapshot, including redo.
  assets: string[]
  legacySettings?: Json
}
export interface Evaluation {
  purpose: 'preview' | 'export'
  region: Region
  scale: number
  approximation: 'exact' | 'preview-lut'
  revision: number
  signal?: AbortSignal
}
export interface Assets {
  image(hash: string): Frame
  mask(hash: string): RadialMask
}
export interface RadialMask {
  version: 1
  coordinates: 'normalized-source-v1'
  center: [number, number]
  radius: number
  feather: number
}
export interface OperationContext {
  node: RecipeNode
  region: Region
  inputs: Record<string, Frame>
  output: Float32Array
  assets: Assets
  signal?: AbortSignal
}
/** Internal repository modules only; this is not an application IPC contract. */
export interface Operation {
  name: string
  version: number
  kind: 'source' | 'pointwise' | 'neighborhood' | 'geometry' | 'blend' | 'analysis'
  implementations: { cpu: string; gpu?: string }
  requirements: { precision: 'float32'; domain: ImageSpec['domain']; alpha: ImageSpec['alpha'] }
  validate(node: RecipeNode, inputs: Record<string, ImageSpec>, assets: Assets): void
  inputRegions(
    node: RecipeNode,
    output: Region,
    inputs: Record<string, ImageSpec>,
  ): Record<string, Region>
  // Region-specific asset identities allow zero-coverage tiles to survive mask edits.
  fingerprint?(node: RecipeNode, region: Region, assets: Assets): Json
  assetReferences?(node: RecipeNode): string[]
  cpu(context: OperationContext): void
  // Only single-input, domain/geometry-preserving operations are eligible for fusion.
  point?(pixel: number[], node: RecipeNode): void
  // Streaming reduction avoids materializing the whole-image dependency.
  reduction?: {
    create(): Float64Array
    add(state: Float64Array, input: Frame): void
    finish(state: Float64Array, output: Float32Array): void
  }
}
export const whole = (s: Pick<ImageSpec, 'width' | 'height'>): Region => ({
  x: 0,
  y: 0,
  width: s.width,
  height: s.height,
})
export const sameRegion = (a: Region, b: Region) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
export function validateRegion(r: Region, s: Pick<ImageSpec, 'width' | 'height'>) {
  if (
    ![r.x, r.y, r.width, r.height, s.width, s.height].every(Number.isSafeInteger) ||
    r.x < 0 ||
    r.y < 0 ||
    r.width < 1 ||
    r.height < 1 ||
    r.x + r.width > s.width ||
    r.y + r.height > s.height
  )
    throw new Error('Invalid processing region.')
}
export function* tiles(r: Region, edge: number): Generator<Region> {
  for (let y = r.y; y < r.y + r.height; y += edge)
    for (let x = r.x; x < r.x + r.width; x += edge)
      yield {
        x,
        y,
        width: Math.min(edge, r.x + r.width - x),
        height: Math.min(edge, r.y + r.height - y),
      }
}
export function canonical(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('Nonfinite recipe value.')
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Non-JSON recipe value.')
  return encoded
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex')
export function sample(frame: Frame, x: number, y: number, c: number) {
  x = Math.max(0, Math.min(frame.spec.width - 1, x))
  y = Math.max(0, Math.min(frame.spec.height - 1, y))
  const r = frame.region
  if (x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height)
    throw new Error('Operation sampled outside its declared dependency region.')
  return frame.data[((y - r.y) * r.width + x - r.x) * frame.spec.channels + c]
}
