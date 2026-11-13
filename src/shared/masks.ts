import { maskRangeCapabilities, validateMaskRange, type MaskRange } from './mask-ranges'
import {
  maskBrushLimits,
  maskBrushValidationError,
  validateBrushFields,
  validateBrushId,
  validateMaskStroke,
  type MaskPoint,
  type MaskStroke,
} from './mask-brush'
export { validateMaskStroke, type MaskPoint, type MaskStroke } from './mask-brush'

/** One analytic base in normalized, oriented source coordinates; angles use source pixels. */
export type MaskGradient =
  | { kind: 'linear'; start: MaskPoint; end: MaskPoint }
  | {
      kind: 'radial'
      center: MaskPoint
      radiusX: number
      radiusY: number
      rotation: number
      feather: number
    }
export interface MaskLight {
  exposureEv: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
}
/** Relative, zero-centered local balance and saturation. Temperature is not Kelvin. */
export interface MaskColor {
  temperature: number
  tint: number
  saturation: number
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
export type MaskOperator = 'add' | 'subtract' | 'intersect'
export type MaskCombineOperator = MaskOperator
export interface MaskCoverageNode {
  id: string
  name: string
  enabled: boolean
  inverted: boolean
  head: string | null
  base?: MaskBaseReference
  gradient?: MaskGradient
  range?: MaskRange
  edge: MaskEdgeSettings
  /** Ordered operands; the primary source always starts the calculation. */
  operands?: MaskOperand[]
  /** Manual corrections applied after composition and before inversion/edges. */
  resultHead?: string | null
}
export interface MaskOperand extends MaskCoverageNode {
  operator: MaskOperator
}
export interface MaskDescriptor extends MaskCoverageNode {
  light: MaskLight
  color: MaskColor
}
export interface MaskStrokeChunk {
  hash: string
  parent: string | null
  stroke: MaskStroke
}
export interface ResolvedMaskCoverage extends Omit<MaskCoverageNode, 'base' | 'operands'> {
  base?: MaskBaseContent
  preparedCoverage?: PreparedMaskCoverage
  /** Main-prepared range primitive; primary corrections and composition still follow it. */
  preparedRangeBase?: PreparedMaskCoverage
  strokes: MaskStroke[]
  resultStrokes?: MaskStroke[]
  operands?: ResolvedMaskOperand[]
}
export interface ResolvedMaskOperand extends ResolvedMaskCoverage {
  operator: MaskOperator
}
export interface ResolvedMask extends ResolvedMaskCoverage {
  light: MaskLight
  color: MaskColor
}
export type MaskOperation =
  | { kind: 'create'; id: string; name: string; gradient?: MaskGradient; range?: MaskRange }
  | {
      kind: 'update'
      id: string
      componentId?: string
      name?: string
      enabled?: boolean
      inverted?: boolean
      light?: Partial<MaskLight>
      color?: Partial<MaskColor>
      edge?: Partial<MaskEdgeSettings>
      gradient?: MaskGradient
      range?: MaskRange
      replacePrimary?: true
    }
  | { kind: 'duplicate'; id: string; newId: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'reorder'; ids: string[] }
  | {
      kind: 'stroke'
      id: string
      componentId?: string
      strokeTarget?: 'primary' | 'result'
      stroke: MaskStroke
    }
  | {
      kind: 'component-add'
      id: string
      componentId: string
      parentId?: string
      name: string
      operator: MaskOperator
      gradient?: MaskGradient
      range?: MaskRange
      stroke?: MaskStroke
    }
  | {
      kind: 'component-copy'
      id: string
      componentId: string
      parentId?: string
      name: string
      operator: MaskOperator
      sourceMaskId: string
      sourceComponentId?: string
    }
  | {
      kind: 'component-update'
      id: string
      componentId: string
      name?: string
      enabled?: boolean
      inverted?: boolean
      edge?: Partial<MaskEdgeSettings>
      gradient?: MaskGradient
      range?: MaskRange
      replacePrimary?: true
      operator?: MaskOperator
      clearPrimary?: true
    }
  | { kind: 'component-duplicate'; id: string; componentId: string; newId: string; name: string }
  | { kind: 'component-remove'; id: string; componentId: string }
  | { kind: 'component-reorder'; id: string; parentId?: string; ids: string[] }
export interface MaskMutation {
  operations: MaskOperation[]
}
export const maskCapabilities = {
  version: 6,
  order: 'top-last',
  types: ['brush', 'linear', 'radial', 'color-range', 'luminance-range'],
  range: maskRangeCapabilities,
  gradient: {
    coordinates: 'normalized-oriented-source',
    pointMin: -1,
    pointMax: 2,
    radialRadiusMax: 2,
    minimumSourcePixels: 1,
    rotation: { min: -180, max: 180, unit: 'degrees' },
    feather: { min: 0, max: 100, step: 1, default: 50 },
    order: 'gradient-brush-invert-shift-feather',
  },
  controls: [
    'exposureEv',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'temperature',
    'tint',
    'saturation',
  ],
  color: {
    controls: ['temperature', 'tint', 'saturation'],
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    balance: 'relative-d65-bradford-half-mired-ucs-lab-v1',
    order: 'balance-light-saturation-coverage',
  },
  edge: {
    controls: ['featherPx', 'shiftPx'],
    coordinates: 'canonical-oriented-source-pixels',
    order: 'base-or-gradient-brush-invert-shift-feather',
    featherPx: { min: 0, max: 64, step: 0.5, default: 0 },
    shiftPx: { min: -16, max: 16, step: 1, default: 0 },
    automaticMatting: false,
  },
  compound: {
    operators: ['add', 'subtract', 'intersect'],
    add: 'max(A,B)',
    subtract: 'A*(1-B)',
    intersect: 'A*B',
    order: 'primary-strokes-operands-result-corrections-invert-shift-feather',
    copy: 'independent-editable-coverage-tree',
    strokeDefault: 'result',
  },
  maxNodesPerMask: 32,
  maxNodesPerPhoto: 256,
  maxDepth: 8,
  maxMasks: 32,
  maxStrokePoints: maskBrushLimits.maxPoints,
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
export const neutralMaskColor: Readonly<MaskColor> = { temperature: 0, tint: 0, saturation: 0 }
export function hasMaskAdjustments(mask: Pick<MaskDescriptor, 'light' | 'color'>): boolean {
  return (
    Object.values(mask.light).some((value) => value !== 0) ||
    Object.values(mask.color).some((value) => value !== 0)
  )
}
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
export function validateMaskColor(value: unknown, partial = false): asserts value is MaskColor {
  const keys = Object.keys(neutralMaskColor)
  if (!fields(value, partial ? [] : keys, partial ? keys : []))
    throw new Error('Invalid local Color controls.')
  for (const number of Object.values(value))
    if (typeof number !== 'number' || !Number.isInteger(number) || Math.abs(number) > 100)
      throw new Error('Local Temperature, Tint and Saturation require integers from -100 to 100.')
}
/** Source dimensions are required at geometry admission to enforce the one-pixel minimum. */
export function validateMaskGradient(
  value: unknown,
  width?: number,
  height?: number,
): asserts value is MaskGradient {
  const point = (point: unknown) =>
    fields(point, ['x', 'y']) &&
    [point.x, point.y].every(
      (number) =>
        typeof number === 'number' && Number.isFinite(number) && number >= -1 && number <= 2,
    )
  const dimensions = width !== undefined && height !== undefined
  if (dimensions && ![width, height].every((n) => Number.isSafeInteger(n) && n! > 0))
    throw new Error('Invalid source dimensions for gradient geometry.')
  if (fields(value, ['kind', 'start', 'end']) && value.kind === 'linear') {
    if (!point(value.start) || !point(value.end))
      throw new Error('Gradient points must use normalized source coordinates from -1 to 2.')
    const start = value.start as MaskPoint,
      end = value.end as MaskPoint
    const separation = Math.hypot(
      (end.x - start.x) * (width ?? 1),
      (end.y - start.y) * (height ?? 1),
    )
    if (!Number.isFinite(separation) || separation < (dimensions ? 1 : Number.MIN_VALUE))
      throw new Error('A linear gradient requires at least one source pixel between its endpoints.')
    return
  }
  if (
    fields(value, ['kind', 'center', 'radiusX', 'radiusY', 'rotation', 'feather']) &&
    value.kind === 'radial' &&
    point(value.center) &&
    [value.radiusX, value.radiusY].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 2,
    ) &&
    typeof value.rotation === 'number' &&
    Number.isFinite(value.rotation) &&
    Math.abs(value.rotation) <= 180 &&
    typeof value.feather === 'number' &&
    Number.isInteger(value.feather) &&
    value.feather >= 0 &&
    value.feather <= 100
  ) {
    if (
      dimensions &&
      ((value.radiusX as number) * width! < 1 || (value.radiusY as number) * height! < 1)
    )
      throw new Error('Each radial gradient semiaxis requires at least one source pixel.')
    return
  }
  throw new Error(
    'Invalid gradient geometry. Use bounded linear endpoints or a radial ellipse with Feather from 0 to 100.',
  )
}
/** Traversal includes disabled parts for immutable content and resource accounting. */
export function coverageNodes<T extends MaskCoverageNode>(root: T): MaskCoverageNode[] {
  const result: MaskCoverageNode[] = [],
    seen = new Set<MaskCoverageNode>(),
    pending = [{ node: root as MaskCoverageNode, depth: 1 }]
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (
      seen.has(node) ||
      depth > maskCapabilities.maxDepth ||
      result.length >= maskCapabilities.maxNodesPerMask
    )
      throw new Error('Mask coverage exceeds its node or depth limit or contains a cycle.')
    seen.add(node)
    result.push(node)
    if (node.operands !== undefined && !Array.isArray(node.operands))
      throw new Error('Invalid mask operands.')
    for (const child of [...(node.operands ?? [])].reverse())
      pending.push({ node: child, depth: depth + 1 })
  }
  return result
}
export function findMaskComponent<T extends MaskCoverageNode>(
  root: T,
  componentId?: string,
): MaskCoverageNode {
  if (!componentId || componentId === root.id) return root
  for (const node of coverageNodes(root)) if (node.id === componentId) return node
  throw new Error('This mask component is unavailable. Refresh the confirmed masks.')
}
function validateMaskOperator(value: unknown): asserts value is MaskOperator {
  if (typeof value !== 'string' || !['add', 'subtract', 'intersect'].includes(value))
    throw new Error('Invalid mask combination operator.')
}
export function validateMaskStack(value: unknown): asserts value is MaskDescriptor[] {
  if (!Array.isArray(value) || value.length > maskCapabilities.maxMasks)
    throw new Error('Too many local masks.')
  const ids = new Set<string>()
  let total = 0
  for (const mask of value) {
    let count = 0
    const visit = (node: unknown, depth: number, root: boolean) => {
      if (
        ++count > maskCapabilities.maxNodesPerMask ||
        ++total > maskCapabilities.maxNodesPerPhoto ||
        depth > maskCapabilities.maxDepth
      )
        throw new Error('Mask coverage exceeds its node or depth limit.')
      if (
        !fields(
          node,
          [
            'id',
            'name',
            'enabled',
            'inverted',
            'head',
            'edge',
            ...(root ? ['light', 'color'] : ['operator']),
          ],
          ['base', 'gradient', 'range', 'operands', 'resultHead'],
        )
      )
        throw new Error('Invalid mask descriptor.')
      validateMaskId(node.id)
      validateMaskName(node.name)
      validateMaskEdge(node.edge)
      if (root) {
        validateMaskLight(node.light)
        validateMaskColor(node.color)
      } else validateMaskOperator(node.operator)
      if (node.base !== undefined) validateMaskBaseReference(node.base)
      if (node.gradient !== undefined) {
        validateMaskGradient(node.gradient)
      }
      if (node.range !== undefined) validateMaskRange(node.range)
      if (
        [node.base, node.gradient, node.range].filter((source) => source !== undefined).length > 1
      )
        throw new Error('A gradient, range and generated object base are mutually exclusive.')
      const validHead = (head: unknown) =>
        head === null || (typeof head === 'string' && maskHash.test(head))
      if (
        ids.has(node.id) ||
        typeof node.enabled !== 'boolean' ||
        typeof node.inverted !== 'boolean' ||
        !validHead(node.head) ||
        (node.resultHead !== undefined && !validHead(node.resultHead))
      )
        throw new Error('Invalid mask descriptor.')
      ids.add(node.id)
      if (node.operands !== undefined) {
        if (!Array.isArray(node.operands)) throw new Error('Invalid mask operands.')
        for (const child of node.operands) visit(child, depth + 1, false)
      }
    }
    visit(mask, 1, true)
  }
}
export function validateMaskMutation(value: unknown): asserts value is MaskMutation {
  validateBrushFields(value, ['operations'], [], 'maskMutation')
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > 64)
    throw maskBrushValidationError(
      'maskMutation.operations',
      'Expected an array of 1–64 operations.',
    )
  for (const [index, op] of value.operations.entries()) {
    const path = `maskMutation.operations[${index}]`
    if (!op || typeof op !== 'object' || Array.isArray(op))
      throw maskBrushValidationError(
        path,
        'Expected an operation object with a kind discriminator.',
      )
    switch (op.kind) {
      case 'create':
        if (!fields(op, ['kind', 'id', 'name'], ['gradient', 'range']))
          throw new Error('Invalid mask creation.')
        if (op.gradient !== undefined) validateMaskGradient(op.gradient)
        if (op.range !== undefined) validateMaskRange(op.range)
        if (op.gradient !== undefined && op.range !== undefined)
          throw new Error('A gradient and range are mutually exclusive.')
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
        if (
          !fields(
            op,
            ['kind', 'id'],
            [
              'componentId',
              'name',
              'enabled',
              'inverted',
              'light',
              'color',
              'edge',
              'gradient',
              'range',
              'replacePrimary',
            ],
          )
        )
          throw new Error('Invalid mask update.')
        validateMaskId(op.id)
        if (op.componentId !== undefined) validateMaskId(op.componentId)
        if (op.name !== undefined) validateMaskName(op.name)
        if (op.light !== undefined) validateMaskLight(op.light, true)
        if (op.color !== undefined) validateMaskColor(op.color, true)
        if (op.edge !== undefined) validateMaskEdge(op.edge, true)
        if (op.gradient !== undefined) validateMaskGradient(op.gradient)
        if (op.range !== undefined) validateMaskRange(op.range)
        if (op.gradient !== undefined && op.range !== undefined)
          throw new Error('A gradient and range are mutually exclusive.')
        if (
          op.replacePrimary !== undefined &&
          (op.replacePrimary !== true || (op.range === undefined && op.gradient === undefined))
        )
          throw new Error('Primary replacement requires a complete range or gradient.')
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
        validateBrushFields(op, ['kind', 'id', 'stroke'], ['componentId', 'strokeTarget'], path)
        validateBrushId(op.id, `${path}.id`)
        if (op.componentId !== undefined) validateBrushId(op.componentId, `${path}.componentId`)
        if (
          op.strokeTarget !== undefined &&
          (typeof op.strokeTarget !== 'string' || !['primary', 'result'].includes(op.strokeTarget))
        )
          throw maskBrushValidationError(
            `${path}.strokeTarget`,
            'Expected "primary" or "result"; omitted means result corrections.',
          )
        validateMaskStroke(op.stroke, `${path}.stroke`)
        break
      case 'component-add':
      case 'component-copy':
      case 'component-update':
      case 'component-duplicate':
      case 'component-remove':
      case 'component-reorder': {
        const schemas: Record<string, [string[], string[]]> = {
          'component-add': [
            ['componentId', 'name', 'operator'],
            ['parentId', 'gradient', 'range', 'stroke'],
          ],
          'component-copy': [
            ['componentId', 'name', 'operator', 'sourceMaskId'],
            ['parentId', 'sourceComponentId'],
          ],
          'component-update': [
            ['componentId'],
            [
              'name',
              'enabled',
              'inverted',
              'edge',
              'gradient',
              'range',
              'operator',
              'clearPrimary',
              'replacePrimary',
            ],
          ],
          'component-duplicate': [['componentId', 'newId', 'name'], []],
          'component-remove': [['componentId'], []],
          'component-reorder': [['ids'], ['parentId']],
        }
        const [required, optional] = schemas[op.kind]
        if (op.kind === 'component-add' && op.stroke !== undefined)
          validateBrushFields(op, ['kind', 'id', ...required], optional, path)
        else if (!fields(op, ['kind', 'id', ...required], optional))
          throw new Error('Invalid mask component operation.')
        if (op.kind === 'component-add' && op.stroke !== undefined)
          validateBrushId(op.id, `${path}.id`)
        else validateMaskId(op.id)
        for (const key of ['componentId', 'newId', 'parentId', 'sourceMaskId', 'sourceComponentId'])
          if (op[key] !== undefined) {
            if (op.kind === 'component-add' && op.stroke !== undefined)
              validateBrushId(op[key], `${path}.${key}`)
            else validateMaskId(op[key])
          }
        if (op.name !== undefined) validateMaskName(op.name)
        if (op.operator !== undefined) validateMaskOperator(op.operator)
        if (op.gradient !== undefined) validateMaskGradient(op.gradient)
        if (op.range !== undefined) validateMaskRange(op.range)
        if (op.gradient !== undefined && op.range !== undefined)
          throw new Error('A gradient and range are mutually exclusive.')
        if (op.stroke !== undefined) validateMaskStroke(op.stroke, `${path}.stroke`)
        if (op.edge !== undefined) validateMaskEdge(op.edge, true)
        for (const key of ['enabled', 'inverted'])
          if (op[key] !== undefined && typeof op[key] !== 'boolean')
            throw new Error('Invalid mask component state.')
        if (op.clearPrimary !== undefined && op.clearPrimary !== true)
          throw new Error('Invalid primary replacement.')
        if (
          op.clearPrimary &&
          (op.range !== undefined || op.gradient !== undefined || op.replacePrimary)
        )
          throw new Error('Clear starting coverage separately from replacing its source.')
        if (
          op.replacePrimary !== undefined &&
          (op.replacePrimary !== true || (op.range === undefined && op.gradient === undefined))
        )
          throw new Error('Primary replacement requires a complete range or gradient.')
        if (op.ids !== undefined) {
          if (
            !Array.isArray(op.ids) ||
            op.ids.length > maskCapabilities.maxNodesPerMask ||
            new Set(op.ids).size !== op.ids.length
          )
            throw new Error('Invalid component ordering.')
          op.ids.forEach(validateMaskId)
        }
        break
      }
      default:
        throw maskBrushValidationError(
          `${path}.kind`,
          'Unknown mask operation; use kind:"stroke" for Paint/Erase.',
        )
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > maskCapabilities.maxMutationBytes
  )
    throw maskBrushValidationError(
      'maskMutation',
      `Encoded mutation exceeds ${maskCapabilities.maxMutationBytes} UTF-8 bytes; split the operations into bounded batches.`,
    )
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
  const resolve = (mask: MaskCoverageNode): ResolvedMaskCoverage => {
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
    const chain = (initial: string | null): MaskStroke[] => {
      const strokes: MaskStroke[] = [],
        seen = new Set<string>()
      let head = initial
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
      return strokes.reverse()
    }
    const descriptor = {
      id: mask.id,
      name: mask.name,
      enabled: mask.enabled,
      inverted: mask.inverted,
      head: mask.head,
      edge: mask.edge,
      ...(mask.gradient ? { gradient: mask.gradient } : {}),
      ...(mask.range ? { range: mask.range } : {}),
    }
    return {
      ...descriptor,
      ...(base ? { base } : {}),
      strokes: chain(mask.head),
      resultHead: mask.resultHead ?? null,
      resultStrokes: chain(mask.resultHead ?? null),
      operands: (mask.operands ?? []).map((child) => ({
        ...resolve(child),
        operator: child.operator,
      })),
    }
  }
  return stack.map((mask) => ({ ...resolve(mask), light: mask.light, color: mask.color }))
}

