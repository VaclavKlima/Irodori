# HDR analysis and clipping diagnostics

## Status

A limited experimental Sony RAW implementation now exists; see [the versioned implementation contract](../hdr-processing.md). This brief retains the broader destination and acceptance criteria, including work deferred beyond the Linux preview milestone.

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
