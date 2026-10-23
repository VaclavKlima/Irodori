import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
  DEFAULT_RESOURCE_SETTINGS,
  RESOURCE_MIB,
  resolveResourcePolicy,
  validateResourceSettings,
  type ResolvedResourceBudget,
  type ResourcePolicySnapshot,
  type ResourceSettings,
  type ResourceSettingsView,
} from '../../../shared/resource-policy'
import styles from './ResourceSettingsDialog.module.css'

interface Props {
  load: () => Promise<ResourceSettingsView>
  save: (settings: ResourceSettings) => Promise<ResourceSettingsView>
  onClose: () => void
}

interface BudgetDraft {
  mode: 'automatic' | 'custom'
  text: string
}

interface Draft {
  ram: BudgetDraft
  vram: BudgetDraft
}

const emptyDraft: Draft = {
  ram: { mode: 'automatic', text: '' },
  vram: { mode: 'automatic', text: '' },
}

function amount(bytes: number) {
  const gibibyte = RESOURCE_MIB * 1024
  if (bytes < gibibyte) return `${Math.floor(bytes / RESOURCE_MIB)} MiB`
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 3 }).format(bytes / gibibyte)} GiB`
}

function draftFrom(state: ResourceSettingsView): Draft {
  const field = (requestedMiB: number | null, effectiveBytes: number): BudgetDraft => ({
    mode: requestedMiB === null ? 'automatic' : 'custom',
    text:
      requestedMiB !== null
        ? String(requestedMiB / 1024)
        : effectiveBytes > 0
          ? String(Math.floor(effectiveBytes / RESOURCE_MIB) / 1024)
          : '',
  })
  return {
    ram: field(state.settings.ramMiB, state.policy.ram.effectiveBytes),
    vram: field(state.settings.vramMiB, state.policy.vram.effectiveBytes),
  }
}

function parseBudget(field: BudgetDraft) {
  if (field.mode === 'automatic') return { value: null, error: '' }
  const text = field.text.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))
    return { value: null, error: 'Enter a positive amount in GiB.' }
  const value = Number(text) * 1024
  if (!Number.isSafeInteger(value) || value < 1)
    return { value: null, error: 'Use whole MiB increments, such as 0.5, 1 or 1.25 GiB.' }
  try {
    validateResourceSettings({ version: 1, ramMiB: value, vramMiB: null })
    return { value, error: '' }
  } catch {
    return { value: null, error: 'This amount is outside the supported budget range.' }
  }
}

/** Use the shared policy and its last observation; this performs no hardware query. */
function automaticAtLastCheck(policy: ResourcePolicySnapshot) {
  if (policy.ram.capacityBytes === null) return null
  try {
    return resolveResourcePolicy(
      DEFAULT_RESOURCE_SETTINGS,
      {
        ram: {
          totalBytes: policy.ram.capacityBytes,
          availableBytes: policy.ram.availableBytes,
        },
        gpu:
          policy.vram.capacityStatus === 'known' &&
          policy.vram.capacityBytes !== null &&
          policy.gpuAdapterId !== null
            ? {
                status: 'matched',
                adapterId: policy.gpuAdapterId,
                totalBytes: policy.vram.capacityBytes,
                availableBytes: policy.vram.availableBytes,
              }
            : {
                status: 'unknown',
                reason: policy.vram.unknownCapacityReason ?? 'adapter-unverified',
              },
      },
      policy.revision,
    )
  } catch {
    return null
  }
}

function BudgetField({
  id,
  label,
  field,
  current,
  automatic,
  error,
  disabled,
  onChange,
}: {
  id: string
  label: string
  field: BudgetDraft
  current: ResolvedResourceBudget | undefined
  automatic: ResolvedResourceBudget | undefined
  error: string
  disabled: boolean
  onChange: (value: BudgetDraft) => void
}) {
  return (
    <fieldset className={styles.budget} disabled={disabled}>
      <legend>{label}</legend>
      <div className={styles.controls}>
        <label className={styles.mode}>
          <span className={styles.srOnly}>{label} mode</span>
          <select
            value={field.mode}
            onChange={(event) =>
              onChange({ ...field, mode: event.target.value as BudgetDraft['mode'] })
            }
          >
            <option value="automatic">Automatic</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {field.mode === 'custom' && (
          <label className={styles.value}>
            <span className={styles.srOnly}>{label} in GiB</span>
            <input
              type="text"
              inputMode="decimal"
              spellCheck={false}
              autoComplete="off"
              value={field.text}
              aria-invalid={!!error}
              aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
              onChange={(event) => onChange({ ...field, text: event.target.value })}
            />
            <span aria-hidden="true">GiB</span>
          </label>
        )}
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        {automatic
          ? `Automatic at last check: ${amount(automatic.effectiveBytes)}.`
          : 'Automatic will be resolved when the next preview opens.'}
      </p>
      {current?.capacityClamped && (
        <p className={styles.hint}>
          The saved request exceeds reported capacity. Current effective budget:{' '}
          {amount(current.effectiveBytes)}.
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={styles.error}>
          {error}
        </p>
      )}
    </fieldset>
  )
}

export function ResourceSettingsDialog({ load, save, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const loadOnOpen = useRef(load)
  const life = useRef<{
    mounted: boolean
    loading?: Promise<ResourceSettingsView>
    saving: boolean
  }>({ mounted: false, saving: false })
  const prefix = useId()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ResourceSettingsView | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')

  useLayoutEffect(() => {
    const owner = life.current,
      element = dialog.current,
      previousFocus = document.activeElement
    owner.mounted = true
    element?.showModal()
    cancel.current?.focus()
    return () => {
      owner.mounted = false
      element?.close()
      queueMicrotask(() => {
        if (!owner.mounted && previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus({ preventScroll: true })
      })
    }
  }, [])

  useEffect(() => {
    const owner = life.current
    let cancelled = false
    owner.loading ??= Promise.resolve().then(loadOnOpen.current)
    void owner.loading
      .then((result) => {
        if (cancelled || !owner.mounted) return
        validateResourceSettings(result.settings)
        setState(result)
        setDraft(draftFrom(result))
        setLoadError('')
      })
      .catch((error) => {
        if (!cancelled && owner.mounted)
          setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled && owner.mounted) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const ram = parseBudget(draft.ram),
    vram = parseBudget(draft.vram),
    settings: ResourceSettings = { version: 1, ramMiB: ram.value, vramMiB: vram.value },
    changed =
      !!state &&
      (settings.ramMiB !== state.settings.ramMiB || settings.vramMiB !== state.settings.vramMiB),
    canApply =
      !!state &&
      !loading &&
      !saving &&
      !ram.error &&
      !vram.error &&
      (changed || state.status === 'recovered'),
    automatic = state ? automaticAtLastCheck(state.policy) : null,
    unknownGpu = state?.policy.vram.capacityStatus === 'unknown',
    fallbackBytes = automatic?.vram.fallbackBytes ?? state?.policy.vram.fallbackBytes

  function close() {
    if (life.current.saving) return
    onClose()
  }

  async function apply() {
    if (!canApply || life.current.saving) return
    life.current.saving = true
    setSaving(true)
    setSaveError('')
    try {
      const result = await save(validateResourceSettings(settings))
      if (!life.current.mounted) return
      setState(result)
      setDraft(draftFrom(result))
      onClose()
    } catch (error) {
      if (life.current.mounted) setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      life.current.saving = false
      if (life.current.mounted) setSaving(false)
    }
  }

  function change(key: keyof Draft, value: BudgetDraft) {
    setDraft((previous) => ({ ...previous, [key]: value }))
    setSaveError('')
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${prefix}-heading`}
      aria-describedby={`${prefix}-scope ${prefix}-limits`}
      aria-busy={loading || saving}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header className={styles.header}>
        <h2 id={`${prefix}-heading`}>Preview memory</h2>
        <button type="button" aria-label="Close memory settings" disabled={saving} onClick={close}>
          <X size={16} />
        </button>
      </header>
      <form
        id={`${prefix}-form`}
        className={styles.body}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void apply()
        }}
      >
        <div className={styles.intro}>
          <p id={`${prefix}-scope`} className={styles.summary}>
            RAW and HDR preview buffers and caches
          </p>
          <p id={`${prefix}-limits`}>
            Applies when a preview opens. Other processing and application/driver overhead are
            additional.
          </p>
        </div>
        {loading ? (
          <p role="status">Loading resource settings…</p>
        ) : loadError ? (
          <div className={styles.notice}>
            <p role="alert">Resource settings could not be loaded. {loadError}</p>
            <button
              type="button"
              onClick={() => {
                life.current.loading = undefined
                setLoading(true)
                setLoadError('')
                setAttempt((value) => value + 1)
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {state?.status === 'recovered' && (
              <p className={styles.notice} role="status">
                {state.issue === 'invalid-settings'
                  ? 'Saved resource settings are invalid. Automatic settings are active.'
                  : 'Saved resource settings could not be read. Automatic settings are active.'}{' '}
                Apply to save these choices. Cancel leaves the saved file unchanged.
              </p>
            )}
            <BudgetField
              id={`${prefix}-ram`}
              label="RAM budget"
              field={draft.ram}
              current={state?.policy.ram}
              automatic={automatic?.ram}
              error={ram.error}
              disabled={!state || saving}
              onChange={(value) => change('ram', value)}
            />
            <BudgetField
              id={`${prefix}-vram`}
              label="GPU memory budget"
              field={draft.vram}
              current={state?.policy.vram}
              automatic={automatic?.vram}
              error={vram.error}
              disabled={!state || saving}
              onChange={(value) => change('vram', value)}
            />
            {unknownGpu && (
              <p className={styles.hint}>
                GPU capacity could not be verified for the processing adapter.{' '}
                {draft.vram.mode === 'automatic'
                  ? fallbackBytes !== null && fallbackBytes !== undefined
                    ? `Automatic uses ${amount(fallbackBytes)} as a fallback budget.`
                    : 'Automatic uses a fallback budget until capacity is verified.'
                  : 'A custom request does not confirm that this amount is available.'}
              </p>
            )}
            {saveError && (
              <p className={styles.error} role="alert">
                {saveError}
              </p>
            )}
          </>
        )}
      </form>
      <footer className={styles.footer}>
        <p aria-live="polite">
          {saving ? 'Saving settings…' : 'Changes are saved only when you apply.'}
        </p>
        <div>
          <button ref={cancel} type="button" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button type="submit" form={`${prefix}-form`} disabled={!canApply}>
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </footer>
    </dialog>
  )
}
