import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { identityToneCurves, type CurveChannel, type ToneCurve } from '../../../shared/tone-curves'
import { curveAxis, inverseCurveAxis } from '../../../shared/tone-curves'
import {
  curveGraphRange,
  targetCurvePoint,
  moveCurvePoint,
  type CurveRange,
  type CurveView,
} from '../../../shared/curve-graph'
import type { PhotoCurveTone } from '../../../shared/curve-tone'
import type { EditController } from './useEdits'

interface TargetGesture {
  scope: object
  photoId: string
  channel: CurveChannel
  revision: number
  startY: number
  lastY: number
  range: CurveRange
  graphPixels: number
  base: ToneCurve
  points?: ToneCurve
  index?: number
  sample?: PhotoCurveTone
  released: boolean
  changed: boolean
  pending: Promise<void>
}

export function useToneCurves(
  edits: EditController,
  photoId: string | undefined,
  enabled: boolean,
  previewReady: boolean,
  hdr: boolean,
) {
  const scope = useMemo(() => ({ photoId, enabled }), [photoId, enabled])
  const [channel, setChannel] = useState<CurveChannel>('master')
  const [selected, setSelected] = useState(0)
  const [choice, setChoice] = useState<{ scope: object; view: CurveView } | null>(null)
  const [targeting, setTargeting] = useState<object | null>(null)
  const [targetRange, setTargetRange] = useState<{
    scope: object
    channel: CurveChannel
    revision: number
    range: CurveRange
  } | null>(null)
  const [pendingScope, setPendingScope] = useState<object | null>(null)
  const pending = pendingScope === scope
  const [messageState, setMessageState] = useState<{ scope: object; text: string } | null>(null)
  const [errorState, setErrorState] = useState<{ scope: object; text: string } | null>(null)
  const message = messageState?.scope === scope ? messageState.text : ''
  const error = errorState?.scope === scope ? errorState.text : ''
  const setMessage = useCallback((text: string) => setMessageState({ scope, text }), [scope])
  const setError = useCallback((text: string) => setErrorState({ scope, text }), [scope])
  const gesture = useRef<TargetGesture | null>(null),
    graphPixels = useRef(240)
  useEffect(
    () => () => {
      gesture.current = null
    },
    [scope],
  )
  const curves = edits.adjustments.curves ?? identityToneCurves,
    points = curves[channel]
  const view = choice?.scope === scope ? choice.view : hdr ? 'hdr' : 'standard'
  const range =
    targetRange?.scope === scope &&
    targetRange.channel === channel &&
    targetRange.revision === edits.state?.revision
      ? targetRange.range
      : curveGraphRange(view, points)
  const active = enabled && targeting === scope
  const supported = enabled && previewReady && edits.confirmed && !!photoId
  const current = useRef({ scope, channel, revision: edits.state?.revision, active, edits })
  useLayoutEffect(() => {
    current.current = { scope, channel, revision: edits.state?.revision, active, edits }
  }, [scope, channel, edits, active])
  const cancelTarget = useCallback((exit = true) => {
    const prior = gesture.current
    gesture.current = null
    if (
      prior?.changed &&
      current.current.scope === prior.scope &&
      current.current.revision === prior.revision
    )
      current.current.edits.cancel()
    setPendingScope(null)
    setTargetRange(null)
    if (exit) {
      setTargeting(null)
      setMessageState(null)
    }
  }, [])
  useEffect(() => {
    if (!active) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        cancelTarget()
      }
    }
    window.addEventListener('keydown', escape)
    const off = window.irodori.onWindowBlur(() => cancelTarget())
    return () => {
      window.removeEventListener('keydown', escape)
      off()
    }
  }, [active, cancelTarget])
  const valid = (g: TargetGesture) =>
    gesture.current === g &&
    current.current.scope === g.scope &&
    current.current.channel === g.channel &&
    current.current.revision === g.revision &&
    current.current.active
  useEffect(() => {
    const g = gesture.current
    if (g && (g.scope !== scope || g.channel !== channel || g.revision !== edits.state?.revision)) {
      gesture.current = null
      setPendingScope(null)
      setTargetRange(null)
      setMessage('Edits changed. Sample the tone again.')
    }
  }, [scope, channel, edits.state?.revision, setMessage])
  const change = (next: ToneCurve) => {
    setError('')
    return edits.change({ curves: { ...curves, [channel]: next } })
  }
  const commit = () => edits.flush().catch(() => undefined)
  const applyTarget = (g: TargetGesture) => {
    if (!valid(g) || !g.points || g.index === undefined) return
    if (Math.abs(g.lastY - g.startY) < 2) {
      if (g.changed) g.pending = current.current.edits.change({ curves: { [g.channel]: g.base } })
      return
    }
    const point = g.points[g.index],
      delta =
        ((g.startY - g.lastY) / g.graphPixels) * (curveAxis(g.range.max) - curveAxis(g.range.min)),
      output = inverseCurveAxis(curveAxis(point.output) + delta),
      next = moveCurvePoint(g.points, g.index, { output })
    g.changed = true
    g.pending = current.current.edits.change({ curves: { [g.channel]: next } })
  }
  const finish = (g: TargetGesture) => {
    if (!valid(g)) return
    if (g.changed) {
      void g.pending
        .then(() => {
          if (valid(g)) {
            gesture.current = null
            setTargetRange(null)
            return current.current.edits.flush()
          }
        })
        .catch(() => undefined)
    } else {
      gesture.current = null
      setTargetRange(null)
    }
  }
  const beginTarget = (position: { x: number; y: number }, clientY: number) => {
    if (!active || !supported || edits.saving || !photoId || gesture.current) return false
    const g: TargetGesture = {
      scope,
      photoId,
      channel,
      revision: edits.state!.revision,
      startY: clientY,
      lastY: clientY,
      range: { ...range },
      graphPixels: graphPixels.current,
      base: points,
      released: false,
      changed: false,
      pending: Promise.resolve(),
    }
    gesture.current = g
    setTargetRange({ scope, channel, revision: g.revision, range: g.range })
    setPendingScope(scope)
    setError('')
    setMessage('Sampling tone…')
    void window.irodori
      .sampleCurveTone(photoId, g.revision, { ...position, channel })
      .then((sample) => {
        if (
          !valid(g) ||
          sample.photoId !== photoId ||
          sample.revision !== g.revision ||
          sample.channel !== channel
        )
          return
        g.sample = sample
        const target = targetCurvePoint(g.base, sample.input, g.range, g.graphPixels)
        g.points = target.points
        g.index = target.index
        if (!target.added) setSelected(target.index)
        setMessage(
          `Sample ${(sample.input * 100).toFixed(2)}% · ${sample.visibleSamples} visible pixels. Drag up to lighten, down to darken.`,
        )
        setPendingScope(null)
        applyTarget(g)
        if (g.changed) setSelected(target.index)
        if (g.released) finish(g)
      })
      .catch((cause) => {
        if (valid(g)) {
          gesture.current = null
          setTargetRange(null)
          setPendingScope(null)
          setMessage('')
          setError(String(cause))
        }
      })
    return true
  }
  const moveTarget = (clientY: number) => {
    const g = gesture.current
    if (!g || !valid(g) || g.released) return
    g.lastY = clientY
    applyTarget(g)
    if (g.changed && g.index !== undefined) setSelected(g.index)
  }
  const endTarget = (clientY: number) => {
    const g = gesture.current
    if (!g || !valid(g)) return
    g.lastY = clientY
    g.released = true
    applyTarget(g)
    if (g.sample) finish(g)
  }
  const switchChannel = async (next: CurveChannel) => {
    cancelTarget()
    await edits.flush()
    setChannel(next)
    setSelected(0)
    setError('')
    setMessage('')
  }
  const setView = (next: CurveView) => {
    if (!gesture.current) setChoice({ scope, view: next })
  }
  const toggleTarget = async () => {
    if (active) {
      cancelTarget()
      return
    }
    if (!supported || edits.saving) return
    await edits.flush()
    if (current.current.scope === scope) {
      setTargeting(scope)
      setMessage('Click a tone, then drag up to lighten or down to darken. Escape exits.')
      setError('')
    }
  }
  return {
    channel,
    selected: Math.min(selected, points.length - 1),
    setSelected,
    view,
    setView,
    range,
    points,
    active,
    pending,
    supported,
    message,
    error,
    setError,
    change,
    commit,
    cancel: edits.cancel,
    cancelTarget,
    switchChannel,
    toggleTarget,
    beginTarget,
    moveTarget,
    endTarget,
    setGraphPixels: useCallback((pixels: number) => {
      graphPixels.current = pixels
    }, []),
    busy: edits.saving,
    numericResetKey: `${photoId}:${edits.state?.revision}:${channel}`,
    resetKey: `${photoId}:${edits.state?.revision}:${channel}:${edits.epoch}`,
  }
}
export type ToneCurvesController = ReturnType<typeof useToneCurves>
