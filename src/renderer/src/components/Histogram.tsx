import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChartColumn, Eye } from 'lucide-react'
import type { PreviewTools } from '../hooks/usePreviewTools'
import { InspectorSection } from './InspectorSection'
import styles from './Histogram.module.css'
export function Histogram({
  tools,
  ready,
  expanded: open,
  onToggle,
}: {
  tools: PreviewTools
  ready: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const clippingStatusId = useId()
  const [bin, setBin] = useState(128)
  const hdr = tools.analysis && 'domain' in tools.analysis ? tools.analysis : undefined
  const data =
    !tools.hdr && tools.analysis && !('domain' in tools.analysis) ? tools.analysis : undefined
  const descriptor = hdr?.rgbHistogram
  const channels = descriptor?.rgb ?? data?.rgb
  const bins = channels?.[0].length ?? (tools.hdr ? 512 : 256)
  const activeBin = Math.min(bin, bins - 1)
  const paths = useRef<(SVGPathElement | null)[]>([])
  const curves = useRef<number[][]>([])
  const frame = useRef(0)
  const animation = useRef<{
    from: number[][]
    target: number[][]
    started: number
    reduced: boolean
    serial?: number
  } | null>(null)
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      animation.current = null
      const plot = paths.current[0]?.ownerSVGElement
      if (plot) plot.setAttribute('data-animating', 'false')
    },
    [],
  )
  useLayoutEffect(() => {
    const plot = paths.current[0]?.ownerSVGElement
    if (!open || !channels) {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      animation.current = null
      if (plot) plot.setAttribute('data-animating', 'false')
      return
    }
    const max = Math.max(1, ...channels.flat())
    const target = channels.map((values) => values.map((count) => 96 - (count / max) * 94))
    const from =
      curves.current.length && curves.current[0].length === bins
        ? curves.current.map((v) => v.slice())
        : target
    animation.current = {
      from,
      target,
      started: performance.now(),
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      serial: hdr?.editSerial,
    }
    if (plot) plot.setAttribute('data-animating', 'true')
    // Retarget the pending paint so continuous edits cannot cancel every next frame.
    if (frame.current) return
    const animate = (time: number) => {
      frame.current = 0
      const current = animation.current
      if (!current) return
      const fraction = current.reduced ? 1 : Math.min(1, (time - current.started) / 80)
      curves.current = current.target.map((values, c) =>
        values.map((v, i) => current.from[c][i] + (v - current.from[c][i]) * fraction),
      )
      curves.current.forEach((values, c) =>
        paths.current[c]?.setAttribute(
          'd',
          `M0,96 ${values.map((y, i) => `L${(i * 256) / values.length},${y}`).join(' ')} L255,96Z`,
        ),
      )
      const plot = paths.current[0]?.ownerSVGElement
      if (plot && current.serial !== undefined)
        plot.dataset.curveEditSerial = String(current.serial)
      if (fraction < 1) frame.current = requestAnimationFrame(animate)
      else {
        animation.current = null
        if (plot) plot.setAttribute('data-animating', 'false')
      }
    }
    frame.current = requestAnimationFrame(animate)
  }, [channels, bins, open, hdr?.editSerial])
  const label = tools.mode === 'before' ? 'Before' : 'After'
  const percent = (count: number) =>
    `${((100 * count) / (data?.visiblePixels || descriptor?.visiblePixels || 1)).toFixed(2)}%`
  const readout = channels
    ? `${descriptor?.mode === 'hdr' && activeBin >= 256 ? `+${(((activeBin - 256) * descriptor.maxStops) / 256).toFixed(2)} stops` : `Value ${activeBin}`} · R ${percent(channels[0][activeBin])} · G ${percent(channels[1][activeBin])} · B ${percent(channels[2][activeBin])}`
    : 'Preparing histogram…'
  return (
    <InspectorSection
      id="histogram"
      title={`Histogram · ${label}`}
      icon={ChartColumn}
      expanded={open}
      onToggle={onToggle}
      bodyClassName={styles.content}
      bodyProps={{
        'data-edit-serial': hdr?.editSerial,
        'data-samples': hdr?.visiblePixels,
        'aria-busy': !!tools.analysisPending,
        'data-pending': !!tools.analysisPending,
      }}
    >
      <div className={styles.heading}>
        <span>{tools.hdr ? 'Rec.2020 · HDR content' : 'sRGB · SDR'}</span>
        {tools.hdr && (
          <button
            className={styles.eye}
            aria-label="Show HDR ranges"
            aria-pressed={tools.hdrRanges}
            disabled={!ready}
            title="Show HDR content brightness ranges. Red indicates content luminance above reported display headroom."
            onClick={() => tools.update({ hdrRanges: !tools.hdrRanges })}
          >
            <Eye size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <svg
        className={styles.plot}
        viewBox="0 0 256 96"
        preserveAspectRatio="none"
        role="slider"
        tabIndex={0}
        aria-label="Histogram tonal value"
        aria-valuemin={0}
        aria-valuemax={bins - 1}
        aria-valuenow={activeBin}
        aria-valuetext={readout}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setBin(
            Math.max(
              0,
              Math.min(bins - 1, Math.floor(((event.clientX - box.left) / box.width) * bins)),
            ),
          )
        }}
        onKeyDown={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            setBin(
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? bins - 1
                  : Math.max(
                      0,
                      Math.min(bins - 1, activeBin + (event.key === 'ArrowLeft' ? -1 : 1)),
                    ),
            )
          }
        }}
      >
        {[24, 48, 72].map((y) => (
          <line key={y} x1="0" x2="256" y1={y} y2={y} stroke="#333" strokeWidth="0.5" />
        ))}
        {tools.hdr && (
          <>
            <rect x="128" y="0" width="128" height="96" fill="#fff" fillOpacity="0.025" />
            <line x1="128" x2="128" y1="0" y2="96" stroke="#888" strokeWidth="0.6" />
            {[1, 2, 3, 4].map((stop) => (
              <g key={stop}>
                <line
                  x1={128 + (stop / 4) * 128}
                  x2={128 + (stop / 4) * 128}
                  y1="0"
                  y2="96"
                  stroke="#555"
                  strokeWidth="0.4"
                />
                <text x={126 + (stop / 4) * 128} y="10" textAnchor="end" fill="#aaa" fontSize="8">
                  +{stop}
                </text>
              </g>
            ))}
            {descriptor?.displayLimitStops != null && (
              <line
                x1={128 + (Math.min(4, descriptor.displayLimitStops) / 4) * 128}
                x2={128 + (Math.min(4, descriptor.displayLimitStops) / 4) * 128}
                y1="12"
                y2="96"
                stroke="#ddd"
                strokeDasharray="2 2"
                strokeWidth="0.7"
              >
                <title>Current display limit</title>
              </line>
            )}
            <text x="126" y="92" textAnchor="end" fill="#aaa" fontSize="8">
              White
            </text>
            <text x="130" y="92" fill="#aaa" fontSize="8">
              HDR
            </text>
          </>
        )}
        {[0, 1, 2].map((c) => (
          <path
            key={c}
            ref={(path) => {
              paths.current[c] = path
            }}
            fill={['#d97676', '#75b483', '#779aca'][c]}
            fillOpacity="0.3"
            stroke={['#d97676', '#75b483', '#779aca'][c]}
            strokeWidth="0.8"
          />
        ))}
        <line
          x1={(activeBin * 256) / bins}
          x2={(activeBin * 256) / bins}
          y1={0}
          y2={96}
          stroke="#aaa"
          strokeWidth="0.5"
        />
      </svg>
      <p
        className={styles.status}
        role="status"
        title={tools.analysisError}
        style={{
          visibility:
            tools.analysisError || !channels || tools.analysisPending ? 'visible' : 'hidden',
        }}
      >
        {tools.analysisError
          ? 'Histogram unavailable'
          : !channels
            ? 'Preparing histogram…'
            : 'Updating histogram…'}
      </p>
      {tools.hdr && tools.hdrRanges && (
        <div className={styles.legend} aria-label="HDR range legend">
          <span>
            <i style={{ background: '#00ffff' }} />
            White–+1 stop
          </span>
          <span>
            <i style={{ background: '#0000ff' }} />
            +1–+2 stops
          </span>
          <span>
            <i style={{ background: '#9900ff' }} />
            +2–+3 stops
          </span>
          <span>
            <i style={{ background: '#ff00ff' }} />
            Above +3 stops
          </span>
          <span className={styles.displayLimit}>
            <i />
            Red: above current display headroom
          </span>
        </div>
      )}
      {tools.hdr && (
        <div className={styles.indicators}>
          <button
            aria-describedby={tools.clippingError ? clippingStatusId : undefined}
            aria-pressed={!!(tools.hdrOverlay & 1)}
            onClick={() => tools.update({ hdrOverlay: tools.hdrOverlay ^ 1 })}
          >
            Canvas channel clipping
          </button>
        </div>
      )}
      {tools.hdr && tools.clippingError && (
        <p
          id={clippingStatusId}
          className={styles.status}
          role="status"
          aria-label="Clipping overlay status"
        >
          Clipping overlay unavailable.
        </p>
      )}
      {!tools.hdr && (
        <div className={styles.indicators}>
          {(['shadows', 'highlights'] as const).map((kind) => {
            const count = data
              ? kind === 'shadows'
                ? data.shadowClipped
                : data.highlightClipped
              : 0
            return (
              <button
                key={kind}
                disabled={!ready}
                aria-pressed={tools[kind]}
                aria-label={`${kind === 'shadows' ? 'Shadow' : 'Highlight'} clipping`}
                title={`${count} sampled pixels (${percent(count)} approximately). SDR display endpoints; not proof of lost RAW sensor data.`}
                onPointerEnter={() => tools.update({ hover: kind })}
                onPointerLeave={() => tools.update({ hover: null })}
                onFocus={() => tools.update({ hover: kind })}
                onBlur={() => tools.update({ hover: null })}
                onClick={() => tools.update({ [kind]: !tools[kind] })}
              >
                {kind === 'shadows' ? '◀ Shadows' : 'Highlights ▶'}
              </button>
            )
          })}
        </div>
      )}
    </InspectorSection>
  )
}
