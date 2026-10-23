import {
  resolveResourcePolicy,
  type ResourcePolicySnapshot,
  type ResourceAdapterIdentity,
  type ResourceSettingsView,
} from '../shared/resource-policy'
import {
  matchResourceAdapter,
  observeResourceHardware,
  ResourceSettingsStore,
  type ResourceHardwareSnapshot,
  type ResourceSettingsFiles,
  type ResourceSettingsState,
} from './resource-settings'

/** Specific structured-clone DTO only: no paths, extra fields or string coercion. */
export function validateResourceAdapterIdentity(
  value: unknown,
): Readonly<ResourceAdapterIdentity> | null {
  if (value === null) return null
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Invalid processing adapter identity.')
  const fields = ['vendor', 'architecture', 'device', 'description'] as const,
    keys = Reflect.ownKeys(value),
    input = value as Record<string, unknown>
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) => typeof key !== 'string' || !fields.includes(key as (typeof fields)[number]),
    ) ||
    fields.some((key) => typeof input[key] !== 'string' || (input[key] as string).length > 256)
  )
    throw new Error('Invalid processing adapter identity fields.')
  return Object.freeze({
    vendor: input.vendor as string,
    architecture: input.architecture as string,
    device: input.device as string,
    description: input.description as string,
  })
}

export interface ResourceServiceOptions {
  /** Main-owned test seam; production uses fixed read-only OS observations. */
  readonly observeHardware?: () => Promise<ResourceHardwareSnapshot>
  readonly files?: ResourceSettingsFiles
}

/** Per-profile main controller. It owns no allocator, renderer, IPC channel or processing job. */
export class ResourceService {
  private readonly store: ResourceSettingsStore
  private readonly observe: () => Promise<ResourceHardwareSnapshot>
  private lastRendererAdapter: Readonly<ResourceAdapterIdentity> | null = null
  private generation = 0

  constructor(trustedProfile: string, options: ResourceServiceOptions = {}) {
    this.store = new ResourceSettingsStore(trustedProfile, options.files)
    this.observe = options.observeHardware ?? observeResourceHardware
  }

  async open() {
    await this.store.open()
  }

  /** This drains preference writes; read-only hardware observations own no publication barrier. */
  async drain() {
    await this.store.drain()
  }

  async getSettings(): Promise<ResourceSettingsView> {
    const state = await this.store.open(),
      adapter = this.lastRendererAdapter
    return this.view(state, adapter)
  }

  async saveSettings(value: unknown): Promise<ResourceSettingsView> {
    const state = await this.store.save(value),
      adapter = this.lastRendererAdapter
    try {
      return await this.view(state, adapter)
    } catch (cause) {
      // Do not imply the successful disk write was rolled back when only observation failed.
      throw new Error(
        'Resource settings were saved, but their current policy could not be observed.',
        { cause },
      )
    }
  }

  async getPolicy(value: unknown): Promise<ResourcePolicySnapshot> {
    const adapter = validateResourceAdapterIdentity(value)
    // Record request order, never completion order. Explicit null clears a stale adapter proof.
    this.lastRendererAdapter = adapter
    const state = await this.store.open()
    return this.resolve(state, adapter)
  }

  private async view(
    state: ResourceSettingsState,
    adapter: Readonly<ResourceAdapterIdentity> | null,
  ): Promise<ResourceSettingsView> {
    const policy = await this.resolve(state, adapter)
    return Object.freeze({ ...state, policy })
  }

  private async resolve(
    state: ResourceSettingsState,
    adapter: Readonly<ResourceAdapterIdentity> | null,
  ) {
    // Capture preferences before awaiting hardware. SettingsStore.open/save already return
    // detached immutable values; a later save cannot alter this admitted request.
    const settings = state.settings
    if (this.generation >= Number.MAX_SAFE_INTEGER)
      throw new Error('Resource policy generation is exhausted.')
    const generation = ++this.generation,
      hardware = await this.observe(),
      observation = matchResourceAdapter(hardware, adapter)
    return resolveResourcePolicy(settings, observation, generation)
  }
}
