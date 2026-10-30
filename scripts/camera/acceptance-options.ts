export function acceptanceOptions(args: string[]) {
  let mode: 'discover' | 'inspect' | 'controls' | 'run' = 'discover'
  let selector: { kind: 'serial' | 'camera-id'; value: string } | undefined
  const usage =
    'Use camera:acceptance [--inspect|--controls|--run] [--serial <exact USB serial>|--camera-id <discovered-id>]. Never select a camera implicitly.'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--inspect', '--controls', '--run'].includes(arg)) {
      if (mode !== 'discover') throw new Error(usage)
      mode = arg.slice(2) as typeof mode
    } else if (arg === '--serial' || arg === '--camera-id') {
      const value = args[++i]
      if (selector || !value || value.startsWith('--') || value.length > 256) throw new Error(usage)
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

export function acceptanceSettings(
  settings: { id: string; value: string; writable: boolean; choices: string[] }[],
  requested: Record<string, string[]>,
) {
  const result: Record<string, string> = {}
  for (const [id, preferred] of Object.entries(requested)) {
    const setting = settings.find((setting) => setting.id === id)
    if (setting && !setting.writable && preferred.includes(setting.value)) continue
    const value = setting?.writable && preferred.find((value) => setting.choices.includes(value))
    if (!value)
      throw new Error(
        `Acceptance requires an advertised ${id} choice: ${preferred.join(' / ')}. Inspect this exact camera and resolve physical setup first.`,
      )
    result[id] = value
  }
  return result
}
