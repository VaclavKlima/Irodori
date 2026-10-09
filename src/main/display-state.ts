import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HDR_OUTPUT_VERSION,
  SDR_TARGET,
  type DisplayCapabilities,
  type DisplayTarget,
} from '../shared/hdr'
import { linearHeadroom, type PreviewPreference } from '../shared/hdr-display'

export class DisplayState {
  private presentation?: import('../shared/preview-diagnostics').PreviewPresentation
  reportPresentation(value: import('../shared/preview-diagnostics').PreviewPresentation) {
    if (value.targetGeneration !== this.state.generation) return
    this.presentation = value
    this.changed(this.get())
  }
  private preference: PreviewPreference = 'auto'
  private capabilities: DisplayCapabilities = {
    headroomStops: null,
    hardware: false,
    extended: false,
    p3: false,
    reason: 'Checking display capabilities.',
  }
  private state: DisplayTarget = {
    ...SDR_TARGET,
    requested: 'auto',
    reason: this.capabilities.reason,
  }
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private profile: string,
    private changed: (state: DisplayTarget) => void,
    private refresh?: () => void,
  ) {}
  async open() {
    try {
      const value = JSON.parse(
        await readFile(join(this.profile, 'preview-preference.json'), 'utf8'),
      )
      if (['auto', 'hdr', 'sdr'].includes(value.preference)) this.preference = value.preference
    } catch {
      /* Missing or damaged workspace preferences use Auto. */
    }
    this.recompute()
  }
  get() {
    return { ...this.state, capabilities: this.capabilities, presentation: this.presentation }
  }
  set(preference: PreviewPreference) {
    if (!['auto', 'hdr', 'sdr'].includes(preference))
      return Promise.reject(new Error('Invalid preview preference.'))
    const work = this.tail.then(async () => {
      const path = join(this.profile, 'preview-preference.json')
      await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, preference }))
      await rename(`${path}.tmp`, path)
      this.preference = preference
      this.recompute()
      this.refresh?.()
      return this.get()
    })
    this.tail = work.catch(() => undefined)
    return work
  }
  report(value: DisplayCapabilities) {
    if (
      !value ||
      ['hardware', 'extended', 'p3'].some(
        (key) => typeof value[key as keyof DisplayCapabilities] !== 'boolean',
      ) ||
      !(
        value.headroomStops === null ||
        (typeof value.headroomStops === 'number' && Number.isFinite(value.headroomStops))
      ) ||
      typeof value.reason !== 'string' ||
      value.reason.length > 512
    )
      throw new Error('Invalid display capabilities.')
    if (JSON.stringify(value) === JSON.stringify(this.capabilities)) return this.get()
    this.capabilities = { ...value }
    this.recompute()
    return this.get()
  }
  invalidate(reason: string) {
    this.capabilities = { ...this.capabilities, extended: false, reason }
    this.recompute()
  }
  private recompute() {
    const caps = this.capabilities,
      headroom = linearHeadroom(caps.headroomStops)
    const available = caps.hardware && caps.extended && headroom !== null && headroom > 1
    const hdr = this.preference !== 'sdr' && available
    this.state = {
      generation: this.state.generation + 1,
      requested: this.preference,
      mode: hdr ? 'hdr' : 'sdr',
      colorSpace: caps.p3 && caps.hardware ? 'display-p3' : 'srgb',
      peak: hdr ? Math.min(100, headroom!) : 1,
      headroom,
      reason: hdr
        ? 'Experimental HDR; physical luminance is unverified.'
        : this.preference === 'sdr'
          ? 'SDR comparison selected.'
          : caps.reason ||
            (!caps.hardware
              ? 'A hardware WebGPU adapter is unavailable.'
              : !caps.extended
                ? 'Extended canvas is unsupported.'
                : headroom === null
                  ? 'Display headroom is unavailable.'
                  : 'The current monitor reports no HDR headroom.'),
      physicalOutputVerified: false,
      outputVersion: HDR_OUTPUT_VERSION,
    }
    this.changed(this.get())
  }
}
