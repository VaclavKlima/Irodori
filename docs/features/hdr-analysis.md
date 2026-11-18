# HDR analysis and clipping diagnostics

## Status

[Issue #59](https://github.com/VaclavKlima/Irodori/issues/59) delivered Console diagnostics. [Issue #129](https://github.com/VaclavKlima/Irodori/issues/129) adds Editor histogram and overlay controls and saved-mask inspection. [Issue #128](https://github.com/VaclavKlima/Irodori/issues/128) tracks other-device Console verification. See the [versioned HDR processing contract](../hdr-processing.md) for the underlying analysis domains.

## Editor diagnostics

Choose **Whole photo**, **Inspection region**, or a named root mask from the
Histogram scope control. The existing inspection fields and rectangle drawing
define a committed region. **Done** closes the geometry controls and retains
the rectangle. The clipping and above-white buttons show one registered overlay
at a time. The histogram caption gives the domain and exact native pixel count.
The histogram details give counts and explain unavailable components. Whole
photo uses the existing interactive histogram and clipping controls.

Saved masks use the existing ordered coverage, including range, edge, inversion
and compound operations. Diagnostics count each visible native pixel with
nonzero coverage once, using the shape of the saved root even when the root is
disabled or has neutral adjustments. The image scan uses the confirmed edit of
the photograph, including its enabled adjustments. It follows the same output
grid through crop and lens correction. The overlay uses the presented geometry
to follow pan and zoom. The preview uses a bounded transparent PNG, with native
flags combined when several source pixels reduce to one overlay pixel.

The Editor and Console share one bounded diagnostic job. The Editor cancels a
superseded scan and hides its result on a photo, revision, or target change.
Regional diagnostics use the confirmed After preview. Return to After to inspect
a region from the comparison view. The existing exact HDR refusals apply to
unsupported edits. Native sensor saturation is available only when the source
provides applicable data. A rectangle or mask cannot use source-wide saturation
as a regional count.

### Bazzite Editor verification

On Bazzite 45.20261115 with GNOME Wayland, Electron 44.3.0 and Mesa 26.2.7, the
1100 × 700 Console-open Editor counted the independent 200-pixel rectangle and
752-pixel stored mask exactly and displayed the registered transparent overlays.
Switching scope discarded a held rectangle-context reply. The authored HDR JPEG
test verified its 444 selected pixels through the SDR primary, including exact
bins and the registered warning image. Stored compound coverage and the authored
SDR test also passed with the integrated Radeon 610M selected. Compute readback
identified the RX 7900 XTX and the 610M in their respective runs.

The foreground report at
`artifacts/verification/2026-11-18T19-13-03.139Z-check-tGQIxB/summary.md`
records 1,124 passes with no failures or skips in 81.56 seconds. The background
report at `artifacts/verification/2026-11-18T19-10-09.193Z-check-7J2icm/summary.md`
records 1,138 passes and the real HDR-monitor case deferred in 76.82 seconds.
The two integrated cases passed in 4.2 seconds. Real HDR monitor presentation
and Windows remain separate device checks. The Bazzite display remained in SDR.

## Console diagnostics

Use `irodori_get_photo_diagnostics` with `photoId` and `expectedRevision`. The region defaults to the frozen inspection rectangle for that photo, or the entire committed crop. An explicit inspection rectangle can override it. Pixel rectangles use the edit grid from `irodori_get_preview_context`. The default `current` target requires the matching presented frame and `targetGeneration` from `irodori_get_photo_presentation_context`. Use `target: "sdr"` for fixed SDR diagnostics.

Pass an explicit `maskId` from the confirmed root mask list to inspect a saved
mask. A saved mask is exclusive with `region` and takes precedence over the
frozen Console rectangle. Include the current `gridIdentity` to reject a grid
change. The result `selection` identifies the whole photograph, rectangle, or
saved root, alongside the committed revision, grid and display target.

- The histogram scans every pixel in the selected region. HDR reports the existing output histogram and logarithmic luminance descriptor for the selected target. SDR reports encoded RGB bins from the rendered SDR pixels, including the authored SDR primary when it remains in use.
- The clipping PNG marks HDR output clipping in red. For SDR, it marks highlighted channels in red and black pixels in blue. Magenta marks reduced pixels containing both warnings.
- The above-white PNG marks HDR content above 1× reference white in cyan. Its exact count is independent of output clipping. Headroom and gamut counts are available for HDR targets when supported.
- Overlays fit within 1024 pixels on the longest side and preserve flagged source pixels through reduction. Count and histogram exactness refer to the native region. The image background is the Console’s SDR inspection rendition.
- A refused analysis component includes a reason. The available components can still return results. Existing exact-analysis limits for unsupported edits apply. A revision, grid or display generation change invalidates the request. None of these reads changes edits or display preferences.

### Console verification on macOS

On November 18, 2026, the isolated Electron test on macOS 26.7 (Apple M4 Pro, arm64) checked the committed Sony ZV-1 RAW in the reported HDR target and the synthetic authored HDR JPEG in fixed SDR. The RAW rectangle contained exactly 8,710 pixels. The authored patch contained 1,920 pixels above reference white and zero SDR clipping. Five existing HDR JPEG import and export regressions passed.

The focused report at `artifacts/verification/2026-11-18T12-43-56.038Z-check-jn9gWa/summary.md` records 1,116 passes and 34 platform skips in 74.18 seconds. The separate exact regional HDR strip check passed. That run also reproduced three existing `hdr-assets` failures on the checkout without Console diagnostics: two GPU proof fixtures lack the required mock capability, and one raster fixture expects an older rendering identity. Other-device qualification remains open.

In a separate manual Console check, the photographer selected a 261 × 302 rectangle at (885, 1499) on an edited HDR photo. The fixed SDR result used that rectangle, reported its RGB histogram and counted 686 highlight-clipped pixels out of 78,822. The grade contained curves and local masks. The current exact HDR analysis limits for those edits still apply.

## Goal

Distinguish retained HDR data from target-display clipping, gamut limits, and known source saturation, with matching UI and typed MCP results.

## User workflow

Inspect one RGB histogram that follows the displayed output, read brightness values, and toggle clipping overlays. Explicit working-HDR and output-rendition domains remain available through MCP. Moving to another display updates target diagnostics while working-data statistics remain stable for the same edit revision.

## Controls

Use encoded SDR RGB bins, with an equal-width logarithmic HDR extension, a reference-white divider, and display-limit markings on HDR targets. Keep explicit analysis-domain selection in MCP. Absolute nits remain unavailable unless a calibrated mapping exists. Label sampled versus exact results. Separate source saturation, target highlight/shadow clipping, and gamut warnings. Use keyboard-readable bin values, patterns/text in addition to overlay colors, and scoped preview shortcuts.

## Processing approach

Working histograms operate on retained float values, never reconstruct HDR from the SDR frame. Preserve the log-luminance statistics alongside a separately versioned output RGB descriptor, declaring bin edges, zero/negative/nonfinite handling, alpha inclusion, and percentile interpolation. Values beyond the displayed plot require overflow counts rather than silent clipping. Brightness readouts identify their domain and reference.

Target clipping follows the chosen tone/gamut transform and target descriptor. Sensor saturation is reported only when decoder data supports it; for imported HDR or deghosted merge regions it may be unknown or provenance-dependent. An above-white value is not inherently clipped. Keep source, working, and display metrics independently named.

Retain coalesced bounded interactive sampling, with exact committed scans on demand in workers. Include mask pyramids and overlay memory in budgets. A Fit overlay must preserve isolated events; zoom/pan and preview decoration never change histogram counts. Freeze histogram units and clipping definitions with independently calculable fixtures before implementation approval.

## API/MCP implications

Version or extend `irodori_get_photo_statistics` with an explicit domain and target request. Return photo ID, expected/current revision, rendering identity, analysis version, units/reference, bin edges, sample/visible counts, exactness, percentiles, and separate clipping/gamut counts or unavailable reasons. Preserve the existing SDR response for existing clients; never change `dynamicRange: 'sdr'` semantics silently. Bound result size and reject stale generations.

## Persistence

Analysis visibility/preferences are workspace state, not photo history. Cached exact results key by source/edit/render identity, domain, analysis version, and target where relevant. Monitor changes invalidate target statistics only; deletion clears every cached variant and lease safely.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and [display target descriptors](hdr-display.md). Decoder/source provenance enables saturation diagnostics; [HDR merge](hdr-merge.md) adds region provenance during integration.

## Failure handling

Return unavailable for unknown source saturation or absolute brightness instead of zero. Invalid samples, missing frames, deletion, and revision conflicts produce typed errors. Failed exact analysis leaves a labeled sampled view available; foreground preview preempts background scans.

## Acceptance criteria

- Analytic float ramps and impulses verify bin counts, percentiles, overflow, black/negative handling, alpha rules, and values at 1×, 2×, 4×, and 16× white.
- Demonstrate that source saturation, above-white data, SDR target clipping, HDR headroom limits, and gamut warnings can differ on the same image.
- Sampled and exact results meet a fixed sampling-error bound on licensed fixtures; exact MCP results agree with independent full-image counts.
- Rapid edits, monitor changes, deletion, cache eviction, and cancellation cannot display stale statistics; zoom/pan do not change counts.
- Existing SDR API tests remain valid; keyboard access, one-pixel overlays at Fit, bounded memory, and interaction gates pass with analysis enabled.

## References

- [Existing statistics contract](../../src/shared/statistics.ts), [current statistics behavior](../../README.md#histogram-comparison-and-raw-white-balance), and [analysis implementation context](../raw-processing.md#white-balance-statistics-and-comparison).
