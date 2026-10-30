# Standard export enlargement

## Status

**Implemented with focused small-fixture verification, 2026-10-28.** This is Goal 1
slice 5 in [professional editing](professional-editing.md). Real RAW/merge,
photographic, native-input and full-size resource/performance acceptance remains
pending. Final-size proof/output sharpening and the optional FSR evaluation remain
in Goal 2. Normal preview Fit/100% semantics stay unchanged.

The later [full-native checkpoint](professional-editing-processing.md#full-native-resources-and-enlargement--2026-10-29)
verifies an actual uncropped 5496 × 3672 Sony RAW, with frozen combined edits,
exporting a 6870 × 4590 (31,533,300 pixel) SDR JPEG through restart. The existing
**33,554,432 pixel** cap correctly refuses its 10992 × 7344 (80,725,248 pixel) 2×
request; the accepted failed job publishes no JPEG. No size, memory or quality
limit was raised. Small native crops can still enlarge 2× within that same cap.
This does not establish full-size HDR enlargement, all-source photographic
quality, final-output proof/sharpening or performance acceptance.

## Frozen decision: 2026-10-28

Extend the existing export sizing contract and linear-light Lanczos3 resizer.
Longest-edge and fit-within sizes may explicitly set `allowEnlargement: true` and
`method: 'lanczos3'`. Missing fields retain the old no-enlargement behavior and
Lanczos3 method. Original-size and quick presets remain unchanged. No new imaging
dependency or replacement resize engine is introduced.

Use oriented, lens-corrected, committed crop dimensions to calculate one uniform
scale, then round each resulting dimension to its nearest integer, at least one
pixel. Fit-within never exceeds either requested edge. The existing maximum edge
of 32768 and floating-point image limit of 512 MiB / 16 bytes per pixel remain;
managed RAM/VRAM and encoder limits can refuse a smaller request. Fail explicitly
rather than reducing requested dimensions or substituting a method.

Preserve the current order: source denoise/detail, crop, manual color and rendition
transforms, linear-light Lanczos3 in each output rendition's primaries, output
quantization and JPEG/gain-map encoding. HDR and its independently authored SDR
primary share output geometry and remain separate color domains. Gain-map creation
follows resizing. No screen preview or embedded camera JPEG supplies export data.

The existing separable filter uses output pixel centers mapped by
`(i + 0.5) * input / output - 0.5`, a three-lobe sinc window, normalized weights,
replicated photograph edges and reduction support widened by `max(1, input/output)`.
Enlargement retains source-grid support. Signed/above-white float samples remain
unclipped inside the resizer; existing quantization/output limits apply afterward.
Reuse its bounded needed-row cache and conservative `exportResizeBytes` accounting.
Unchanged dimensions copy rows directly; an unchanged axis uses one exact tap.
Existing GPU color/detail/rendition processing remains available; this slice keeps
the existing CPU row resizer. GPU resize acceleration requires separate numerical
and performance evidence before adoption.

New jobs freeze the resize policy and explicit enlargement choice. Requests that
permit enlargement require a main-owned resource snapshot. Admit input, crop/detail,
output arrays, row/tap caches and encoding before their allocations. Foreground
preemption/cancellation drains the existing worker; retries retain frozen settings.
Legacy preferences/jobs remain readable without rewriting their sizing choices.

## Acceptance gates fixed before implementation

- Legacy sizes/quick presets keep their exact geometry and defaults. New strict
  UI/MCP validation rejects unknown methods, malformed flags and extraneous fields.
- Independent Decimal80 two-dimensional convolution vectors cover fractional
  enlargement, reduction, identity, one-pixel axes, signed/HDR and six-channel
  paired renditions. Float32 agreement retains `2e-6 + 2e-5 * abs(reference)`;
  constants remain constant and output-center/edge behavior follows the equations.
- Crop-aware odd/portrait dimensions, fit-within bounds, requested no-enlargement,
  dimension/pixel/resource refusal, frozen settings across later edits and restart
  pass through the real job/worker path. Refusal publishes no output.
- Tiny actual SDR and ISO HDR JPEG round trips retain declared dimensions, separate
  primary/HDR domains and unchanged originals. Existing independent ISO
  reconstruction gates remain 3% / 5% / 10% at quality 100 / 90 / 80; no gate is
  weakened to fit enlargement results.
- Hidden UI checks exercise keyboard choice, retained Custom settings, quick
  presets, UI/MCP parity and minimum 1100 × 700 Console-open scrolling.
- Real RAW/raster/merge edit-export acceptance, photographic native crops,
  full-size resources and source-matched performance remain milestone gates.
  Small fixtures do not accept them. Heavy/foreground work stays deferred while
  the user plays Witcher; comprehensive checks require a separate checkpoint.

## Focused verification: 2026-10-28

The [checkpoint](../../artifacts/verification/2026-10-28T16-47-03.178Z-check-ZAucCe/summary.md)
passes **821 checks in 61.47 seconds**, zero failed/skipped/interrupted. Requested
targets: `export-enlargement-model`, `export-enlargement`, `export-enlargement-ui`,
`export-enlargement-gpu`, `export-model`, `export-resources`, `export-context`,
`crop-export`, `detail-edit-export`, plus shared cheap/static/build checks. The
routine 60-second aim was exceeded; Node takes 20.41 seconds and the longest new
application case 5.38 seconds. No assertions or quality/resource gates were cut.
Counts overlap earlier checkpoints.

Seven original Decimal80 vectors agree with the existing Float32 gate. Their
direct 2D oracle imports no production functions and checks both paired output
domains, pixel centers, signed values and edges. An initial identity case found
`1.3356e-16` leakage into a zero sample; the existing resizer now copies unchanged
dimensions and uses exact single-tap unchanged axes. The exact failed case passes
without changing its expected output or tolerance. Original-size exports continue
to bypass resampling entirely. The rendering identifier is now
`jpeg-linear-lanczos3-v5-enlargement`.

A real 17x11 library export enlarges to 34x22 with frozen options through foreground
preemption, retry and later edits. Resource refusal publishes no file. A separate
8x6 authored HDR/primary fixture, cropped to 4x6, exports actual 10x15 ISO JPEGs.
Independent ISO reconstruction retains the existing 3%/5%/10% quality gates;
the packaged primary decodes identically to the supplied SDR JPEG. An actual 8x6
capture GPU rendition enlarges to 13x10, matches existing float/byte/binary16
tolerances and rerenders the complete CPU result after injected GPU failure.
The Lanczos3 row stage itself remains CPU processing.

The hidden app imports an oriented 17x11 PNG, obtains authoritative 11x17 native
geometry, commits a 9x15 crop, and exports 18x30 through both UI and MCP after
restart. A legacy saved request and quick preset both remain 9x15. Keyboard
enlargement selection survives dimension/mode changes; cancellation does not save
preferences. Minimum 1100 × 700 Console-open layout and scrolling pass. Export adds
no photo history and original bytes remain unchanged. Both test launches stayed
hidden/nonfocusable with zero show/focus events or violations, closed windows and
removed temporary profiles.

The [ledger](../../artifacts/upscaling-research/standard-2026-10-28/summary.md)
retains hashes, failures and cleanup. No real RAW, heavy full-size GPU workload,
foreground test, benchmark or comprehensive checkpoint ran. Neither goal is
accepted by this focused checkpoint; remaining Goal 1 copy/paste/batch and combined
acceptance, and every Goal 2 phase, stay active.
