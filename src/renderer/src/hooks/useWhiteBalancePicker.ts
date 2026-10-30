import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditController } from './useEdits'
import type {
  PhotoWhiteBalanceProposal,
  WhiteBalanceSample,
} from '../../../shared/white-balance-picker'

const initialSample: WhiteBalanceSample = { x: 0.5, y: 0.5, diameter: 15 }
export function useWhiteBalancePicker(
  edits: EditController,
  photoId: string | undefined,
  enabled: boolean,
  previewReady: boolean,
) {
  const scope = useMemo(() => ({ photoId, enabled }), [photoId, enabled])
  const [session, setSession] = useState<{
    scope: typeof scope
    sample: WhiteBalanceSample
    proposal: PhotoWhiteBalanceProposal | null
    error: string
  } | null>(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false),
    sequence = useRef(0)
  const currentScope = useRef(scope)
  currentScope.current = scope
  useEffect(
    () => () => {
      sequence.current++
    },
    [scope],
  )
  const capable =
    edits.state?.photoId === photoId &&
    !!edits.state?.whiteBalanceProfile &&
    !edits.state?.referenceWhiteBalance &&
    !edits.state?.hdrJpeg
  const supported = enabled && previewReady && edits.confirmed && capable
  // Source readiness may briefly change while a pending numeric edit is flushed.
  // Only the photo/workspace scope owns this transient tool session.
  const active = enabled && capable && session?.scope === scope
  const cancel = useCallback(() => {
    sequence.current++
    setSession(null)
  }, [])
  useEffect(() => {
    if (!active) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        cancel()
      }
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape)
    }
  }, [active, cancel])

  const start = async () => {
    if (!supported || busy.current || !photoId) return
    const intent = ++sequence.current
    busy.current = true
    setPending(true)
    try {
      await edits.flush()
      if (currentScope.current !== scope || sequence.current !== intent) return
      setSession({ scope, sample: { ...initialSample }, proposal: null, error: '' })
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const updateSample = (patch: Partial<WhiteBalanceSample>) => {
    if (!active || busy.current) return
    sequence.current++
    setSession((value) =>
      value?.scope === scope
        ? { ...value, sample: { ...value.sample, ...patch }, proposal: null, error: '' }
        : value,
    )
  }
  const requestSample = async (position?: { x: number; y: number }) => {
    if (!active || busy.current || !photoId || !session) return
    const sample = { ...session.sample, ...position },
      intent = ++sequence.current
    busy.current = true
    setPending(true)
    setSession({ scope, sample, proposal: null, error: '' })
    try {
      await edits.flush()
      if (currentScope.current !== scope || sequence.current !== intent) return
      const confirmed = await window.irodori.getEdits(photoId)
      if (currentScope.current !== scope || sequence.current !== intent) return
      const proposal = await window.irodori.proposeWhiteBalance(photoId, confirmed.revision, sample)
      if (currentScope.current === scope && sequence.current === intent)
        setSession({ scope, sample, proposal, error: '' })
    } catch (error) {
      if (currentScope.current === scope && sequence.current === intent)
        setSession({ scope, sample, proposal: null, error: String(error) })
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const proposal =
    active && session.proposal?.revision === edits.state?.revision ? session.proposal : null
  const apply = async () => {
    if (!proposal || proposal.status !== 'valid' || busy.current || !photoId) return
    const intent = ++sequence.current
    busy.current = true
    setPending(true)
    try {
      await edits.flush()
      if (currentScope.current !== scope || sequence.current !== intent) return
      await window.irodori.updateEdits(
        photoId,
        { whiteBalance: proposal.settings },
        proposal.revision,
      )
      if (currentScope.current === scope && sequence.current === intent) cancel()
    } catch (error) {
      if (currentScope.current === scope && sequence.current === intent)
        setSession((value) =>
          value?.scope === scope ? { ...value, proposal: null, error: String(error) } : value,
        )
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return {
    supported,
    active,
    pending,
    sample: active ? session.sample : initialSample,
    proposal,
    error: active
      ? session.error ||
        (session.proposal && !proposal ? 'Edits changed. Sample the area again.' : '')
      : '',
    start,
    cancel,
    updateSample,
    requestSample,
    sampleAt: (point: { x: number; y: number }) => void requestSample(point),
    apply,
  }
}
export type WhiteBalancePickerController = ReturnType<typeof useWhiteBalancePicker>
