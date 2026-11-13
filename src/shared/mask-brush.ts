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

export const maskBrushLimits = { maxPoints: 4096, maxRadius: 0.5 } as const
export const maskBrushIdSchema = {
  type: 'string',
  format: 'uuid',
  pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$',
  description:
    'Lowercase UUID: confirmed IDs for existing nodes, fresh IDs for new nodes. Components belong to the specified root.',
}
export const maskStrokeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'radius', 'feather', 'points'],
  properties: {
    mode: { enum: ['add', 'subtract'], description: 'Paint is add; Erase is subtract.' },
    radius: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: maskBrushLimits.maxRadius,
      description:
        'Fraction of the canonical source shorter dimension; must remain positive in Float32.',
    },
    feather: { type: 'number', minimum: 0, maximum: 1 },
    points: {
      type: 'array',
      minItems: 1,
      maxItems: maskBrushLimits.maxPoints,
      description:
        'Use mapped canonical points returned by revision-bound irodori_get_mask_context, not preview pixels.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y'],
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1 },
          y: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
}

/** A template only: callers supply confirmed IDs and revision-mapped source points. */
export function maskBrushExample(mode: MaskStroke['mode'], point: MaskPoint): MaskStroke {
  return { mode, radius: 0.025, feather: 0.5, points: [{ x: point.x, y: point.y }] }
}

export function maskBrushValidationError(path: string, reason: string): Error {
  const example = {
    kind: 'stroke',
    id: '00000000-0000-0000-0000-000000000001',
    strokeTarget: 'result',
    stroke: maskBrushExample('add', { x: 0.5, y: 0.5 }),
  }
  return new Error(
    `${path}: ${reason} Minimal valid operation: ${JSON.stringify(example)}. ` +
      'Place it in maskMutation.operations; use the confirmed photoId, expectedRevision and existing mask/component IDs from irodori_get_edits. ' +
      'Replace example points with canonical points mapped by irodori_get_mask_context at that revision. ' +
      'Paint uses add; Erase uses subtract. Omitted componentId targets the root; omitted strokeTarget targets result corrections.',
  )
}

export function validateBrushFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw maskBrushValidationError(path, 'Expected an object.')
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw maskBrushValidationError(`${path}.${key}`, 'Required field is missing.')
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      throw maskBrushValidationError(
        `${path}.${key}`,
        `Unknown field; allowed fields: ${[...required, ...optional].join(', ')}.`,
      )
}

export function validateMaskStroke(value: unknown, path = 'stroke'): asserts value is MaskStroke {
  validateBrushFields(value, maskStrokeSchema.required, [], path)
  if (typeof value.mode !== 'string' || !['add', 'subtract'].includes(value.mode))
    throw maskBrushValidationError(`${path}.mode`, 'Expected "add" (Paint) or "subtract" (Erase).')
  if (
    typeof value.radius !== 'number' ||
    !Number.isFinite(value.radius) ||
    value.radius <= 0 ||
    value.radius > maskBrushLimits.maxRadius ||
    !Number.isFinite(Math.fround(value.radius)) ||
    Math.fround(value.radius) <= 0
  )
    throw maskBrushValidationError(
      `${path}.radius`,
      'Expected a finite number greater than 0 through 0.5, positive in Float32, as a fraction of the canonical source shorter dimension.',
    )
  if (
    typeof value.feather !== 'number' ||
    !Number.isFinite(value.feather) ||
    value.feather < 0 ||
    value.feather > 1
  )
    throw maskBrushValidationError(`${path}.feather`, 'Expected a finite number from 0 through 1.')
  if (
    !Array.isArray(value.points) ||
    value.points.length < 1 ||
    value.points.length > maskBrushLimits.maxPoints
  )
    throw maskBrushValidationError(
      `${path}.points`,
      `Expected an array of 1–${maskBrushLimits.maxPoints} canonical source points.`,
    )
  for (const [index, point] of value.points.entries()) {
    const pointPath = `${path}.points[${index}]`
    validateBrushFields(point, maskStrokeSchema.properties.points.items.required, [], pointPath)
    for (const key of ['x', 'y'])
      if (
        typeof point[key] !== 'number' ||
        !Number.isFinite(point[key]) ||
        point[key] < 0 ||
        point[key] > 1
      )
        throw maskBrushValidationError(
          `${pointPath}.${key}`,
          'Expected a finite normalized canonical source coordinate from 0 through 1.',
        )
  }
}

export function validateBrushId(value: unknown, path: string): void {
  if (typeof value !== 'string' || !new RegExp(maskBrushIdSchema.pattern).test(value))
    throw maskBrushValidationError(
      path,
      'Expected a lowercase UUID identifying the mask or its owned component.',
    )
}
