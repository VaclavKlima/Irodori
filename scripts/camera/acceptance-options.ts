import type { CameraSetting } from '../../src/main/camera-control/model.ts'

export function acceptanceOptions(args: string[]) {
  let mode: 'discover' | 'inspect' | 'controls' | 'run' = 'discover'
  let selector: { kind: 'serial' | 'camera-id'; value: string } | undefined
  const usage =
    'Use camera:acceptance [--inspect|--controls|--run] [--serial <exact USB serial>|--camera-id <discovered-id>]. Never select a camera implicitly.'
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (['--inspect', '--controls', '--run'].includes(arg)) {
      if (mode !== 'discover') throw new Error(usage)
      mode = arg.slice(2) as typeof mode
    } else if (arg === '--serial' || arg === '--camera-id') {
      const value = args[++index]
      if (
        selector ||
        !value ||
        value.startsWith('--') ||
        value.length > 256 ||
        [...value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error(usage)
      if (arg === '--camera-id' && !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(usage)
      selector = { kind: arg.slice(2) as 'serial' | 'camera-id', value }
    } else throw new Error(usage)
  }
  if (mode !== 'discover' && !selector) throw new Error(usage)
  return { mode: mode === 'discover' && selector ? 'inspect' : mode, selector }
}

export function selectAcceptanceCamera<T extends { id: string; serial?: string }>(
  cameras: T[],
  selector: { kind: 'serial' | 'camera-id'; value: string },
): T {
  const matching = cameras.filter(
    (camera) => (selector.kind === 'serial' ? camera.serial : camera.id) === selector.value,
  )
  if (matching.length !== 1)
    throw new Error('The exact requested camera is absent or ambiguous. No camera was selected.')
  return matching[0]
}

/** Matching read-only values need no write, even when the camera omits their enum. */
export function acceptanceValue(
  settings: Pick<CameraSetting, 'id' | 'value' | 'writable' | 'choices'>[],
  id: string,
  preferred: readonly string[],
): string {
  const setting = settings.find((setting) => setting.id === id)
  if (setting && preferred.includes(setting.value)) return setting.value
  const value = setting?.writable && preferred.find((value) => setting.choices.includes(value))
  if (value) return value
  throw new Error(
    `Acceptance requires an advertised ${id} choice: ${preferred.join(' / ')}; unavailable readback ${JSON.stringify(setting ? { value: setting.value, writable: setting.writable, choices: setting.choices } : null)}. Inspect physical setup first.`,
  )
}

export function acceptancePatch(
  settings: Pick<CameraSetting, 'id' | 'value' | 'writable' | 'choices'>[],
  id: string,
  value: string,
): Record<string, string> {
  const setting = settings.find((setting) => setting.id === id)
  if (!setting) throw new Error(`${id}: value is not advertised.`)
  if (setting.value === value) return {}
  if (!setting.writable) throw new Error(`${id}: change this read-only value on the camera.`)
  if (!setting.choices.includes(value)) throw new Error(`${id}: value is not advertised.`)
  return { [id]: value }
}

export function acceptanceSettings(
  settings: Pick<CameraSetting, 'id' | 'value' | 'writable' | 'choices'>[],
  requested: Record<string, string[]>,
) {
  const result: Record<string, string> = {}
  for (const [id, preferred] of Object.entries(requested))
    Object.assign(result, acceptancePatch(settings, id, acceptanceValue(settings, id, preferred)))
  return result
}

export function acceptanceAlternate(
  setting: { id: string; value: string; choices: string[]; writable?: boolean } | undefined,
): string | undefined {
  if (!setting || setting.writable === false) return undefined
  const choices = setting.choices.filter(
    (value) =>
      value !== setting.value &&
      !/^auto/i.test(value) &&
      !/multi.?frame|noise reduction/i.test(value) &&
      !value.startsWith('0/'),
  )
  if (setting.id === 'aperture') {
    const numeric = (value: string) => Number(value.replace(/^f\//, ''))
    const current = numeric(setting.value)
    const ordered = choices
      .filter((value) => Number.isFinite(numeric(value)))
      .sort((a, b) => numeric(a) - numeric(b))
    return ordered.find((value) => numeric(value) > current) ?? ordered.at(-1)
  }
  const current = setting.choices.indexOf(setting.value)
  if (current >= 0 && ['iso', 'exposureCompensation'].includes(setting.id))
    choices.sort(
      (a, b) =>
        Math.abs(setting.choices.indexOf(a) - current) -
        Math.abs(setting.choices.indexOf(b) - current),
    )
  return choices[0]
}

export function automaticCameraReadouts(mode: string): string[] {
  if (/^(Program|P)$/i.test(mode)) return ['aperture', 'shutterSpeed']
  if (/^(Aperture priority|A)$/i.test(mode)) return ['shutterSpeed']
  if (/^(Shutter priority|S)$/i.test(mode)) return ['aperture']
  return []
}

export function restorationDifferences(
  before: Pick<CameraSetting, 'id' | 'value'>[],
  after: Pick<CameraSetting, 'id' | 'value'>[],
): string[] {
  const automatic = new Set(
      automaticCameraReadouts(before.find((setting) => setting.id === 'exposureMode')?.value ?? ''),
    ),
    actual = new Map(after.map((setting) => [setting.id, setting.value]))
  // Unmapped gphoto paths include clocks, battery and capture counters. They are
  // inspection diagnostics, rather than photographic settings to restore.
  return before
    .filter(
      ({ id, value }) => !id.startsWith('/') && !automatic.has(id) && actual.get(id) !== value,
    )
    .map(({ id }) => id)
}
