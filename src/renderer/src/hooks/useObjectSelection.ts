import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ObjectSelectionContext,
  ObjectSelectionPrompts,
  ObjectSelectionProposal,
  ObjectSelectionRequest,
} from '../../../shared/object-selection'
import type { SelectionPoint, SelectionRectangle } from '../preview/object-selection-geometry'

export type ObjectSelectionMode = 'box' | 'add' | 'subtract'
export interface SelectionPlacement {
  mode: 'add' | 'subtract'
  point: [number, number]
  display: SelectionPoint
}
interface Dependencies {
  photoId: string | undefined
  revision: number | undefined
  enabled: boolean
  /** Flush edits and acquire an authoritative, revision-bound context. */
  prepare: () => Promise<ObjectSelectionContext>
  generate: (request: ObjectSelectionRequest) => Promise<ObjectSelectionProposal>
  accept: (proposal: ObjectSelectionProposal) => Promise<void>
  cancel: (photoId: string) => Promise<void>
  onActivate: () => void
}
interface Session {
  photoId: string
  context?: ObjectSelectionContext
  maskId?: string
  mode: ObjectSelectionMode
  rectangle?: SelectionRectangle
  box?: [number, number, number, number]
  points: SelectionPlacement[]
  proposal?: ObjectSelectionProposal
  proposalPrompts?: string
  previewReady?: boolean
  status: 'preparing' | 'idle' | 'generating' | 'accepting'
  error: string
}
const promptsFor = (session: Session): ObjectSelectionPrompts => ({
  ...(session.box ? { box: [...session.box] as [number, number, number, number] } : {}),
  positivePoints: session.points
    .filter((point) => point.mode === 'add')
    .map((point) => [...point.point]),
  negativePoints: session.points
    .filter((point) => point.mode === 'subtract')
    .map((point) => [...point.point]),
})