export function validateResolvedMasks(value: unknown): asserts value is ResolvedMask[] {
  if (!Array.isArray(value) || value.length > maskCapabilities.maxMasks)
    throw new Error('Invalid resolved masks.')
  let points = 0,
    nodes = 0
  const descriptor = (mask: unknown, depth: number, root: boolean): Record<string, unknown> => {
    if (++nodes > maskCapabilities.maxNodesPerPhoto || depth > maskCapabilities.maxDepth)
      throw new Error('Mask coverage exceeds its node or depth limit.')
    if (
      !fields(
        mask,
        [
          'id',
          'name',
          'enabled',
          'inverted',
          'head',
          'edge',
          'strokes',
          ...(root ? ['light', 'color'] : ['operator']),
        ],
        [
          'base',
          'preparedCoverage',
          'preparedRangeBase',
          'gradient',
          'range',
          'operands',
          'resultHead',
          'resultStrokes',
        ],
      ) ||
      !Array.isArray(mask.strokes) ||
      (mask.resultStrokes !== undefined && !Array.isArray(mask.resultStrokes))
    )
      throw new Error('Invalid resolved mask geometry.')
    for (const stroke of [...mask.strokes, ...((mask.resultStrokes ?? []) as unknown[])]) {
      validateMaskStroke(stroke)
      points += stroke.points.length
      if (points > maskCapabilities.maxLivePoints)
        throw new Error('The live brush geometry limit was exceeded.')
    }
    if (mask.base !== undefined) validateMaskBaseContent(mask.base)
    if (mask.preparedCoverage !== undefined) validatePreparedMaskCoverage(mask.preparedCoverage)
    if (mask.preparedRangeBase !== undefined) {
      validatePreparedMaskCoverage(mask.preparedRangeBase)
      if (mask.range === undefined)
        throw new Error('Prepared range coverage requires an authored range.')
    }
    if (mask.operands !== undefined && !Array.isArray(mask.operands))
      throw new Error('Invalid mask operands.')
    return {
      ...Object.fromEntries(
        Object.entries(mask).filter(
          ([key]) =>
            ![
              'strokes',
              'resultStrokes',
              'base',
              'preparedCoverage',
              'preparedRangeBase',
              'operands',
            ].includes(key),
        ),
      ),
      ...(mask.base ? { base: maskBaseReference(mask.base as MaskBaseContent) } : {}),
      ...(mask.operands !== undefined
        ? {
            operands: (mask.operands as unknown[]).map((child) =>
              descriptor(child, depth + 1, false),
            ),
          }
        : {}),
    }
  }
  validateMaskStack(value.map((mask) => descriptor(mask, 1, true)))
}
