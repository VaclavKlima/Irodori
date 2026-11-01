# Standard export enlargement

## Status

**Implemented; focused real-source and full-size functional checks pass.** This is
Goal 1 slice 5 in [professional editing](professional-editing.md). The
[reviewed RAW/raster/merge workflow](../../artifacts/verification/2026-10-29T12-07-25.420Z-check-2b7KF1/summary.md)
adds combined edits, frozen enlarged export and restart. Photographic quality,
broader native export-input, cold/contention and resource/performance acceptance
remain open. Final-size proof/output sharpening and the optional FSR evaluation
remain in Goal 2. Normal preview Fit/100% semantics stay unchanged.

The later [full-native checkpoint](professional-editing-processing.md#full-native-resources-and-enlargement--2026-10-29)
verifies an actual uncropped 5496 × 3672 Sony RAW, with frozen combined edits,
exporting a 6870 × 4590 (31,533,300 pixel) SDR JPEG through restart. The existing
**33,554,432 pixel** cap correctly refuses its 10992 × 7344 (80,725,248 pixel) 2×
request; the accepted failed job publishes no JPEG. No size, memory or quality
limit was raised. Small native crops can still enlarge 2× within that same cap.
That October 29 receipt does not establish full-size HDR enlargement, all-source photographic
quality, final-output proof/sharpening or performance acceptance.

The [October 30 reviewed-input selection](../../artifacts/verification/2026-10-30T17-54-34.524Z-check-REYTHL/summary.md)
passes both full-size 1.25× SDR and HDR export through restart, including frozen
settings, fixed-cap refusal and independent whole-image HDR reconstruction.
Its managed resource-admission checks do not measure whole-app physical memory,
sustained throughput, contention, physical HDR output or photographic quality.
See the [scoped acceptance record](professional-editing-processing.md#idle-desktop-native-and-full-size-acceptance--2026-10-30).

## GPU implementation checkpoint — 2026-11-01

Standard reductions and enlargements now select a bounded GPU owner by default;
focused integration verification passes on both available Radeon adapters. Retained CPU full-size timing records show 4,213 ms SDR / 8,222 ms HDR for
the resize stage, including file I/O, tap construction, convolution and output
quantization. These are existing observations, not a predicted GPU speedup.

The first implementation checkpoint reuses the exact normalized Lanczos3 tap
construction and the seven committed Decimal80 cases. The two-pass GPU owner
streams input rows and caches only the horizontal rows required by the current
vertical support. Downscaling keeps its expanded support and folded replicated
edges; identity and unchanged axes retain exact copy behavior. CPU work is file
I/O and parameter construction, with horizontal/vertical filtering on the GPU
and no CPU repair path. Both scalar test data and three/six-channel rendition
data remain signed Float32; the production placement stays after rendition/alpha
compositing and before quantization/encoding.

The first compact run passes all seven cases at unchanged
`2e-6 + 2e-5 * abs(reference)`, exact identity, constant error below `2e-7`,
source immutability, cancellation and pre-device budget refusal (10 cases,
2.37 seconds on RX 7900 XTX). Its direct receipt is
`artifacts/verification/playwright-1793522737147-f392836d-4e30-45ff-8cdd-589ca73d80c8/playwright/summary.json`.
An earlier registered invocation collected no GPU cases because its JSON import
lacked the required import attribute; that failed receipt is preserved at
`artifacts/verification/2026-11-01T08-43-45.594Z-check-YhPFTm/summary.md`.

New exports freeze `linear-lanczos3-pixel-centers-replicate-gpu-v2` and rendering
`jpeg-linear-lanczos3-v6-gpu-resize`. Previous resize-policy versions are explicitly
refused instead of silently changing frozen output; saved preferences, original-size
defaults and completed results remain readable. Missing legacy policy is refused
when an actual GPU resize is requested. New non-original-size jobs acquire a
main-owned resource snapshot for reductions as well as enlargements. The managed
plan records resize as a separate phase with retained input/output RAM, tap tables,
uploads, readback and the bounded GPU row cache. Rendition and resize GPU owners
retire sequentially; their VRAM reservations are assessed per phase rather than
summed. Device, source or budget failures propagate without CPU convolution repair.
Explicit CPU selection remains a legacy diagnostic route only.

Tests stay hidden during gameplay; timings under contention do not establish
performance acceptance. Previous full-size receipts describe the earlier CPU
resize implementation; the separate GPU full-size receipt below refreshes that scope.

The registered selection `export-resize-gpu`, `export-enlargement-gpu`,
`export-enlargement-model`, `export-resources`, `export-enlargement` and
`export-rendering` passes **918 checks, zero failures/skips, 140.33 seconds**:
`artifacts/verification/2026-11-01T08-58-48.682Z-check-l6C4qD/summary.md`.
This includes 883 fast checks, 10 export-service cases and 25 RAW/GPU cases.
The real Sony RAW decode/edit/HDR export uses the committed
`tests/fixtures/sony-zv1.ARW` and reduces to 97 × 65; its 79.37-second duration
dominates the routine-budget warning. No assertions were removed. The selection
also covers signed/HDR constant preservation, explicit over-budget refusal,
bounded row-cache/cancellation, raster downscaling in default/automatic mode,
frozen queued jobs and actual SDR/ISO HDR JPEG reconstruction. Earlier attempts
exposed a diagnostics TypeScript annotation and an expected diagnostics field;
both were corrected without changing pixel tolerances or reference data.

With `DRI_PRIME='pci-0000_18_00_0!'`, the two small GPU suites pass **14 cases,
zero failures/skips, 2.24 seconds** on the actual integrated RADV
RAPHAEL_MENDOCINO adapter. The existing build is reused; the direct receipt is
`artifacts/verification/playwright-1793523689550-f74a04bf-fa96-4058-b230-888bb7e12a0b/playwright/summary.json`.
The registered run identifies RX 7900 XTX/RADV NAVI31. Both report Mesa 26.2.4;
these are correctness receipts during permitted background work, not comparative
benchmarks. No other operating system or physical HDR acceptance is implied.

### Full-size GPU export — 2026-11-01

`professional-enlargement-fullsize` passes **885 checks, zero failures/skips,
217.78 seconds**, including 883 shared fast checks and both full-size cases:
`artifacts/verification/2026-11-01T09-05-41.962Z-check-p9Pkvf/summary.md`.
The exact tracked, unchanged DSC03280.ARW (SHA-256
`dead1a70a02909faf8458119fcc8f7067733b756978fd26921710e3008364605`)
exports through actual jobs to **6870 × 4590**, 31,533,300 pixels, in SDR and HDR.
Both explicitly assert the v2 GPU resize backend, actual RX 7900 XTX/RADV adapter,
current rendering version, accepted RAM/VRAM phases, unchanged originals, frozen
settings despite later edits and identical persisted results after restart.
The 10992 × 7344 request still fails the unchanged 33,554,432-pixel cap and
publishes no file. No memory, codec, geometry or reconstruction limit changed.

Actual resize buffers are 1,916,984 bytes SDR / 2,642,456 bytes HDR, each with a
peak of six cached rows against its conservative eight-row reservation. The HDR
file passes **189,199,800 independent channel comparisons** over two headrooms,
retaining the strict reconstruction gate. This establishes container/decoder
consistency, not a new independent photographic ground truth. The generated SDR
review image was visually checked for intact composition/output; that reduced
review does not accept native texture/noise quality. The small Decimal80 fixtures
remain the resize arithmetic oracle.

The SDR and HDR cases take 108.54 / 62.77 seconds. The run spans gameplay and the
user's subsequent idle notification, so its stage timings are observations only;
neither a speedup nor sustained responsiveness is accepted. Managed phase plans
do not measure whole-app physical RAM/VRAM peaks. Foreground/native checks,
strong-noise photographic quality and remaining performance gates stay open.

### Native SDR appearance review — 2026-11-01

Six lossless 512 × 512 extracts from that exact retained SDR JPEG now have a
[native gallery](../../artifacts/professional-editing/gpu-enlargement-native-review-TXaOWb/index.html)
and [bounded visual review](../../artifacts/professional-editing/gpu-enlargement-native-review-TXaOWb/review.md).
Decoded PNG samples equal the matching JPEG crops byte-for-byte, with the source
sRGB profile retained and no rescale or tonal change. The original JPEG and
receipt hashes are unchanged; no processing/export rerun was needed.

Ear/muzzle silhouettes remain continuous with no conspicuous broad ring or
straight tile seam in these views. Rock texture remains visible; dark fur and
fog-softened trees remain soft and grainy. Nearly uniform fog contains fine grain
without an obvious coarse band. These are combined NR 20/25, sharpening 25/1.2/50,
tone/color and JPEG output observations. There is no matching 1× baseline or clean
truth, so they do not isolate resizing or pass numerical ringing/texture limits.
HDR appearance and the remaining photographic/performance scope stay open.

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
Existing GPU color/detail/rendition processing remained available; the October 28
slice kept the existing CPU row resizer. The November 1 GPU checkpoint above
supersedes that implementation choice; performance benefit remains unmeasured.

The [2026-10-31 GPU cleanup](../gpu-processing.md#strict-scene-linear-export-rendition)
removes automatic CPU recovery from the existing scene-linear rendition stage,
including the rendition produced before enlargement. GPU failures now propagate
after cleanup; the successful GPU output and resize math are unchanged. Explicit
CPU diagnostics and distinct raster/authored-HDR rendition routes remain legacy
paths. At the October 31 checkpoint the row resizer still ran on the CPU. Historical recovery evidence
below describes the earlier policy, not the current default.

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
