/** Immutable brush geometry in normalized, oriented source coordinates. */
export interface MaskPoint {
  x: number
  y: number
}
export interface MaskStroke {
  mode: 'add' | 'subtract'
  radius: number
  feather: number
  points: MaskPoint[]
}
export interface MaskLight {
  exposureEv: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
}
/** Whole-mask edge distances in canonical oriented source pixels. */
export interface MaskEdgeSettings {
  featherPx: number
  shiftPx: number
}
/** Native oriented-source coverage. History stores this immutable reference only. */
export interface MaskBaseReference {
  version: 1
  hash: string
  width: number
  height: number
}
export interface MaskBaseContent extends MaskBaseReference {
  /** Lossless grayscale, eight-bit PNG; decoding belongs to native/browser codecs. */
  pngBase64: string
}
/** Main-prepared final coverage; never durable mask content or an upload contract. */
export type PreparedMaskCoverage = Readonly<MaskBaseContent & { key: string; version: 1 }>
export interface MaskDescriptor {
  id: string
  name: string
  enabled: boolean
  inverted: boolean
  head: string | null
  base?: MaskBaseReference
  light: MaskLight
  edge: MaskEdgeSettings
}
export interface MaskStrokeChunk {
  hash: string
  parent: string | null
  stroke: MaskStroke
}
export interface ResolvedMask extends MaskDescriptor {
  base?: MaskBaseContent
  preparedCoverage?: PreparedMaskCoverage
  strokes: MaskStroke[]
}
export type MaskOperation =
  | { kind: 'create'; id: string; name: string }
  | {
      kind: 'update'
      id: string
      name?: string
      enabled?: boolean
      inverted?: boolean
      light?: Partial<MaskLight>
      edge?: Partial<MaskEdgeSettings>
    }
  | { kind: 'duplicate'; id: string; newId: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | { kind: 'stroke'; id: string; stroke: MaskStroke }
export interface MaskMutation {
  operations: MaskOperation[]
}
export const maskCapabilities = {
  version: 2,
  order: 'top-last',
  types: ['brush'],
  controls: ['exposureEv', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  edge: {
    controls: ['featherPx', 'shiftPx'],
    coordinates: 'canonical-oriented-source-pixels',
    order: 'base-brush-invert-shift-feather',
    featherPx: { min: 0, max: 64, step: 0.5, default: 0 },
    shiftPx: { min: -16, max: 16, step: 1, default: 0 },
    automaticMatting: false,
  },
  maxMasks: 32,
  maxStrokePoints: 4096,
  maxLivePoints: 65536,
  maxRetainedBytes: 32 * 1024 * 1024,
  maxMutationBytes: 256 * 1024,
  maxBasePixels: 32 * 1024 * 1024,
  maxBaseEncodedBytes: 8 * 1024 * 1024,
  maxLiveBaseEncodedBytes: 32 * 1024 * 1024,
  maxBaseAtlasBytes: 256 * 1024 * 1024,
} as const
export const neutralMaskLight: Readonly<MaskLight> = {
  exposureEv: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
}
export const neutralMaskEdge: Readonly<MaskEdgeSettings> = { featherPx: 0, shiftPx: 0 }
export function maskHasEdges(mask: Pick<MaskDescriptor, 'edge'>): boolean {
  return mask.edge.featherPx !== 0 || mask.edge.shiftPx !== 0
}
export const maskHash = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
export function validateMaskId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid mask ID.')
}
export function validateMaskBaseReference(value: unknown): asserts value is MaskBaseReference {
  if (
    !fields(value, ['version', 'hash', 'width', 'height']) ||
    value.version !== 1 ||
    typeof value.hash !== 'string' ||
    !maskHash.test(value.hash) ||
    ![value.width, value.height].every(
      (dimension) =>
        Number.isSafeInteger(dimension) &&
        (dimension as number) > 0 &&
        (dimension as number) <= 32768,
    ) ||
    (value.width as number) * (value.height as number) > maskCapabilities.maxBasePixels
  )
    throw new Error('Invalid or oversized generated mask reference.')
}
export function maskBaseReference(base: MaskBaseReference): MaskBaseReference {
  return { version: 1, hash: base.hash, width: base.width, height: base.height }
}
export function validateMaskBaseContent(value: unknown): asserts value is MaskBaseContent {
  if (!fields(value, ['version', 'hash', 'width', 'height', 'pngBase64']))
    throw new Error('Invalid generated mask content.')
  validateMaskBaseReference({
    version: value.version,
    hash: value.hash,
    width: value.width,
    height: value.height,
  })
  const encoded = value.pngBase64
  if (
    typeof encoded !== 'string' ||
    encoded.length < 60 ||
    encoded.length % 4 !== 0 ||
    encoded.length > Math.ceil(maskCapabilities.maxBaseEncodedBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new Error('Invalid or oversized generated mask PNG.')
  const header = Uint8Array.from(atob(encoded.slice(0, 44)), (character) =>
      character.charCodeAt(0),
    ),
    data = new DataView(header.buffer)
  if (
    [...header.slice(0, 8)].join(',') !== '137,80,78,71,13,10,26,10' ||
    data.getUint32(8) !== 13 ||
    String.fromCharCode(...header.slice(12, 16)) !== 'IHDR' ||
    data.getUint32(16) !== value.width ||
    data.getUint32(20) !== value.height ||
    header[24] !== 8 ||
    header[25] !== 0 ||
    header[26] !== 0 ||
    header[27] !== 0 ||
    header[28] !== 0
  )
    throw new Error('Generated masks require a native-size, noninterlaced R8 PNG.')
}
export function validatePreparedMaskCoverage(
  value: unknown,
): asserts value is PreparedMaskCoverage {
  if (
    !fields(value, ['version', 'hash', 'width', 'height', 'pngBase64', 'key']) ||
    typeof value.key !== 'string' ||
    !maskHash.test(value.key)
  )
    throw new Error('Invalid prepared mask coverage.')
  validateMaskBaseContent({
    version: value.version,
    hash: value.hash,
    width: value.width,
    height: value.height,
    pngBase64: value.pngBase64,
  })
}
export function validateMaskName(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 100 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error('Use a mask name of 1–100 characters without control characters.')
}
export function validateMaskLight(value: unknown, partial = false): asserts value is MaskLight {
  const keys = Object.keys(neutralMaskLight)
  if (!fields(value, partial ? [] : keys, partial ? keys : []))
    throw new Error('Invalid local Light controls.')
  for (const [key, number] of Object.entries(value)) {
    const exposure = key === 'exposureEv',
      limit = exposure ? 5 : 100
    if (
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      Math.abs(number) > limit ||
      Math.abs(number * (exposure ? 100 : 1) - Math.round(number * (exposure ? 100 : 1))) > 1e-8
    )
      throw new Error('Invalid local Light value.')
  }
}
export function validateMaskEdge(
  value: unknown,
  partial = false,
): asserts value is MaskEdgeSettings {
  const keys = Object.keys(neutralMaskEdge)
  if (!fields(value, partial ? [] : keys, partial ? keys : []))
    throw new Error('Invalid mask edge controls.')
  for (const [key, number] of Object.entries(value)) {
    if (
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      (key === 'featherPx'
        ? number < 0 || number > 64 || !Number.isInteger(number * 2)
        : number < -16 || number > 16 || !Number.isInteger(number))
    )
      throw new Error(
        'Mask Feather must be 0–64 pixels in half-pixel steps; Expand/Contract must be an integer from -16 to 16 pixels.',
      )
  }
}
export function validateMaskStroke(value: unknown): asserts value is MaskStroke {
  if (
    !fields(value, ['mode', 'radius', 'feather', 'points']) ||
    !['add', 'subtract'].includes(String(value.mode)) ||
    typeof value.radius !== 'number' ||
    !Number.isFinite(value.radius) ||
    !Number.isFinite(Math.fround(value.radius)) ||
    Math.fround(value.radius) <= 0 ||
    value.radius <= 0 ||
    value.radius > 0.5 ||
    typeof value.feather !== 'number' ||
    !Number.isFinite(value.feather) ||
    value.feather < 0 ||
    value.feather > 1 ||
    !Array.isArray(value.points) ||
    !value.points.length ||
    value.points.length > maskCapabilities.maxStrokePoints
  )
    throw new Error('Invalid or oversized brush stroke.')
  for (const point of value.points)
    if (
      !fields(point, ['x', 'y']) ||
      ['x', 'y'].some(
        (key) =>
          typeof point[key] !== 'number' ||
          !Number.isFinite(point[key]) ||
          (point[key] as number) < 0 ||
          (point[key] as number) > 1,
      )
    )
      throw new Error('Brush points must use normalized source coordinates.')
}
export function validateMaskStack(value: unknown): asserts value is MaskDescriptor[] {
  if (!Array.isArray(value) || value.length > maskCapabilities.maxMasks)
    throw new Error('Too many local masks.')
  const ids = new Set<string>()
  for (const mask of value) {
    if (!fields(mask, ['id', 'name', 'enabled', 'inverted', 'head', 'light', 'edge'], ['base']))
      throw new Error('Invalid mask descriptor.')
    validateMaskId(mask.id)
    validateMaskName(mask.name)
    validateMaskLight(mask.light)
    validateMaskEdge(mask.edge)
    if (mask.base !== undefined) validateMaskBaseReference(mask.base)
    if (
      ids.has(mask.id) ||
      typeof mask.enabled !== 'boolean' ||
      typeof mask.inverted !== 'boolean' ||
      (mask.head !== null && (typeof mask.head !== 'string' || !maskHash.test(mask.head)))
    )
      throw new Error('Invalid mask descriptor.')
    ids.add(mask.id)
  }
}
export function validateMaskMutation(value: unknown): asserts value is MaskMutation {
  if (
    !fields(value, ['operations']) ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > 64
  )
    throw new Error('Invalid or oversized mask mutation.')
  for (const op of value.operations) {
    if (!op || typeof op !== 'object' || Array.isArray(op))
      throw new Error('Invalid mask operation.')
    switch (op.kind) {
      case 'create':
        if (!fields(op, ['kind', 'id', 'name'])) throw new Error('Invalid mask creation.')
        validateMaskId(op.id)
        validateMaskName(op.name)
        break
      case 'duplicate':
        if (!fields(op, ['kind', 'id', 'newId', 'name']))
          throw new Error('Invalid mask duplication.')
        validateMaskId(op.id)
        validateMaskId(op.newId)
        validateMaskName(op.name)
        break
      case 'update':
        if (!fields(op, ['kind', 'id'], ['name', 'enabled', 'inverted', 'light', 'edge']))
          throw new Error('Invalid mask update.')
        validateMaskId(op.id)
        if (op.name !== undefined) validateMaskName(op.name)
        if (op.light !== undefined) validateMaskLight(op.light, true)
        if (op.edge !== undefined) validateMaskEdge(op.edge, true)
        for (const key of ['enabled', 'inverted'])
          if (op[key] !== undefined && typeof op[key] !== 'boolean')
            throw new Error('Invalid mask state.')
        break
      case 'delete':
        if (!fields(op, ['kind', 'id'])) throw new Error('Invalid mask deletion.')
        validateMaskId(op.id)
        break
      case 'reorder':
        if (
          !fields(op, ['kind', 'ids']) ||
          !Array.isArray(op.ids) ||
          op.ids.length > maskCapabilities.maxMasks ||
          new Set(op.ids).size !== op.ids.length
        )
          throw new Error('Invalid mask ordering.')
        op.ids.forEach(validateMaskId)
        break
      case 'stroke':
        if (!fields(op, ['kind', 'id', 'stroke'])) throw new Error('Invalid brush operation.')
        validateMaskId(op.id)
        validateMaskStroke(op.stroke)
        break
      default:
        throw new Error('Unknown mask operation.')
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > maskCapabilities.maxMutationBytes
  )
    throw new Error('Invalid or oversized mask mutation.')
}
/** Fixed serialization is hashed by the main-owned immutable content store. */
export function maskChunkBytes(parent: string | null, stroke: MaskStroke): string {
  validateMaskStroke(stroke)
  return JSON.stringify({
    version: 1,
    parent,
    stroke: {
      mode: stroke.mode,
      radius: stroke.radius,
      feather: stroke.feather,
      points: stroke.points.map(({ x, y }) => ({ x, y })),
    },
  })
}
export function resolveMasks(
  stack: readonly MaskDescriptor[],
  content: readonly MaskStrokeChunk[],
  bases: readonly MaskBaseContent[] = [],
): ResolvedMask[] {
  validateMaskStack(stack)
  const chunks = new Map(content.map((chunk) => [chunk.hash, chunk])),
    live = new Set<string>()
  let points = 0
  const baseContent = new Map(bases.map((base) => [base.hash, base])),
    liveBases = new Set<string>()
  let baseBytes = 0,
    baseAtlasBytes = 0
  return stack.map((mask) => {
    let base: MaskBaseContent | undefined
    if (mask.base) {
      base = baseContent.get(mask.base.hash)
      if (!base) throw new Error('Historical generated mask content is missing.')
      validateMaskBaseContent(base)
      if (JSON.stringify(maskBaseReference(base)) !== JSON.stringify(mask.base))
        throw new Error('Historical generated mask dimensions do not match its reference.')
      if (!liveBases.has(base.hash)) {
        liveBases.add(base.hash)
        baseBytes += (base.pngBase64.length / 4) * 3
        baseAtlasBytes += base.width * base.height
      }
      if (baseBytes > maskCapabilities.maxLiveBaseEncodedBytes)
        throw new Error('The live generated mask content limit was exceeded.')
      if (baseAtlasBytes > maskCapabilities.maxBaseAtlasBytes)
        throw new Error(
          'Generated masks exceed the 256 MiB native coverage atlas limit. Remove a generated mask before trying again.',
        )
    }
    const strokes: MaskStroke[] = [],
      seen = new Set<string>()
    let head = mask.head
    while (head !== null) {
      if (seen.has(head)) throw new Error('Cyclic mask content.')
      seen.add(head)
      const chunk = chunks.get(head)
      if (!chunk) throw new Error('Historical mask content is missing.')
      validateMaskStroke(chunk.stroke)
      if (!live.has(head)) {
        live.add(head)
        points += chunk.stroke.points.length
      }
      if (points > maskCapabilities.maxLivePoints || seen.size > maskCapabilities.maxLivePoints)
        throw new Error('The live brush geometry limit was exceeded.')
      strokes.push(chunk.stroke)
      head = chunk.parent
    }
    const descriptor = {
      id: mask.id,
      name: mask.name,
      enabled: mask.enabled,
      inverted: mask.inverted,
      head: mask.head,
      light: mask.light,
      edge: mask.edge,
    }
    return { ...descriptor, ...(base ? { base } : {}), strokes: strokes.reverse() }
  })
}

export function validateResolvedMasks(value: unknown): asserts value is ResolvedMask[] {
  if (!Array.isArray(value) || value.length > maskCapabilities.maxMasks)
    throw new Error('Invalid resolved masks.')
  let points = 0
  const descriptors = value.map((mask: unknown) => {
    if (
      !fields(
        mask,
        ['id', 'name', 'enabled', 'inverted', 'head', 'light', 'edge', 'strokes'],
        ['base', 'preparedCoverage'],
      ) ||
      !Array.isArray(mask.strokes)
    )
      throw new Error('Invalid resolved mask geometry.')
    for (const stroke of mask.strokes) {
      validateMaskStroke(stroke)
      points += stroke.points.length
      if (points > maskCapabilities.maxLivePoints)
        throw new Error('The live brush geometry limit was exceeded.')
    }
    if (mask.base !== undefined) validateMaskBaseContent(mask.base)
    if (mask.preparedCoverage !== undefined) validatePreparedMaskCoverage(mask.preparedCoverage)
    return {
      ...Object.fromEntries(
        Object.entries(mask).filter(
          ([key]) => key !== 'strokes' && key !== 'base' && key !== 'preparedCoverage',
        ),
      ),
      ...(mask.base ? { base: maskBaseReference(mask.base as MaskBaseContent) } : {}),
    }
  })
  validateMaskStack(descriptors)
}
