import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EditController } from './useEdits'
import {
  cropGeometry,
  identityCrop,
  quarterTurnedSize,
  rotateCrop,
  type CropSettings,
  type PhotoCropContext,
} from '../../../shared/crop'
import { fitCropDraft, moveCrop } from '../../../shared/crop-authoring'

export type CommitCrop = (
  photoId: string,
  crop: CropSettings,
  expectedRevision: number,
) => Promise<unknown>

export function useCrop(
  edits: EditController,
  photoId: string | undefined,
  enabled: boolean,
  previewReady: boolean,
  commit: CommitCrop,
) {
  const scope = useMemo(() => ({ photoId, enabled }), [photoId, enabled])
  type Session = {
    scope: typeof scope
    context: PhotoCropContext
    draft: CropSettings
    epoch: number
    error: string
    stale: boolean
  }
  const [session, setSession] = useState<Session | null>(null)
  const [pending, setPending] = useState(false)
  const [applying, setApplying] = useState(false)
  const [failure, setFailure] = useState<{ scope: typeof scope; message: string } | null>(null)
  const current = useRef<Session | null>(null),
    currentScope = useRef(scope),
    gesture = useRef<CropSettings | null>(null),
    sequence = useRef(0),
    busy = useRef(false),
    committing = useRef(false)
  useLayoutEffect(() => {
    currentScope.current = scope
  }, [scope])
  const publish = useCallback((next: Session | null) => {
    current.current = next
    setSession(next)
  }, [])
  const cancel = useCallback(() => {
    if (committing.current) return
    sequence.current++
    gesture.current = null
    publish(null)
  }, [publish])
  useEffect(
    () => () => {
      sequence.current++
      current.current = null
      gesture.current = null
    },
    [scope],
  )
  useEffect(
    () =>
      window.irodori.onLibraryEvent((event) => {
        const value = current.current,
          changed = event.editsChanged
        if (
          value?.scope === scope &&
          changed &&
          changed.photoId === photoId &&
          changed.revision > value.context.revision
        )
          publish({ ...value, stale: true, error: 'Edits changed. Cancel crop and open it again.' })
      }),
    [scope, photoId, publish],
  )
  const active = enabled && session?.scope === scope
  const suspendHistory = edits.suspendHistory
  useEffect(() => {
    if (active || pending) return suspendHistory?.()
  }, [active, pending, suspendHistory])
  useEffect(() => {
    if (!active && !pending) return
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
  }, [active, pending, cancel])

  const supported =
    enabled && !!photoId && edits.state?.photoId === photoId && edits.confirmed && previewReady
  const start = async () => {
    if (!supported || busy.current || !photoId) return
    const intent = ++sequence.current
    busy.current = true
    setPending(true)
    setFailure(null)
    const fresh = () => currentScope.current === scope && sequence.current === intent
    try {
      await edits.flush()
      if (!fresh()) return
      const confirmed = await window.irodori.getEdits(photoId)
      if (!fresh()) return
      const context = await window.irodori.getCropContext(photoId, confirmed.revision)
      if (!fresh()) return
      if (context.photoId !== photoId || context.revision !== confirmed.revision)
        throw new Error('Crop context does not match this photograph.')
      cropGeometry(context.source, context.settings)
      gesture.current = null
      publish({
        scope,
        context: structuredClone(context),
        draft: { ...context.settings },
        epoch: 0,
        error: '',
        stale: false,
      })
    } catch (error) {
      if (fresh()) setFailure({ scope, message: String(error) })
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const replace = (next: (value: Session) => CropSettings, fieldGesture = false) => {
    const value = current.current
    if (value?.scope !== scope || value.stale || busy.current) return
    try {
      const draft = next(value)
      cropGeometry(value.context.source, draft)
      if (fieldGesture) gesture.current ??= value.draft
      publish({ ...value, draft: { ...draft }, error: '' })
    } catch (error) {
      publish({ ...value, error: String(error) })
    }
  }
  const beginGesture = () => {
    const value = current.current
    if (value?.scope === scope && !value.stale && !busy.current) gesture.current ??= value.draft
  }
  const commitGesture = () => {
    gesture.current = null
    const value = current.current
    if (value?.scope === scope) publish({ ...value, epoch: value.epoch + 1 })
  }
  const cancelGesture = () => {
    const value = current.current,
      previous = gesture.current
    gesture.current = null
    if (value?.scope === scope && previous && !value.stale)
      publish({ ...value, draft: previous, epoch: value.epoch + 1, error: '' })
  }
  const field = (key: 'angle' | 'width' | 'height' | 'centerX' | 'centerY', amount: number) => {
    replace((value) => {
      const source = value.context.source,
        draft = value.draft,
        turned = quarterTurnedSize(source, draft.quarterTurns)
      if (key === 'centerX' || key === 'centerY') {
        const distance = amount - draft[key] * (key === 'centerX' ? turned.width : turned.height),
          q = draft.quarterTurns,
          // Translate a numeric quarter-turned axis back to the original native axes.
          delta =
            key === 'centerX'
              ? [
                  { x: distance, y: 0 },
                  { x: 0, y: -distance },
                  { x: -distance, y: 0 },
                  { x: 0, y: distance },
                ][q]
              : [
                  { x: 0, y: distance },
                  { x: distance, y: 0 },
                  { x: 0, y: -distance },
                  { x: -distance, y: 0 },
                ][q]
        return moveCrop(source, draft, delta)
      }
      return fitCropDraft(source, draft, {
        [key]: key === 'angle' ? amount : amount / (key === 'width' ? turned.width : turned.height),
      })
    }, true)
  }
  const command = (next: (value: Session) => CropSettings) => {
    gesture.current = null
    replace(next)
    commitGesture()
  }
  const apply = async () => {
    const value = current.current
    if (value?.scope !== scope || value.stale || value.error || busy.current || !photoId) return
    const intent = ++sequence.current
    busy.current = true
    committing.current = true
    setApplying(true)
    setPending(true)
    try {
      await edits.flush()
      if (currentScope.current !== scope || sequence.current !== intent) return
      await commit(photoId, structuredClone(value.draft), value.context.revision)
      committing.current = false
      if (currentScope.current === scope && sequence.current === intent) cancel()
    } catch (error) {
      if (currentScope.current === scope && sequence.current === intent)
        publish({ ...(current.current ?? value), error: String(error) })
    } finally {
      busy.current = false
      committing.current = false
      setApplying(false)
      setPending(false)
    }
  }
  const visible = active ? session : null
  return {
    supported,
    active,
    pending,
    applying,
    context: visible?.context ?? null,
    draft: visible?.draft ?? null,
    geometry: visible ? cropGeometry(visible.context.source, visible.draft) : null,
    epoch: visible?.epoch ?? 0,
    stale: !!visible?.stale,
    error: visible?.error || (failure?.scope === scope ? failure.message : ''),
    start,
    cancel,
    apply,
    field,
    beginGesture,
    commitGesture,
    cancelGesture,
    setDraft: (draft: CropSettings) => replace(() => draft),
    editDraft: (
      change: (draft: CropSettings, source: PhotoCropContext['source']) => CropSettings,
    ) => replace((value) => change(value.draft, value.context.source)),
    rotate: (direction: -1 | 1) => command((value) => rotateCrop(value.draft, direction)),
    reset: () => command(() => ({ ...identityCrop })),
    aspect: (aspectRatio: number | null, fieldGesture = false) => {
      const change = (value: Session) =>
        fitCropDraft(value.context.source, value.draft, { aspectRatio })
      if (fieldGesture) replace(change, true)
      else command(change)
    },
  }
}
export type CropController = ReturnType<typeof useCrop>