/** Temporary proposals own no edit history. Only explicit acceptance publishes a mask. */
export function useObjectSelection(dependencies: Dependencies) {
  const current = useRef(dependencies)
  const [session, setSession] = useState<Session | null>(null)
  const sessionRef = useRef(session)
  const epoch = useRef(0)
  useLayoutEffect(() => {
    current.current = dependencies
  })
  const publish = useCallback((value: Session | null) => {
    sessionRef.current = value
    setSession(value)
  }, [])
  const close = useCallback(() => {
    epoch.current++
    const photoId = sessionRef.current?.photoId
    publish(null)
    if (photoId) void current.current.cancel(photoId).catch(() => undefined)
  }, [publish])
  useEffect(() => {
    const value = sessionRef.current
    if (!value) return
    if (!dependencies.enabled || dependencies.photoId !== value.photoId) close()
    else if (
      value.context &&
      dependencies.revision !== value.context.revision &&
      value.status !== 'accepting'
    ) {
      epoch.current++
      void current.current.cancel(value.photoId).catch(() => undefined)
      publish({
        ...value,
        context: undefined,
        proposal: undefined,
        status: 'idle',
        error: 'Edits changed. Start the object selection again.',
      })
    }
  }, [dependencies.enabled, dependencies.photoId, dependencies.revision, close, publish])
  useEffect(
    () => () => {
      epoch.current++
      const photoId = sessionRef.current?.photoId
      if (photoId) void current.current.cancel(photoId).catch(() => undefined)
    },
    [],
  )
  const hasSession = !!session
  useEffect(() => {
    if (!hasSession) return
    const escape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        sessionRef.current?.status === 'accepting' ||
        (event.target as HTMLElement).closest('input, textarea, select, #agent-console')
      )
        return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [hasSession, close])
  const start = useCallback(
    async (maskId?: string) => {
      const value = current.current
      if (!value.enabled || !value.photoId) return
      const token = ++epoch.current
      const photoId = value.photoId
      const previous = sessionRef.current?.photoId
      value.onActivate()
      publish({ photoId, maskId, mode: 'box', points: [], status: 'preparing', error: '' })
      try {
        if (previous) await value.cancel(previous)
        if (token !== epoch.current) return
        const context = await value.prepare()
        if (token !== epoch.current || current.current.photoId !== photoId) return
        if (context.photoId !== photoId)
          throw new Error('The photograph changed. Start selection again.')
        publish({ photoId, maskId, context, mode: 'box', points: [], status: 'idle', error: '' })
      } catch (error) {
        if (token === epoch.current)
          publish({
            photoId,
            maskId,
            mode: 'box',
            points: [],
            status: 'idle',
            error: String(error),
          })
      }
    },
    [publish],
  )
  const change = (update: (value: Session) => Session) => {
    const value = sessionRef.current
    if (!value?.context || value.status !== 'idle') return
    publish(update(value))
  }
  const generate = useCallback(async () => {
    const value = sessionRef.current
    if (
      !value?.context ||
      value.status !== 'idle' ||
      (!value.box && !value.points.some((point) => point.mode === 'add'))
    )
      return
    const token = ++epoch.current
    const prompts = promptsFor(value)
    publish({ ...value, status: 'generating', error: '' })
    try {
      const proposal = await current.current.generate({
        photoId: value.photoId,
        expectedRevision: value.context.revision,
        gridIdentity: value.context.gridIdentity,
        prompts,
        ...(value.maskId ? { maskId: value.maskId } : {}),
      })
      if (token !== epoch.current || current.current.photoId !== value.photoId) return
      if (
        proposal.photoId !== value.photoId ||
        proposal.revision !== value.context.revision ||
        proposal.gridIdentity !== value.context.gridIdentity
      )
        throw new Error('The selection belongs to an older photograph grid. Start again.')
      publish({
        ...value,
        proposal,
        proposalPrompts: JSON.stringify(prompts),
        previewReady: false,
        status: 'idle',
        error: '',
      })
    } catch (error) {
      if (token === epoch.current) publish({ ...value, status: 'idle', error: String(error) })
    }
  }, [publish])
  const accept = useCallback(async () => {
    const value = sessionRef.current
    if (
      !value?.proposal ||
      value.status !== 'idle' ||
      value.proposalPrompts !== JSON.stringify(promptsFor(value)) ||
      !value.previewReady ||
      !!value.error
    )
      return
    const token = ++epoch.current
    publish({ ...value, status: 'accepting', error: '' })
    try {
      await current.current.accept(value.proposal)
      if (token === epoch.current) publish(null)
    } catch (error) {
      if (token === epoch.current) publish({ ...value, status: 'idle', error: String(error) })
    }
  }, [publish])
  const active = !!session && session.photoId === dependencies.photoId
  const value = active ? session : null
  const prompts = value ? promptsFor(value) : { positivePoints: [], negativePoints: [] }
  const busy = !!value && value.status !== 'idle'
  const dirty = !!value?.proposal && value.proposalPrompts !== JSON.stringify(prompts)
  return {
    active,
    busy,
    available: dependencies.enabled,
    context: value?.context,
    mode: value?.mode ?? 'box',
    rectangle: value?.rectangle,
    points: value?.points ?? [],
    prompts,
    maskId: value?.maskId,
    proposal: value?.proposal,
    dirty,
    error: value?.error ?? '',
    status: value?.status,
    canGenerate:
      !!value?.context &&
      !busy &&
      (!!value.box || value.points.some((point) => point.mode === 'add')),
    canAccept: !!value?.proposal && !busy && !dirty && !!value.previewReady && !value.error,
    previewReady: !!value?.previewReady,
    start,
    close,
    generate,
    accept,
    pointMode: (mode: ObjectSelectionMode) => change((value) => ({ ...value, mode })),
    setBox: (rectangle: SelectionRectangle, box: [number, number, number, number]) =>
      change((value) => ({ ...value, rectangle, box, error: '' })),
    addPoint: (point: [number, number], display: SelectionPoint, mode: 'add' | 'subtract') =>
      change((value) =>
        value.points.length >= 4
          ? {
              ...value,
              error:
                'Four guide points are available. Remove a point or use Paint/Erase after accepting.',
            }
          : { ...value, points: [...value.points, { point, display, mode }], error: '' },
      ),
    removeLast: () =>
      change((value) => ({ ...value, points: value.points.slice(0, -1), error: '' })),
    clear: () =>
      change((value) => ({
        ...value,
        rectangle: undefined,
        box: undefined,
        points: [],
        proposal: undefined,
        proposalPrompts: undefined,
        error: '',
      })),
    cancelJob: () => {
      const value = sessionRef.current
      if (!value || value.status === 'accepting') return
      epoch.current++
      void current.current.cancel(value.photoId).catch(() => undefined)
      publish({ ...value, status: 'idle', error: '' })
    },
    setError: (error: string) => {
      const value = sessionRef.current
      if (value) publish({ ...value, error })
    },
    setProposalReady: (proposalId: string) => {
      const value = sessionRef.current
      if (value?.proposal?.id === proposalId && !value.previewReady)
        publish({ ...value, previewReady: true })
    },
  }
}
export type ObjectSelectionController = ReturnType<typeof useObjectSelection>
