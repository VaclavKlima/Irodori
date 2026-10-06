import { useState } from 'react'
import type { PreviewTools } from '../hooks/usePreviewTools'
import layout from '../App.module.css'
import styles from './Histogram.module.css'
export function Histogram({ tools, ready }: { tools: PreviewTools; ready: boolean }) {
  const [open, setOpen] = useState(true),
    [bin, setBin] = useState(128)
  const hdr = tools.analysis && 'domain' in tools.analysis ? tools.analysis : undefined
  const data =
    !tools.hdr && tools.analysis && !('domain' in tools.analysis) ? tools.analysis : undefined
  const descriptor = hdr?.rgbHistogram
  const channels = descriptor?.rgb ?? data?.rgb
  const bins = channels?.[0].length ?? 256
  const activeBin = Math.min(bin, bins - 1)
  const max = channels ? Math.max(1, ...channels.flat()) : 1
  const label = tools.mode === 'before' ? 'Before' : 'After'
  const percent = (count: number) =>
    `${((100 * count) / (data?.visiblePixels || descriptor?.visiblePixels || 1)).toFixed(2)}%`
  const readout = channels
    ? `${descriptor?.mode === 'hdr' && activeBin >= 256 ? `+${(((activeBin - 256) * descriptor.maxStops) / 256).toFixed(2)} stops` : `Value ${activeBin}`} · R ${percent(channels[0][activeBin])} · G ${percent(channels[1][activeBin])} · B ${percent(channels[2][activeBin])}`
    : 'Preparing histogram…'
  return (
    <section className={layout.adjustmentSection}>
      <button
        className={layout.sectionToggle}
        aria-expanded={open}
        aria-controls="histogram"
        onClick={() => setOpen(!open)}
      >
        Histogram · {label}
      </button>
      {open && (
        <div id="histogram" className={styles.content}>
          <div className={styles.heading}>
            <span>
              {hdr
                ? `${hdr.colorSpace} · ${descriptor?.mode === 'hdr' ? 'HDR' : 'SDR'}`
                : tools.hdr
                  ? 'Preparing HDR analysis…'
                  : 'sRGB · SDR'}
            </span>
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
            {descriptor?.mode === 'hdr' && (
              <>
                <rect x="128" y="0" width="128" height="96" fill="#fff" fillOpacity="0.025" />
                <line x1="128" x2="128" y1="0" y2="96" stroke="#888" strokeWidth="0.6" />
                {Array.from({ length: descriptor.maxStops }, (_, i) => i + 1).map((stop) => (
                  <g key={stop}>
                    <line
                      x1={128 + (stop / descriptor.maxStops) * 128}
                      x2={128 + (stop / descriptor.maxStops) * 128}
                      y1="0"
                      y2="96"
                      stroke="#555"
                      strokeWidth="0.4"
                    />
                    <text
                      x={126 + (stop / descriptor.maxStops) * 128}
                      y="10"
                      textAnchor="end"
                      fill="#aaa"
                      fontSize="8"
                    >
                      +{stop}
                    </text>
                  </g>
                ))}
                <line
                  x1={128 + (descriptor.displayLimitStops / descriptor.maxStops) * 128}
                  x2={128 + (descriptor.displayLimitStops / descriptor.maxStops) * 128}
                  y1="12"
                  y2="96"
                  stroke="#ddd"
                  strokeDasharray="2 2"
                  strokeWidth="0.7"
                >
                  <title>Current display limit</title>
                </line>
                <text x="126" y="92" textAnchor="end" fill="#aaa" fontSize="8">
                  White
                </text>
                <text x="130" y="92" fill="#aaa" fontSize="8">
                  HDR
                </text>
              </>
            )}
            {channels?.map((values, c) => (
              <path
                key={c}
                fill={['#d97676', '#75b483', '#779aca'][c]}
                fillOpacity="0.3"
                stroke={['#d97676', '#75b483', '#779aca'][c]}
                strokeWidth="0.8"
                d={`M0,96 ${values.map((count, i) => `L${(i * 256) / bins},${96 - (count / max) * 94}`).join(' ')} L255,96Z`}
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
          {(tools.analysisError || !channels) && (
            <p className={styles.status} role="status" title={tools.analysisError}>
              {tools.analysisError ? 'Histogram unavailable' : 'Preparing histogram…'}
            </p>
          )}
          {hdr && (
            <div className={styles.indicators}>
              <button
                aria-pressed={!!(tools.hdrOverlay & 1)}
                onClick={() => tools.update({ hdrOverlay: tools.hdrOverlay ^ 1 })}
              >
                Output clipping
              </button>
            </div>
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
        </div>
      )}
    </section>
  )
}
