import { createHash } from 'node:crypto'

export type Settings = Record<string, string>
export interface CameraIdentity {
  id: string
  provider: string
  model: string
  backendModel: string
  port: string
  connection: string
  physicalId: string
  identityConfidence: 'serial' | 'connection-only'
  serial?: string
  firmware?: string
}
export interface Verification {
  advertised: boolean
  read: boolean
  writeReadback: boolean
  capture: boolean
}
export interface CameraSetting {
  id: string
  label: string
  value: string
  writable: boolean
  reason?: string
  choices: string[]
  verification: Verification
}
export interface CameraInspection {
  settings: CameraSetting[]
  capture: { available: boolean; reason?: string; verification: Verification }
  info: Record<string, unknown>
}
export interface CameraDiscovery {
  cameras: CameraIdentity[]
  diagnostics: { provider: string; available: boolean; message: string }[]
}
export interface ProviderFile {
  filename: string
  path: string
  cameraPath?: string
  cameraBytes?: number
  cameraSha256?: string
}
export interface CameraProvider {
  id: string
  discover(): Promise<CameraDiscovery>
  open(camera: CameraIdentity): Promise<void>
  inspect(camera: CameraIdentity): Promise<CameraInspection>
  write(
    camera: CameraIdentity,
    setting: CameraSetting,
    value: string,
    onApplied?: (value: string) => Promise<void>,
  ): Promise<void>
  capture(camera: CameraIdentity, directory: string, signal: AbortSignal): Promise<ProviderFile[]>
  close(camera: CameraIdentity): Promise<void>
  inventory?(camera: CameraIdentity): Promise<{
    available: boolean
    reason?: string
    files: { key: string; bytes: number; filename: string }[]
  }>
  shutdown(): Promise<void>
}
export class CameraError extends Error {
  code: string
  uncertain: boolean
  constructor(code: string, message: string, uncertain = false) {
    super(message)
    this.code = code
    this.uncertain = uncertain
  }
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export function verification(read = true): Verification {
  return { advertised: true, read, writeReadback: false, capture: false }
}
export function exposureSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value !== 'string') return
  const fraction = value.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  const result = fraction ? Number(fraction[1]) / Number(fraction[2]) : Number(value)
  return Number.isFinite(result) && result > 0 ? result : undefined
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CameraError('invalid-request', 'Expected an object.')
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw new CameraError('invalid-request', `Expected fields: ${allowed.join(', ')}.`)
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new CameraError('invalid-request', 'Invalid identifier.')
  return value
}
export function settings(value: unknown): Settings {
  const input = object(value)
  if (
    Object.keys(input).length > 32 ||
    Object.entries(input).some(
      ([key, val]) =>
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(key) ||
        typeof val !== 'string' ||
        val.length > 200 ||
        /[\r\n\0]/.test(val),
    )
  )
    throw new CameraError('invalid-request', 'Settings require bounded string values.')
  return input as Settings
}
export type CameraAction =
  | { action: 'read-settings'; parameters: Record<string, never> }
  | { action: 'read-card-inventory'; parameters: Record<string, never> }
  | { action: 'apply-settings'; parameters: { settings: Settings } }
  | { action: 'capture'; parameters: { settings: Settings } }
  | { action: 'exposure-sequence'; parameters: { steps: Settings[] } }
export function actionRequest(action: unknown, parameters: unknown): CameraAction {
  const input = object(parameters)
  switch (action) {
    case 'read-card-inventory':
    case 'read-settings':
      keys(input, [])
      return { action, parameters: {} }
    case 'apply-settings':
    case 'capture':
      keys(input, ['settings'])
      return { action, parameters: { settings: settings(input.settings) } }
    case 'exposure-sequence':
      keys(input, ['steps'])
      if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 32)
        throw new CameraError(
          'invalid-request',
          'A software sequence requires 1–32 separate shutter releases.',
        )
      return { action, parameters: { steps: input.steps.map(settings) } }
    default:
      throw new CameraError('unavailable-action', 'Action is not advertised.')
  }
}
export function validateSettings(requested: Settings, inspection: CameraInspection) {
  for (const [id, value] of Object.entries(requested)) {
    const setting = inspection.settings.find((setting) => setting.id === id)
    if (!setting || !setting.writable || !setting.choices.includes(value))
      throw new CameraError(
        'unavailable-setting',
        `${id}: ${setting?.reason ?? 'Value is not an advertised writable choice.'}`,
      )
  }
}
export function advertisedActions(inspection: CameraInspection) {
  const values = {
    type: 'object',
    properties: Object.fromEntries(
      inspection.settings
        .filter((s) => s.writable)
        .map((s) => [s.id, { type: 'string', enum: s.choices }]),
    ),
    additionalProperties: false,
  }
  const schema = (properties: Record<string, unknown>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  })
  return [
    { id: 'read-settings', available: true, parameters: schema({}) },
    {
      id: 'read-card-inventory',
      available: true,
      parameters: schema({}),
      description:
        'Read-only card names and sizes when the provider exposes card storage; reports unavailable explicitly. No card mutation.',
    },
    {
      id: 'apply-settings',
      available: inspection.settings.some((s) => s.writable),
      parameters: schema({ settings: values }),
    },
    { id: 'capture', ...inspection.capture, parameters: schema({ settings: values }) },
    {
      id: 'exposure-sequence',
      ...inspection.capture,
      parameters: schema({ steps: { type: 'array', minItems: 1, maxItems: 32, items: values } }),
      description: 'Separate software-triggered exposures; native burst/bracketing is unverified.',
    },
    { id: 'native-burst', available: false, reason: 'Not independently verified.' },
    { id: 'native-bracketing', available: false, reason: 'Not independently verified.' },
  ]
}
