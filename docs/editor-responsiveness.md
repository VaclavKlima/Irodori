# Everyday editor responsiveness

## Ordinary editor preview policy

The unset Linux build selects one frozen policy from main's `AppInfo.platform`: Float32 gesture feedback, exact completed-presentation reuse, 512-tile dispatch chunks, and the final presentation fence. Unconfirmed platforms and macOS/Windows retain canonical gesture rendering, cache disabled, 32-tile chunks and separate completion until their own verification is complete. App passes that policy to each preview owner; browser platform guesses and build environment variables do not choose it.

The former precision, presentation-cache, tile-batch, interactive-fence and kernel `VITE_LUMA_HDR_*` selectors are retired. Production uses the linear64 kernel; the exact grid8 program remains a research/test reference. The dated commands and comparisons below preserve their original builds and results; they no longer configure an ordinary build. `VITE_LUMA_HDR_GPU_TIMINGS` remains optional diagnostics.

Only eligible After gestures use the existing versioned feedback arithmetic. Final refinement, navigation, Before/Split, source preparation, exports, independent numerical references and all identity/admission/recovery guards retain their contracts. Default adoption alone establishes neither a new performance result nor whole-goal acceptance; package version remains 0.1.0.

The newer [native-engine ledger](bazzite-native-engine.md#memory-policy-amendment)
records the user's revised memory policy: practical machine-based budgets and
optional RAM/VRAM Settings overrides replace the earlier fixed 768 MiB target.
Its 2 GiB/128-pixel candidate passes the maximized slider and spatial timing
matrix. Verification of the ordinary build after policy adoption and broader goal
acceptance remain open; dated 768 MiB results below keep their original scope.

The active goal is to make sliders, photograph selection, zooming and panning
feel immediate on the available Bazzite machine without perceptible preview-quality
degradation. This is an implementation and application-verification goal. Research,
isolated kernel throughput and a few fast surviving frames cannot establish
completion. The initial production baseline is `bef6a61`; earlier M4 Pro results
remain separate historical evidence. Start with the
[native-engine ledger](bazzite-native-engine.md) for current implementation choices
and acceptance status. The [October 19 Bazzite results](#bazzite-current-results-october-19-2026)
retain their own passes, failures, incomplete gates and scope limits.

The coordinator owns integration, decisions, builds and every application/GPU
measurement. Research and test work may proceed in disjoint files, while all
hardware measurements remain sequential. Generated evidence belongs under
ignored `artifacts/`, with compact reports linked here when available.

## Requirements and acceptance

The timing endpoint is a completed visible update in the actual Electron editor,
including completed GPU work and a following presentation observation. Record the
measurement boundary and clock domain explicitly. Physical input delivery and
display scanout remain separate from software presentation timing.

| Behavior                           | Acceptance                                                                    | Required evidence                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Warm slider, zoom and pan response | Input-to-visible p95 ≤33 ms, p99 ≤50 ms; no interaction stall >100 ms         | All inputs, completed visible updates, coalesced/dropped requests, longest presentation gaps and per-run distributions |
| Continuous interaction             | Aim for sustained 60 fps                                                      | Achieved input and presentation cadence; no claim based only on surviving-frame latency                                |
| High-refresh interaction           | Evaluate 120 Hz separately                                                    | Actual achieved cadence, completed updates and gaps; report misses independently of 60 Hz                              |
| Cached/prefetched selection        | First useful, correctly edited frame within 100 ms p95                        | Selection intent through presented matching photo, source, edit revision and presentation identity                     |
| Cold selection                     | First useful, correctly edited frame within 500 ms p95                        | Fresh-preparation and warm-cache conditions identified; full-quality completion reported separately                    |
| Gesture completion                 | Full-quality rendering within 200 ms p95 after input ends                     | Last input through completed normal-quality frame with matching final settings                                         |
| Preview quality                    | No reliably detectable degradation in controlled intended-viewing comparisons | Perceptual metrics, detail/tonal diagnostics, actual-size visual comparisons and explicit human-validation status      |
| Lifecycle                          | Correct cancellation, attribution and complete device-loss/CPU recovery       | Targeted numerical, lifecycle, history and resource checks, including rapid switching and stale pending work           |

All eight enabled sliders are in scope: Exposure, Contrast, Highlights, Shadows,
Whites, Blacks, Temperature and Tint. Disabled controls remain disabled. The
quality and timing matrix includes:

| Dimension     | Required cases                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| Window/layout | 1100 × 700 with Console open; 1440 × 900 with Console closed; large/fullscreen; Console open/closed where practical |
| View          | Fit and 100%; transitions between them; pointer-centered zoom, keyboard/wheel pan and native drag                   |
| Input         | Paced and uninterrupted gestures at measured 60 Hz and a separate 120 Hz load; bursts and rapid reversals           |
| Selection     | Cached revisit, prefetched adjacent photo, cold source, rapid forward/back navigation, committed and pending edits  |
| Contention    | Matched idle and editing trials during import, individual/batch export and merge                                    |
| Content       | Fine detail, foliage/hair, noise, smooth gradients, highlights, shadows and strong edits                            |
| Display       | Actual Retina device-pixel ratio, physical canvas dimensions, presentation color space and backend recorded         |

Temporary reductions in preview resolution, precision or processing cost are
allowed only after controlled comparisons support their intended viewing range.
Reject visible blur, tonal/color shifts, aliasing, shimmer and distracting
refinement transitions. A metric alone does not prove imperceptibility, and an
automated screenshot comparison does not replace pending human validation.
Full-quality settled previews, native-detail inspection, exports, originals,
Float32 masters and numeric edit history retain their contracts. Changed preview
policies and cache identities require explicit versions.

## Existing evidence and constraints

[Mac workability](mac-workability.md) and
[the earlier research report](performance-research.md) retain complete historical
measurements and rejected experiments. The final previous eight-slider matrix
contains 192 trials, all with sharp frames and no source/history/attribution
failures. Its performance gates fail: 1440 × 900 at 60 Hz has frame p95
92.2–101.2 ms at Fit and 58.8–67.5 ms at 100%, with only 54–55 and 95–98
presentations respectively during 240 inputs. The smaller Console-open layout is
faster, but does not establish general 33 ms responsiveness. Historical refinement
was at most 99.5 ms. These values describe earlier retained evidence, not a fresh
baseline for this goal.

Earlier matched diagnostic trials attributed most large-window delay to tile
evaluation; input-to-request p95 was at most 0.8 ms. Linear64 workgroups improved
tile time and sharp progress but left latency gates unmet. Uniform tables had no
repeatable application benefit. The completed-frame copy is a small measured
cost relative to tile evaluation; removing it is not the first candidate and
must preserve device-loss recovery.

The former coarse draft lost substantial detail: edge-energy retention was
0.0772× on the synthetic pattern and 0.4731× on a photograph. Previous 17³/33³
preview LUT photographic mean errors were 0.0241/0.00629 and maxima
0.1187/0.0391 in display-linear units. These experiments remain rejected; faster
drafts or larger LUTs need new evidence and do not inherit quality approval.

The renderer already retains the uploaded source/mip pyramid and a bounded
content-tile cache for the active photograph, with immutable active/latest
pending requests and independent histogram work. Source-detail policy is
currently selected from CSS view scale, independently of Retina density. Any
replacement must examine the actual physical sampling footprint rather than
assuming CSS-sized rendering is sufficient at DPR 2. The production
[presentation contract](display-rendering.md#interactive-presentation) now uses
practical Auto/custom RAM and GPU budgets, adapter bounds, allocation accounting,
revision-aware recovery and cleanup. The earlier 768 MiB cap below is historical.
Existing disk-cache and worker limits also remain in force.

The fresh October 18 baseline selected `mac-workability-batching` at production
revision `bef6a61`, before the new renderer candidates were built. It recorded
311 passes and two existing performance failures in 83.67 seconds; the separate
cold-invalidation case passed. Both failures retain the unchanged 33 ms/progress
assertions. The report is
[the baseline summary](../artifacts/verification/2026-10-18T17-51-22.246Z-benchmark-yBYSMS/summary.md).
These software timings include completed GPU work and a subsequent animation
frame; physical input delivery and scanout remain unmeasured.

| Fresh reference case, DPR 2      | Frame p95 across three trials | Visible presentations during 240 inputs |
| -------------------------------- | ----------------------------- | --------------------------------------- |
| 1100 × 700, Console open, Fit    | 42.0 / 42.1 / 42.2 ms         | 196 / 197 / 199                         |
| 1100 × 700, Console open, 100%   | 32.9 / 25.5 / 26.3 ms         | 238 / 237 / 238                         |
| 1440 × 900, Console closed, Fit  | 100.6 / 101.0 / 100.2 ms      | 55 / 56 / 55                            |
| 1440 × 900, Console closed, 100% | 66.7 / 58.7 / 58.8 ms         | 96 / 97 / 97                            |

Existing benchmark gates remain intact. The new goal additionally separates
interaction-intent latency from final refinement, records p99 and maximum
interaction latency, and includes the start/end boundaries in presentation-gap
measurement. Coalescing counts describe observed requests; a MutationObserver
can miss intermediate serials, so unobserved serial counts remain explicit.

## Historical initial candidate evidence (October 18, 2026)

This section records the original opt-in checkpoint on
`perf/editor-responsiveness`. The ordinary Linux policy above and the current
native-engine ledger supersede its selector/default and fixed-memory status.
Mac measurements remain separate and do not certify current Bazzite acceptance.

At this checkpoint, both candidates were opt-in experiments.
`VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32` selects the separately versioned
`aces2-f32-interactive-v1` math during after-view editing gestures. It retains
the same source, mip, sample positions, alpha and adjustment equations. Before,
split, navigation, settled rendering and exports keep canonical compensated
math. `VITE_LUMA_HDR_PRESENTATION_CACHE=1` independently enables exact completed
surface reuse. Its 64 MiB reservation reduces active tile capacity within the
existing 768 MiB presentation limit. No default had changed at this checkpoint.

The first bounded application comparison used Exposure at 1440 × 900, Console
closed, DPR 2 and measured 60 Hz, with presentation caching disabled. Three Fit
and three 100% trials passed the new software latency, tail, gap, cadence and
refinement assertions. This is partial slider coverage, not final acceptance.

| Candidate case | Interaction p95, three trials | Interaction p99, three trials | Visible updates/second |
| -------------- | ----------------------------- | ----------------------------- | ---------------------- |
| Fit            | 18.0 / 17.7 / 18.0 ms         | 18.4 / 17.9 / 18.3 ms         | 59.99 / 59.86 / 59.86  |
| 100%           | 17.5 / 17.5 / 17.5 ms         | 17.7 / 17.6 / 18.0 ms         | 60.11 / 59.99 / 59.86  |

All 240 input values received at least one visible result in each candidate
trial. The worst interaction latency was 23.7 ms, longest presentation gap
35.5 ms, and final canonical refinement 165.8 ms. Logical allocated presentation
memory was 687,457,483 bytes. The candidate report retains all inputs, frames,
source/build hashes and per-trial values in
[its benchmark summary](../artifacts/verification/playwright-1792346739372-611d7e62-14f6-4df9-8aad-0bb04a7132a1/playwright/summary.json).
The new interaction-only quantiles and the historical all-frame baseline p95
are reported with their respective boundaries; no controlled speedup ratio is
inferred from them.

The synthetic hardware proof passed 5,802 samples per output target, including
signed colors, cancellation-sensitive inputs, shadows, gradients and strong
edits. It compares the candidate against independent Float64 CTL and the
canonical GPU, while retaining the unchanged exact canonical bound. Maximum
encoded Float16-surface differences were 0.0004883 for SDR and at most 0.0009766
for the tested HDR targets; p99 was zero. Some candidate values exceed the exact
canonical tolerance, which is why this remains a distinct transient-preview
policy. [Synthetic comparison evidence](../artifacts/verification/playwright-1792346281586-b3614bed-5d42-411a-9a8e-03e71f2f1464/playwright/summary.json).

The real Sony photographic proof subsequently passed 30 matched pairs in
27.37 seconds: neutral and two strong mixed light/white-balance states, Fit and
four native-detail regions, SDR sRGB and HDR P3, using the production tile kernel
and sampler at physical 1828 × 1004 pixels (DPR 2). Source coverage and alpha
matched exactly, and independent canonical CTL holdouts passed. Worst encoded
error was 0.0009766, p99 zero, RMS 0.00001659, gradient difference 0.0009766 and
relative edge-energy change 0.000001634. Minimum local luminance SSIM was
0.9999999577. Logical proof GPU allocations were 515,610,776 bytes. The fixture
and its corrected working bytes retain recorded hashes.
[Photographic evidence](../artifacts/verification/playwright-1792346981280-1e7009c1-5d9a-45b8-ad04-717c57c34988/playwright/summary.json).

Assistant inspection of the neutral Fit pair and a strongly edited native
foliage pair found no obvious difference in the generated PNG views, including
the amplified difference image. This is limited image inspection, not physical
Retina/HDR human validation. The photograph covers foliage/branches, street
texture, shadows and sky gradients; hair remains uncovered. HDR PNGs clamp
extended values, while retained Float16 pairs and Float32 differences preserve
those values for further review. Human perceptual validation is unperformed.

The first photographic harness run was invalidated by Dawn's default 256 MiB
buffer limit during full-image texture initialization and provides no quality
evidence. The successful rerun matches production's existing adapter buffer
limit, bounds submitted upload strips and fails immediately on GPU errors.
Driver-internal initialization staging and physical VRAM remain distinct from
the logical owned-allocation count.

The initial exact-cache lifecycle proof passed all three native cases, including
actual edited compositor-pixel equality with upload held, delayed edit
confirmation, target/revision misses, suspension and replacement-device flush.
The same invocation passed all four canonical tile-kernel variants and the
synthetic preview comparison (eight cases total, 48.9 seconds). Subsequent review
found and corrected HDR/SDR table-binding and range-overlay tile-identity bugs;
fresh-confirmation handling and cancellation guards also received corrections.
Those later fixes require their focused rerun. Broader sliders, fullscreen/120 Hz,
navigation, contention and complete lifecycle acceptance remain pending.

The corrected candidate subsequently passed the then-current assertions in all
48 trials at 1440 × 900,
Console closed and 60 Hz: eight sliders × Fit/100% × three repetitions. This
run enables both experimental selectors. Fit's worst interaction p95/p99 were
26.0/26.4 ms, and 100%'s were 17.9/18.4 ms. Worst individual interaction latency
was 51.2 ms, longest presentation gap 42.9 ms, minimum visible update rate
59.23/second, and longest exact refinement 124.1 ms. At most two of 240 input
values were coalesced without a visible result; every gesture produced one
history entry and passed source, loader and attribution checks. Logical
presentation allocation was 754,566,347 bytes, including the 64 MiB reservation.
[Eight-slider report](../artifacts/verification/playwright-1792347606774-70a84872-0f11-4b05-a68d-9e85df39dea4/playwright/summary.json).

A later audit found that filtering latency to `interactive` request intent omitted
each gesture's final input, whose first observed feedback arrived as canonical
output after release. Reanalysis of the preserved raw observations includes the
first changed visible response regardless of intent and excludes only duplicate
refinement of an already observed input. **Three of 48 candidate trials exceed
the 100 ms maximum**, at 107.8, 108.6 and 109.1 ms; worst p95 remains 26.0 ms and
worst p99 is 32.6 ms. All 48 reference trials miss at least one latency gate.
This corrects the acceptance interpretation without changing the old artifacts.
The reanalysis cannot recover unobserved frames, prove completed-frame source
attribution or remove the recorded display-target mismatch. Final-input feedback
therefore joins the remaining candidate work before adoption.
[First-visible audit](../artifacts/verification/2026-10-19T05-17-47.735Z-first-visible-audit/summary.md).

A subsequent canonical reference run used the same Sony fixture, 1440 × 900
layout, DPR 2, 60 Hz input, eight slider labels and three repetitions at both
zooms. It failed 165 assertions; the candidate's corresponding 48 trials passed
the older assertions, subject to the first-visible correction above.
The following are medians of 24 per-trial quantiles/rates for each zoom, rather
than pooled percentile estimates. Every corresponding per-trial p95 improved.

| View | Reference / candidate median interaction p95 | Reference / candidate median p99 | Reference / candidate median visible updates/s | Reference / candidate missing input values |
| ---- | -------------------------------------------: | -------------------------------: | ---------------------------------------------: | -----------------------------------------: |
| Fit  |                             93.05 / 18.00 ms |                  101.0 / 24.9 ms |                                  13.58 / 59.86 |                           4434 / 5 of 5760 |
| 100% |                             66.65 / 17.60 ms |                   67.5 / 17.9 ms |                                  23.85 / 59.86 |                           3458 / 8 of 5760 |

Fit's median paired per-trial p95 reduction is 80.63%; native detail's is
73.54%. These are descriptive comparisons with a presentation-state limitation:
the reference's captured HDR peak/headroom was 2.5270 (generation 9), whereas the
candidate's was 1.3552 (generation 4). The fixed content rendition and source,
layout and input cadence agree, but the actual display target was not identical.
Do not present the percentage as a fully controlled same-target speedup. Preserve
the actual target records and obtain a stable-target comparison before making
that stronger claim.
[Canonical reference evidence](../artifacts/verification/playwright-1792349350858-3d1b180c-0daf-497f-8522-c7762d79e541/playwright/summary.json).

Independent native UI tests now pass the corrected table selection and tile
identities in both native gamut and forced sRGB-only canvas configurations.
Their observer records actual compute pipelines and bound ACES table bytes,
compares tables to separately packed target contracts, and requires reference
computation on release. Pre-gesture canonical compositor captures agree with
the transient and settled results within the separate capture budgets. HDR/SDR
switches, SDR ranges, Before's existing automatic return to After on edit, Split,
source reuse and one history entry per gesture are covered. Initial test-only
setup/history and observation-phase mistakes were corrected without relaxing
those assertions. [Native gamut](../artifacts/verification/playwright-1792348244080-ec21abf1-4b94-4df1-9f37-02fff8ccc7c2/playwright/summary.json)
and [sRGB-only gamut](../artifacts/verification/playwright-1792348426988-32b61d92-002c-4f45-afac-c3d61c5b17c4/playwright/summary.json).

Cold-path instrumentation adds elapsed worker spans for decoder opening and
unpacking, sensor extraction, GPU initialization/upload/submission/readback,
mapping/orientation copying, CPU recovery, native writing and hashing. These
are worker process measurements, with explicitly named enclosing and child
durations; they are not hardware timestamp queries. Main preparation and
renderer first-useful presentation clocks stay separate. The initial instrumentation
changes no pixel loop, allocation, file order or GPU fence.

The focused instrumented-build verification passed **330 checks, zero failures
or skips, in 124.38 seconds**. It includes type/lint/format/build, maintained fast
coverage, real CPU/GPU HDR preparation agreement, corruption/restart/leases,
the three revised cache lifecycle cases and all 30 photographic pairs. The
45.10-second CPU reference and 28.47-second photographic comparison explain most
of the intentional duration. No comprehensive checkpoint was run.
[Focused report](../artifacts/verification/2026-10-18T18-37-07.965Z-check-H1NsVw/summary.md).

The first ordinary two-RAW navigation measurements expose remaining misses.
Two cold activations per layout measured roughly 1.37–1.65 seconds, exceeding the
500 ms target. The first warm revisit missed retained reuse (396.5 ms small,
446.1 ms large); the following nine warm activations took about 54–58.1 ms.
Fullscreen ordinary warm activations all missed reuse, taking 429.2–514.1 ms.
Its individual exact surface is 37,191,936 bytes, so two cannot fit the 64 MiB
prototype cache; adopting the departing frame evicts the selected frame.
The final rapid reversal did reuse a completed surface within 54.8–80.9 ms.
Do not exclude the first warm miss or describe these navigation gates as passing.
[Large-layout evidence](../artifacts/verification/playwright-1792348783947-eb65e0e2-bf4c-498f-930a-e8f183ae9cca/playwright/summary.json)
and [small/fullscreen evidence](../artifacts/verification/playwright-1792348865320-4fa835d8-b733-4e15-90eb-439e33447de9/playwright/summary.json).

The navigation observer initially conflated a still-visible loader or a newer
pending request with wrong pixels. The large first-control's three flagged
frames had correct source and committed parameters with completed serial 2 and
requested serial 3; fullscreen's one flagged frame had correct pixels/identity
with the loader still present for a React paint. The corrected observer keeps
wrong photo/source/committed-parameter counters separate from correct-but-not-yet-
useful, loader-blocked and pending-request observations. It retains the original
conservative first-useful clock and every first-warm miss. Bounded post-dispose
departure diagnostics are collected from departing canvases without adding waits.
The corrected observer has now been rerun with zero wrong-pixel publications;
the timing misses remain below.

The fixed 64 MiB reservation also narrows the pre-existing GPU frame envelope:
6400 × 4800 with a 1000 × 1000 physical canvas fits without reservation at
767.94 MiB, while the reserved minimum exceeds 768 MiB. A 7008 × 4672 source can
fail even the initial upload preflight. Both are within the existing native
Float32 asset size limit. This must be corrected by draining/deactivating retained
presentations and retrying ordinary planning; raising the presentation cap is
not an option. The cache stays experimental until this and navigation tails are
resolved.

## Cache and native transport follow-up

The retained cache now has sticky per-presenter bypass. A source or viewport
that needs ordinary headroom first pauses cache admission, retires all entries,
waits for pinned GPU leases to drain and then plans with zero reservation. The
ordinary 768 MiB cap is unchanged. A restored native canvas is also charged
during source upload; a miss keeps the earlier envelope. This covers the wide
16384 × 1800 counterexample where an uncharged cached canvas would overlap
upload allocations. Concurrent drains, disposal and pause tokens are covered by
the maintained Node cases.

The new cache's reservation was increased from 64 to **96 MiB**, within the
unchanged aggregate cap; the active tile capacity decreases to make room. This
holds two native fullscreen surfaces. In the first three-layout comparison,
all ten fullscreen ordinary warm switches improved from roughly 436–452 ms to
**52.5–59.0 ms**, preserving exact source/edit identity. All ten large-window
switches took **54.7–64.1 ms**. The small window retains its first warm miss at
**395.8 ms**, with subsequent switches **53.7–58.1 ms**. The first photograph's
initial display generation was 2 and its missed revisit used a later target;
fresh output for a changed target must not reuse stale pixels. These samples
are retained, not removed from the ordinary warm distribution. Cold selections
remain **1.25–1.35 seconds** in this run, above 500 ms.
[64 MiB run](../artifacts/verification/playwright-1792349999204-11f5eb2a-377d-4688-914b-3a4a83da6ffb/playwright/summary.json),
[96 MiB run](../artifacts/verification/playwright-1792350142016-82c3b4e3-e363-419a-80ed-65fc0fda2ca8/playwright/summary.json).

Unrotated Float32 readback now copies tight strips or individual padded rows
without scalar channel assignments. Rotated mappings are unchanged; all eight
orientations, partial strips, offsets and Float32 encodings are checked. In the
three-layout diagnostic, its copy span fell from about 124 ms to **31–34 ms**.
This is a stage improvement; variable native write times prevented a repeatable
complete cold gain in that comparison. Both recorded working hashes stayed
unchanged. Native writing is a separate exact candidate: one 64-row explicit-
offset write replaces Node's internal 512 KiB `writeFile` chunks, with bounded
short-write recovery. Hash order and bytes remain unchanged; no write/hash
overlap was introduced. Three fresh application comparisons remain required.
The inspected Node 24.20.0 implementation bounds each write in
[`writeFileHandle`](https://github.com/nodejs/node/blob/v24.20.0/lib/internal/fs/promises.js#L1073-L1105),
using the 512 KiB constant in
[`internal/fs/utils.js`](https://github.com/nodejs/node/blob/v24.20.0/lib/internal/fs/utils.js#L137).
This explains the candidate's syscall granularity; it does not establish an
application speedup or change the durability contract.

Focused type/lint/format and maintained Node verification passed **355 checks
in 17.52 seconds**. A further sequential run passed the three cache UI cases,
CPU/GPU corrected preparation agreement and **36 deer/fur photographic pairs**
in **102.08 seconds**. The deer source retains working hash
`628bf16922de7b011668611a8d17ed6eb4a942b58601642d0d887b7cc29c8797`.
Its worst encoded error is 1/1024, p99 is zero, RMS is 0.00001795 and relative
edge-energy change is 0.00000247. Human Retina/HDR review remains pending.
[Node report](../artifacts/verification/2026-10-18T19-04-49.151Z-check-wtDuTq/summary.md),
[GPU and fur evidence](../artifacts/verification/playwright-1792350329648-46a29a01-71bc-4d90-9285-fc925ecb7dc1/playwright/summary.json).

The first native spatial matrix has passing pan, 100–122% zoom and drag at
roughly 17–18 ms. Its broad Fit-to-native helper initially used fractional wheel
coordinates that the browser quantized, causing strict expected-view failures.
The observer now uses the dispatched event's actual coordinates; this changes
neither the trajectory nor tolerance. That focused rerun and wider matrix remain
pending. All failed evidence is retained.

## Lifecycle and asynchronous publication ledger

The October 18 focused consolidation remains a **failed** invocation: 362 passed,
five failed, no skips, with 3051.48 seconds of elapsed time. It selected
`hdr-content-ui`, `hdr-presentation-cache-ui` and
`interactive-preview-lifecycle`, plus the routine cheap checks. Type checking,
lint, formatting, build and the maintained Node cases passed. Host scheduling
gaps affected the long CPU-recovery and cancellation cases, so their timeout
durations are not valid performance measurements. They remain failed evidence;
the later awake reruns below do not turn that invocation into a pass.
[Failed consolidation](../artifacts/verification/2026-10-18T19-58-42.575Z-check-kF0mLC/summary.md).

Three other failures required concrete metadata/proof corrections. The two
upload-before-confirmation cases now observe completed GPU publication metadata
and fresh per-presenter source-upload counters, rather than treating a previous
presenter's fields as fresh output. Their first visible frame must carry the
correct source and committed Exposure 1, while native upload alone keeps the
unconfirmed canvas neutral and editing unavailable. The stale-Undo proof now
establishes an independently prepared, fully edited raster reference and a
matching no-Undo control before holding and releasing the previous photograph's
real Undo reply. Every later source, edit revision, viewport, Inspector value and
native compositor capture must match that reference exactly. Earlier comparisons
had sampled preparation still in flight; neither pixel tolerances nor exact
capture assertions were relaxed.

Production also now requires fresh edit confirmation for initial GPU and CPU
publication, rejects a stale null HDR response by request token before starting
legacy fallback, and rechecks the active photo after awaited Undo/Redo replies
before updating `useEdits`. A changed corrected CPU source retires old bitmaps
and native-presentation authority before accepting fresh confirmed output.
These guards address asynchronous ownership, not approximate preview quality.

| Focused result                                                    | Confirmed outcome and measured test duration                                                                                                                                 | Evidence                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native interactive-shader rejection                               | One passed; 40.6 seconds for complete corrected CPU recovery with unchanged history. This is a lifecycle test, not an interaction-latency sample.                            | [Awake rejection rerun](../artifacts/verification/playwright-1792367533806-4c569e88-dafc-4cf9-831a-7e37ccfcf373/playwright/summary.json)          |
| Cancellation and photo switching with completed Float32 work held | One passed; 7.8 seconds, rejecting stale publication and preserving exact refinement.                                                                                        | [Awake cancellation rerun](../artifacts/verification/playwright-1792372016901-1cc847b8-0766-4774-a04b-b5dcd9ec2b35/playwright/summary.json)       |
| Native upload completes before edit confirmation                  | Both new-photo and same-photo Library-resume cases passed; 11.5 seconds for the invocation. First visible source/settings and exact confirmed compositor pixels are checked. | [Reverse-completion-order rerun](../artifacts/verification/playwright-1792372076937-d9bc044a-dc59-43f6-aa01-511018f854a4/playwright/summary.json) |
| Previous-photo Undo finishes after switching                      | One passed; 7.5 seconds, with an independent prepared reference, matching no-Undo control, exact pixels and stable current Inspector/source/revision.                        | [Exact stale-Undo proof](../artifacts/verification/playwright-1792376284621-047d4b7a-c4ef-47fb-82f2-05680e1f488d/playwright/summary.json)         |
| CPU first publication and corrected-source replacement            | Both maintained Node cases passed; 0.32 seconds for the invocation. They reject superseded replies and close old bitmaps before fresh confirmed output.                      | [CPU ownership cases](../artifacts/verification/playwright-1792372160086-b743f7bf-30c9-4bed-98d2-4e13aca8d96c/playwright/summary.json)            |

The earlier interrupted rejection replay and intermediate Undo proof failures are
also retained alongside their passing reruns:
[rejection replay](../artifacts/verification/playwright-1792364525284-c5ebcdce-8593-4a2c-ade1-ed00a1a76460/playwright/summary.json),
[first Undo setup failure](../artifacts/verification/playwright-1792372102591-fe482219-b129-4d2b-9e43-334f7c1879e5/playwright/summary.json)
and [incomplete raster-reference failure](../artifacts/verification/playwright-1792372177531-d5b9e74a-b7a1-453c-902f-50359625aa72/playwright/summary.json).
No failed sample or artifact was removed. Device loss also passed its real
Float32-to-CPU recovery case within the earlier failed consolidation; the
coordinator's fresh focused consolidation of the final guards is recorded below.
Do not claim a final consolidated pass before its compact report is available.

## Pending follow-up experiments

Two setup reruns and subsequent performance acceptance remain pending.
Broader slider/spatial layouts, separate 120 Hz load and
import/export/merge contention still require their application evidence after
the latest publication guards. The preview and cache selectors stay disabled by
default until the application-level adoption evidence is complete. Cold and
first-warm navigation misses, human Retina/HDR quality validation and deferred
Bazzite verification retain their existing status.

## Final focused verification status

The final focused consolidation finished with **367 passed, 2 failed, no skips**.
Type checking, lint, formatting, build and all **357 Node cases** passed; Node
execution took 9.24 seconds. Ten native cases passed, including the fresh
confirmation, exact stale-Undo, CPU rejection recovery and cancellation checks.
The two remaining cases stopped during import setup, before their tested
behavior: the stale-null navigation case recorded 908 seconds against a
120-second timeout, and device-loss setup recorded 959 seconds against a
180-second timeout. Formatting itself recorded an unrelated 982-second gap.
These are interrupted host conditions, not usable latency samples; no timing or
quality threshold was relaxed. Both cases require exact reruns on an available,
awake and unlocked Mac before adoption. A temporary wake assertion did not make
the interrupted session reliable. The wider performance matrix and final
default/merge decision remain pending; both experimental selectors remain off
by default.
[Consolidation report](../artifacts/verification/2026-10-19T03-09-50.022Z-check-XJjLGt/summary.md).

Read-only macOS power logs subsequently confirmed **973-, 908- and 959-second
sleep intervals** within that invocation. These correspond in sequence to the
formatting gap and the two import-setup durations; the original failed result is
unchanged. A bounded extraction records only the relevant power transitions.
No power configuration was changed. Native acceptance remains dependent on an
available awake and unlocked graphical session.
[Host sleep evidence](../artifacts/verification/2026-10-19T05-16-45.458Z-host-sleep/summary.md).

The two new fast CPU-presenter cases separately passed in 0.32 seconds. They
exercise late replies, confirmation loss, draft-to-full continuation and
changed-source bitmap/generation retirement without decoding or native GPU work.

## Measurement corrections before the next native run

The new goal's 120 Hz slider and spatial cases explicitly select
`timer-deadline-v1` input pacing. Absolute timer deadlines can exercise 120 inputs
per second even when native animation frames arrive at 60 Hz. Every input yields
a task, overdue dispatch remains charged as lateness, and independent native-rAF
timestamps record actual presentation opportunities. The 60 Hz cases retain
native-rAF pacing; legacy benchmark callers keep their existing driver. Requested
input rate, actual dispatch rate, native-rAF rate and completed changed visible
updates remain separate quantities. Timer input is not evidence of 120 fps.

First-visible latency now includes an input first served by final-quality output
after release. The historical interaction-intent metrics remain available, while
the new goal gates use first changed visible feedback and exclude only duplicate
refinement. Contention tails use the same rule even when the first response
arrives after the background operation ends. Slider attribution also records
actual completed source/epoch/intent and rechecks them after the presentation
observation; copying request metadata alone does not prove what was displayed.

Navigation acceptance now requires the current authoritative display generation,
the exact confirmed native/cached edit revision, the managed target-photo source,
and the existing settings/quality/presentation criteria at the post-paint endpoint.
Every ordinary cold and warm sample must complete before percentile aggregation.
Rapid reversals retain completed, superseded and missing inputs plus the longest
continuous pending useful wait and any unfinished censored tail. Pending redraws
for a changed target remain recorded without qualifying as useful output.

Focused selection `editor-input-pacing` plus `verification` passed **362 checks
in 19.85 seconds**, including type checking, lint, formatting and five new pacing/
first-visible cases. The initial lint failure was corrected and its exact stage
rerun before the passing selection. These measurement corrections do not supply
new native acceptance evidence or enable either experimental rendering selector.
[Focused verification](../artifacts/verification/2026-10-19T05-21-34.836Z-check-Pmr8xL/summary.md).

## Final-input feedback candidate

The first-visible audit exposed a release transition: the last input and release
can precede the next preview draw. Accepting the committed edit advances the
epoch and clears its draft, so the final value may first appear through expensive
canonical work. The library also broadcasts `editsChanged` before returning the
caller's write reply; a refresh can therefore win the acceptance race.

The opt-in Float32 candidate now carries bounded private metadata for one local
write. Pending metadata is issued before its real write starts; only that write's
successful reply can mark it accepted. Matching refreshes preserve the pending
record, while cancellation, conflicts, new gestures, history and scope changes
retire it. Queued changes waiting on an earlier write also recheck their intent
generation before creating another draft.

An actually observed native gesture may submit one final Float32 image, followed
by canonical refinement after its exact accepted revision/settings receive fresh
confirmation. Pending metadata prevents early canonical admission during the
refresh-before-reply race. Duplicate draws coalesce; per-stage request serials
prevent obsolete cleanup from retiring a replacement or publishing feedback
twice. Source, view, target, comparison, ranges, cancellation and device loss
invalidate the handoff. Original request epochs remain in publication metadata.
No GPU surfaces, queue lanes or arbitrary gesture delays were added, and exact
retained presentation still excludes transient output.

The coordinator integrated the hook and GPU work and registered separate
`edit-gesture-commit` and `hdr-gesture-handoff` Node targets. Focused verification
passed **405 checks in 20.02 seconds**, including their **43 new lifecycle cases**,
type checking, lint and formatting. The explicit Float32/cache Electron build
passed in **1.98 seconds**. A new native lifecycle case holds only the caller's
real reply after persistence and broadcast, requires final Float32 feedback with
no premature canonical tile dispatch, then releases the reply and checks exact
refinement, revision, history, resources and compositor pixels.
[Focused verification](../artifacts/verification/2026-10-19T05-35-21.247Z-check-peeAgo/summary.md),
[candidate build](../artifacts/verification/2026-10-19T05-35-57.765Z-gesture-candidate-build/summary.md).

Native acceptance of that case remains **unproven**. The
historical 107.8–109.1 ms misses are still unmet; model tests and a successful
build do not establish a latency improvement or a native lifecycle pass. The
resume/transfer ledger below records the subsequent exact reruns and setup
correction. Affected lifecycle checks and matched first-visible performance runs
remain required. Wider layout,
120 Hz, navigation and contention acceptance remains pending. Both experimental
selectors remain disabled by default and no production merge is implied.

## Paused Mac goal and Bazzite transfer

On October 19 the user resumed the goal, then paused it to move work to Bazzite.
The exact stale-null navigation and actual device-loss cases passed **2/2 in
48.27 seconds** (6.57 and 41.34 seconds). The earlier interrupted invocations
remain failed evidence; this successful run supplies no interaction-latency
acceptance.
[Resumed native cases](../artifacts/verification/playwright-1792389656466-1b2bd8be-d0e3-4c65-9417-10538d3a0bf7/playwright/summary.json).

The held-reply case stopped in setup because Electron correctly rejected
replacing the protected renderer bridge. Test-only correction `3c9111b` holds
the existing main-process IPC handler's real reply after persistence/broadcast,
preserving the bridge and real operation. Type checking, file lint and formatting
pass; the corrected native case is **unrun** because the user paused the goal.
[Preserved setup failure](../artifacts/verification/playwright-1792389722485-4dab5a5a-6f39-4f94-96e3-0c714c65f9e9/playwright/summary.json).

Use [the self-contained Bazzite handoff](bazzite-editor-handoff.md) for the
checkpoint, complete continuation objective, local installation/display caveats,
known harness gaps and next commands. Generated Mac evidence is ignored and
does not travel with Git; an optional separate archive preserves selected
reports/raw measurements. Neither the editor default nor production was changed.

## Primary-source research

The following source snapshots were inspected on October 18, 2026. Vendor
documentation establishes public behavior, not proprietary shader, scheduler or
cache implementations. Source mechanisms from other applications are useful
comparisons, not evidence of a speed-up or imperceptible loss in Luma.

| Source                                                                                                                                                                    | Documented or directly inspected behavior                                                                                                                                                                             | Implication to evaluate in Luma                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Capture One preview settings](https://support.captureone.com/hc/en-us/articles/360002484457-Capture-One-Preferences-Settings-Image-tab)                                  | Recommends matching preview size to display resolution; oversized and undersized previews can slow adjustments.                                                                                                       | Evaluate display-footprint working previews using actual physical pixels. This is not approval to undersample a Retina canvas.                                     |
| [Lightroom performance guidance](https://helpx.adobe.com/lightroom-classic/desktop/technical-support/performance-guidelines/optimize-performance-lightroom.html)          | Separates standard and native previews, retains them to avoid regeneration, and caches original image data to skip early processing.                                                                                  | Measure early-stage reuse and cached selection independently from cold decoding. Library-preview guidance alone does not describe Develop internals.               |
| [Lightroom Smart Previews](https://helpx.adobe.com/lightroom-classic/desktop/viewing-photos/lightroom-smart-previews.html)                                                | Supports editing lightweight proxies based on lossy DNG and synchronizing edits with originals.                                                                                                                       | Editable proxies are a candidate architecture, but their size, quality and responsiveness do not transfer automatically to Luma.                                   |
| [darktable pixelpipe manual](https://docs.darktable.org/usermanual/development/en/darkroom/pixelpipe/the-pixelpipe-and-module-order/)                                     | Separates export and interactive pipes; darkroom processing requests the visible ROI. Warns that spatial modules can differ from full-image export; high-quality processing trades responsiveness for correspondence. | Preserve operation order, scale semantics and neighborhood halos when introducing ROI or reduced-scale stages.                                                     |
| [darktable scheduling/ROI source](https://github.com/darktable-org/darktable/blob/47b932b3eb3946583621f9a9515d6efb2b46959c/src/develop/develop.c#L283-L309)               | Briefly active work may finish before interruption; viewport ROI calculation at lines 868–883 includes physical pixel density.                                                                                        | Compare cancellation/coalescing policy and physical viewport work; do not assume restarting on every event improves progress.                                      |
| [darktable mipmap source](https://github.com/darktable-org/darktable/blob/47b932b3eb3946583621f9a9515d6efb2b46959c/src/common/mipmap_cache.c#L940-L959)                   | Provides asynchronous mip prefetch and separate scaled floating-point/full-source caches.                                                                                                                             | Evaluate bounded lookahead and retained intermediates while foreground work remains first priority.                                                                |
| [darktable architecture at the same revision](https://github.com/darktable-org/darktable/blob/47b932b3eb3946583621f9a9515d6efb2b46959c/dev-doc/pixelpipe_architecture.md) | Describes backward ROI propagation, cumulative parameter hashes, pipe/scale-aware cache keys and downstream invalidation.                                                                                             | Retain reusable upstream work with explicit cache identity; future spatial nodes need complete input regions.                                                      |
| [RawTherapee coordinator source](https://github.com/RawTherapee/RawTherapee/blob/b2ee504c47e5e6d5e054395aa12bf1fe43bd1c3c/rtengine/improccoordinator.cc#L3508-L3620)      | One loop snapshots latest parameters and merges pending change bits. Separate scaled float/Lab buffers and full-detail crops exist; below-native fast demosaic is an explicit quality policy.                         | Stage-specific invalidation and scaled/detail paths are maintained precedents. Luma retains its current decoder unless a separately validated change is justified. |

The darktable snapshot is `47b932b3eb3946583621f9a9515d6efb2b46959c`;
RawTherapee is `b2ee504c47e5e6d5e054395aa12bf1fe43bd1c3c`. These are source
inspection references, not new application dependencies. No third-party source
is copied into Luma by this research.

## Rendering decisions

These decisions preserve the existing pipeline while evaluating the measured
expensive work. "Retain" describes the current implementation; "experiment"
does not mean a candidate is enabled by default. The source comparisons above
motivate mechanisms, while only Luma's recorded trials establish its behavior.

| Mechanism                          | Decision for this pass                                                                                                        | Evidence, constraints and remaining work                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display-sized working previews     | Retain physical-canvas presentation; defer a separate early display-sized working asset.                                      | Record CSS dimensions, actual canvas dimensions and DPR. At DPR 2, a CSS-sized buffer alone would undersample the display. Cold selection still takes about 1.25–1.35 seconds; a new correctly edited early asset needs its own quality, source-identity and native-refinement proof.                                             |
| Adaptive preview resolution        | Do not adopt a reduced-resolution gesture mode.                                                                               | The prior draft retained only 0.0772× synthetic and 0.4731× photographic edge energy. The current Float32 experiment changes arithmetic precision while retaining source, mip, sample positions and alpha; its improvement does not approve blur or undersampling.                                                                |
| Image pyramids                     | Retain the uploaded source/mip pyramid and current detail policy.                                                             | Reuse avoids repeated active-photo uploads. Detail selection currently follows CSS scale; any future change must validate the physical sampling footprint, Fit/100% transitions and all orientations without replacing the frozen reference.                                                                                      |
| Visible region / ROI               | Retain visible tile planning and the bounded transformed-tile cache.                                                          | Large-window baseline delay is dominated by tile evaluation. Reusing transformed texels is useful for warm navigation inside a photograph. Future neighborhood operators need explicit halos and consistent processing order; no new cropped decoder or spatial pipeline is adopted here.                                         |
| Retained GPU intermediates         | Retain active-source and transformed-tile residency; experiment with exact completed presentation surfaces.                   | Warm source uploads remain one in the measured gestures. Completed `rgba16float` surface reuse avoids a full source upload before first useful revisit; it does not make Float16 equivalent to arbitrary Float32. The 96 MiB reservation remains inside 768 MiB, with drain/bypass when ordinary source planning needs the space. |
| Caching and adjacent prefetch      | Keep revision/target-aware exact revisit caching experimental; defer adjacent source prefetch.                                | The 96 MiB candidate holds two fullscreen surfaces and measured ordinary fullscreen revisits at 52.5–59.0 ms. The small-layout first revisit still misses at 395.8 ms after a target change. Never reuse stale target/edit pixels; prefetch must fit existing budgets and yield to the active photograph.                         |
| Cancellation and coalescing        | Retain immutable active/latest pending requests, stale-publication guards and bounded queues.                                 | Record every dispatched input, unique changed completed frame, coalesced request and gap. Surviving-frame latency alone is insufficient. Active Float32 cancellation, device loss and full CPU recovery require the focused lifecycle results before adoption.                                                                    |
| Progressive display and refinement | Keep the versioned Float32 gesture candidate followed by canonical normal-quality rendering; defer a new early-mip cold path. | The 1440 × 900 all-slider candidate's longest canonical refinement was 124.1 ms in the recorded cohort. Navigation remains reference quality. Camera JPEGs remain excluded from the large preview, and a temporary frame must match the requested source, edits and output policy. Human Retina/HDR validation remains pending.   |
| Foreground scheduling              | Retain editing/visible analysis priority, bounded background admission and independent histogram completion.                  | Import can legitimately pause at scheduler boundaries. Import, individual export, batch export and merge need actual overlap/progress evidence and contention-only cadence/gap measurements. Pending contention runs do not establish scheduler acceptance, and unrelated histogram readback must not delay a completed image.    |
| Direct viewport rendering          | Defer replacement of the tile path; retain it as an exact comparison only if remaining measurements justify it.               | Transform-then-interpolate equivalence can require four transformed source taps per output sample. Retina increases physical sample count, while tiles reuse transformed texels. The completed-frame copy is already a small measured cost. No complete application evidence currently shows that direct rendering would win.     |

The next decision is application-level adoption of the bounded candidates,
subject to the acceptance matrix, rather than an unmeasured pipeline rewrite.
Cold transport spans and native I/O remain separate from interactive shader
timings. A faster copy or syscall sequence cannot stand in for a faster visible
selection, and an automated numerical match cannot certify universal visual
imperceptibility.

## Bounded candidate order

1. **Preview-only ordinary Float32 ACES evaluation.** Compare a versioned preview
   shader candidate with the current compensated math while retaining the same
   uploaded source, mip selection, alpha and sample coordinates. Keep exact
   settled rendering and export isolated. Validate strong edits and independent
   pixel/perceptual comparisons before adopting temporary approximation. Resident
   kernel timing alone is insufficient; require complete interaction gains.
2. **Bounded retained completed surfaces for warm navigation.** Evaluate reuse of
   existing `rgba16float` presentation surfaces to avoid full-source reupload on
   a warm revisit. Reuse preserves the already-rendered surface bits, not a claim
   that Float16 represents arbitrary Float32 values exactly. Key by photo,
   source/preparation, edits, viewport and display policy; reject stale surfaces,
   account all retained bytes and recover after device loss. Measure first useful
   correctly edited presentation separately from restored native source/detail.
3. **Further approximation and cold-path work only if needed.** A higher-resolution
   LUT needs new numerical, perceptual and application evidence; preserve old LUT
   failures. Evaluate early correctly edited display-sized mips and bounded
   adjacent-photo prefetch, with cold/native refinement and cancellation measured
   independently. Never use the camera JPEG as the large preview.

An exact direct-viewport path remains a comparison candidate, not an assumed
winner. Sampling after pointwise transforms can require four expensive
transformed taps per display sample, and a Retina viewport increases fragment
count. The existing tile approach evaluates reusable transformed texels once.
Compare actual complete workloads and memory before replacing it. Image pyramids,
visible-region processing, retained GPU data, caching/prefetch, cancellation,
progressive refinement and foreground scheduling must each receive an explicit
decision, even when the decision is to retain the current implementation.

## Verification and handoff

Establish matched application baselines and run promising candidates
sequentially. Preserve every sample and the slowest result. Adoption requires
repeatable complete-interaction gains without quality, lifecycle, memory or
tail-latency regressions. Keep full-quality numerical requirements and historical
failed gates unchanged. Functional verification remains targeted to affected
behavior; this goal does not automatically authorize `check:all`.

Before completion, attach the tested implementation revision, source/build
identities, before/after distributions, measured cadence and gaps, resource peaks,
quality comparisons, rejected candidates and remaining bottlenecks. Map each
acceptance row to its evidence, including any unmet targets. Human quality
validation remains pending until performed; automated comparisons do not certify
universal imperceptibility. Prepare reproducible Bazzite commands, fixtures,
display/adapter metadata and cache conditions under TODO #29, without claiming
Linux verification while that machine is unavailable.

## Deferred Bazzite handoff

The user deferred Bazzite work while the machine is unavailable. Track everyday
editor verification alongside merge verification under
[TODO #29](features/README.md#workspace-feedback-backlog), using
[the separate editor continuation checklist](mac-workability.md#everyday-editor-continuation).
The merge implementation remains frozen at
`0a70599669c884fc70d2e2afe5f9a6527df44dbb`; it is not the revision for this later
editor experiment. The coordinator must record the final tested editor revision
and source/build identities before handoff. That revision is still pending.

Keep `VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32` and
`VITE_LUMA_HDR_PRESENTATION_CACHE=1` explicit in candidate builds; an unset
selector is the reference configuration. Linux acceptance requires its own
measured cold/warm conditions, 60/120 Hz cadence, native display/DPR, quality,
history, resources, cancellation/recovery and background-work results. Mac
measurements provide no Linux result, and deferred Linux work does not block
continued Mac feature development.

## Bazzite checkpoint: October 19, 2026

The Bazzite continuation now has local evidence from an isolated clone based on
`3673c07`, with uncommitted source and harness corrections. This section adds
Linux results; the earlier Mac results and interrupted invocations retain their
historical status. Neither experiment is enabled by default. This is a failed
acceptance checkpoint, not approval to adopt the candidates.

The local correction to `useEdits` preserves the final draft when pointer release,
capture loss or blur flushes the same pending write again. The corrected native
held-reply case reaches final Float32 feedback before its own reply, then freshly
confirmed canonical refinement, with one persistence call and one added history
snapshot. It still fails the unchanged screenshot comparison: maximum channel
difference **2 codes**, against the **1-code** limit, on both the initial fixed run
and its exact rerun. Those are pixel failures, not duplicate-write or history
failures; the complete native case remains failed.
[Held-reply rerun](../artifacts/verification/2026-10-19T06-33-09-held-reply-fixed-rerun/playwright/summary.json).

Quality and recovery evidence remain separate:

- The Sony street and deer photographic suites pass **66 comparisons** (30 and
  36), retaining their original hashes and recorded preview budgets. Their
  combined native suite has **2 passed, 1 failed in 79.97 s**, because the
  synthetic numerical case fails. Human physical-display review is still
  pending; these DPR 2 photographic comparisons do not establish Linux DPR 1
  interaction or physical HDR acceptance.
  [Quality suite](../artifacts/verification/2026-10-19T06-34-03-interactive-quality-linux/playwright/summary.json).
- The exact synthetic rerun fails again. Its canonical HDR/reference ratio is
  **1.7484** for Display P3 at peak 4 and **2.5558** for Rec.2020 at peak 10,
  against the unchanged limit **1**. The first failing assertion is the canonical
  reference requirement; photographic preview-budget passes do not satisfy it.
  [Synthetic rerun](../artifacts/verification/2026-10-19T06-35-56-synthetic-quality-exact-rerun/playwright/summary.json).
- Replaying the held-reply source, edits and 628 × 518 DPR 1 Fit geometry through
  the native production tile shader passes **1 case covering both SDR gamuts in
  3.54 s**. The complete surfaces remain within the photographic budgets, with
  maximum encoded difference **0.00048828125** and unchanged alpha. At the five
  captured failure sites, sRGB Float16 outputs are identical between policies;
  Display P3 differs by one Float16 step, with a one-code difference after direct
  8-bit rounding. The separate Chromium capture still differs by two codes and
  fails its one-code limit. This distinguishes raw numerical evidence from the
  remaining compositor/capture discrepancy; it does not waive either limit.
  [Held-state numerical replay](../artifacts/verification/2026-10-19T06-53-51-held-state-numerical-replay/playwright/summary.json).
- Native pipeline rejection with complete CPU pixel recovery, actual device loss
  with one committed edit recovered on CPU, and cancellation/photo switching with
  held completed GPU work pass **3/3 in 122.71 s**. This verifies those selected
  recovery cases, not the remaining pixel or latency gates.
  [Recovery suite](../artifacts/verification/2026-10-19T06-41-34-lifecycle-recovery-linux/playwright/summary.json).

### Bounded Exposure comparison

The hardware run uses the explicit `linux-native-dpr1` profile at 1440 × 900,
Console closed, Fit and 100%, with three repetitions per view. The desktop records
a native 144 Hz display mode; the dispatched input is paced at approximately
60 Hz (**59.96–60.22 Hz** across the retained trials). Input rate, native display
rate and completed changed presentations are separate measurements. Electron
reports display frequency 0, and physical scanout remains unmeasured.
[Machine record](../artifacts/bazzite-editor/machine-before.json).

All runs complete on the requested SDR Display P3 target, peak 1, target generation
4, with matching completed target generation and expected policy. Physical output
verification remains false. F32/cache1, canonical reference/cache1 and the second
F32/cache1 run keep cache selection fixed. The first candidate run and its exact
rerun are both retained; the faster first run must not replace the rerun in the
comparison.

The retained Wayland `physicalDisplay` metadata uses Electron window bounds and
selects a secondary display, conflicting with the renderer's Microstep capability
monitor. It does not establish which physical monitor presented these frames.
The actual completed SDR target/generation checks remain valid; physical monitor
attribution remains bounded by the evidence below. The corrected helper retains
the Electron estimate with an explicit Wayland reliability warning and separately
records renderer `currentScreen`, confirmed monitor and completed generation.
Preserve the original reports rather than rewriting their metadata.

| Run                     | View | First-visible p95 (ms) | First-visible p99 (ms) | Changed visible updates/s |
| ----------------------- | ---- | ---------------------- | ---------------------- | ------------------------- |
| Candidate A             | Fit  | 56.5–62.9              | 62.6–63.2              | 25.13–26.63               |
| Candidate A             | 100% | 48.5–49.2              | 49.3–49.5              | 40.22–41.71               |
| Candidate A exact rerun | Fit  | 62.6–63.0              | 63.0–70.4              | 23.62–24.12               |
| Candidate A exact rerun | 100% | 49.3                   | 50.5–56.0              | 34.91–34.99               |
| Canonical reference B   | Fit  | 62.8–63.5              | 70.2–70.5              | 23.09–23.12               |
| Canonical reference B   | 100% | 49.4–49.6              | 49.7–55.6              | 33.25–33.42               |
| Candidate A2            | Fit  | 62.6–62.9              | 70.2–70.7              | 23.62–23.87               |
| Candidate A2            | 100% | 49.1–49.3              | 49.6–55.6              | 34.86–35.18               |

Each invocation executes one selected benchmark case containing six trials and
fails: **0 passed, 1 failed, 0 skipped**, in **30.51 / 30.41 / 30.19 / 30.39 s**
for A / A rerun / B / A2. All p95 results miss 33 ms; Fit p99 misses 50 ms, and
100% p99 has mixed results. Completed visible cadence misses the suite's 55/s
floor toward the 60/s objective. First-visible maxima remain below 100 ms in
these trials, and canonical refinement remains below 200 ms (candidate
**67.4–103.7 ms**, reference **38.9–61.8 ms**). Passing those individual limits
does not make the interaction pass. No repeatable acceptance-level improvement
is established.
[Candidate A](../artifacts/verification/2026-10-19T06-45-04-exposure-candidate-a/playwright/summary.json),
[A exact rerun](../artifacts/verification/2026-10-19T06-47-00-exposure-candidate-a-exact-rerun/playwright/summary.json),
[reference B](../artifacts/verification/2026-10-19T06-48-59-exposure-reference-b/playwright/summary.json),
[candidate A2](../artifacts/verification/2026-10-19T06-52-43-exposure-candidate-a2/playwright/summary.json).

The A-rerun/B diagnostics put mean tile-fence wall spans around **26–27 ms**
across ten fences at Fit and **13–14 ms** across five fences at 100%, plus roughly
**10 ms** retaining each presentation. GPU timestamp collection is disabled:
these are measured application wall spans, not isolated hardware computation.
They justify investigating synchronization and retained-presentation work before
assuming another arithmetic approximation will solve the latency miss.

Final focused verification requests `edit-gesture-commit`, `hdr-gesture-handoff`,
`hdr-presentation-cache`, `hdr-readback`, `write-hdr-strip` and
`editor-input-pacing`, including the runner's cheap checks. Type checking, lint,
formatting and **405 Node checks pass, with 0 failures/skips, in 22.70 s**.
This validates those selected checks and does not clear the failed native pixel,
synthetic quality or responsiveness gates.
[Focused verification](../artifacts/verification/2026-10-19T06-56-38.854Z-check-g0zsuM/summary.md).

The metadata follow-up confirms renderer `currentScreen` and the completed
monitor both identify Microstep at scale 1, while the Electron estimate still
selects LG. Its six-trial invocation fails **0 passed, 1 failed in 30.45 s**:
the first 100% trial changes SDR target from P3 generation 4 to sRGB generation 5
and back to P3 generation 6. The unchanged target-stability checks reject it.
Its exact rerun records LG/sRGB throughout, but achieves only **52.82–59.96 Hz**
input and reports **1 skipped, 0 passed in 32.30 s**, meaning configuration
acceptance is incomplete. These two runs remain separate from the earlier stable
A/B/A comparison; neither supplies an additional matched acceptance result.
Physical placement and the cause of the target transition remain unverified.
[Attribution follow-up](../artifacts/verification/2026-10-19T06-57-47-exposure-attribution-check/playwright/summary.json),
[exact rerun](../artifacts/verification/2026-10-19T06-58-49-exposure-attribution-exact-rerun/playwright/summary.json).

### Next bounded implementation scope

Resolve the canonical Linux HDR numerical mismatch and isolate/fix the remaining
held-reply compositor/capture pixel difference without relaxing their limits.
Then evaluate one bounded change to
tile submission/fence scheduling or presentation retention, preserving exact
settled pixels, source/revision ownership, history, cancellation, CPU recovery and
the 768 MiB aggregate cap. Reproduce the same Exposure Fit/100% comparison with
matched source/build identities, target, cache policy and input pacing. Require
repeatable gains and the existing **p95 ≤33 ms, p99 ≤50 ms, no >100 ms stalls,
refinement ≤200 ms** and completed-visible cadence criteria before expanding.

All-eight-slider coverage, 120 Hz load, other layouts, navigation, spatial
gestures, physical quality review and background-work contention remain pending.
No broad checkpoint, production-default change or migration follows from these
bounded failed measurements. The full continuation objective above remains open.

## Composite-policy checkpoint: October 19, 2026

A later scope audit keeps the bounded goal on the original canonical reference.
The earlier instruction to repair global canonical math before continuing is
superseded by this checkpoint: preserve that reference, report its existing
Linux failures separately, and validate the opt-in interactive path against it.
The global correction is outside this bounded implementation. It remains
preserved research and has not been adopted into settled, native or export math.

The current opt-in family is
`aces2-f32-interactive-v2-sdr3-hdr1`. It records a composite contract while choosing
actual arithmetic from the confirmed semantic display target:

| Rendering path                    | Actual arithmetic policy   | Source                                                          |
| --------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Interactive SDR feedback          | `aces2-f32-interactive-v3` | `acesSdrPreviewWgsl`, retaining the SDR matrix correction       |
| Interactive HDR feedback          | `aces2-f32-interactive-v1` | `acesPreviewWgsl`, byte-identical to the original HDR candidate |
| Settled/native preview and export | `aces2-069b0bc3-v2`        | Original canonical compensated math, byte-identical source      |

The family selector and presentation cache both remain disabled by default.
Candidate builds and launches must explicitly set
`VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32` and
`VITE_LUMA_HDR_PRESENTATION_CACHE=1`. An unset precision selector uses the
canonical reference. `VITE_LUMA_HDR_TILE_BATCH=128` is a separate opt-in scheduling
candidate; the default remains 32, with the historical 8-tile comparison retained.
Keep batch size and cache selection fixed for each arithmetic comparison.

[Composite source proof](../artifacts/bazzite-editor/composite-policy-source-proof.json)
records the restored canonical source hashes, original HDR v1 shader identity
and SDR v3 shader identity. All 11 audited canonical files are byte-identical.
The proof compares actual runtime WGSL bytes, with HDR SHA-256
`204d0f209c709fc573ffe78a9e730621187b1823a2498e9ef15df38b5982eedc`
and SDR SHA-256
`8dbd48fbbc405fd74a10d8c35fd447b3a957da1aa66651933c59cec82b5dc804`.
These are source-identity proofs, not new export or physical-display measurements.
The quality harness records the composite family,
actual target-specific policy, arithmetic shader hash and complete tile/kernel
hash for each comparison. Full photographic coverage remains 66 pairs; the
existing held-reply DPR 1 replay remains two SDR-gamut pairs. A separate targeted
DPR 2 profile retains the three observed HDR gradient offenders without changing
the full matrix or its limits.

### Preserved numerical failures and rejected global correction

The global hue/precision experiment and the eight restored tracked files are
preserved in
[the restoration ledger](../artifacts/bazzite-editor/canonical-angle-unaccepted/restoration.json).
Its expanded diagnostic evaluated **9,446 sources × nine targets × eight
general arithmetic variants**. Every variant failed at least one unchanged
canonical numerical requirement; this does not mean every individual target
failed. The retained 5,964-source prefix reproduced the experiment's original
baseline bytes. Extra cohorts include nearby Float32 inputs, complete tile
palettes and all pinned golden inputs. No variant established a general
correction suitable for adoption.
[Expanded diagnostic](../artifacts/bazzite-editor/math-diagnostic-current/2026-10-19T07-49-42.366Z-77792/summary.json).

The independent Float64 adapter also fails exact equality with the pinned JSON
fixture on Linux. Ten compiler/FMA configurations checked all **1,350 inputs ×
nine targets**; none reproduced every fixture bit. The original compilation
differs in 21,802 components, with maximum absolute error approximately
`4.97e-14`. Native/FMA-on configurations reduce that to 834 components and
`2.66e-14`, but still fail exact equality. No compiler setting, golden update or
tolerance change was adopted. This reference-reproducibility failure remains
distinct from GPU numerical failures and preview quality.
[CPU diagnostic](../artifacts/bazzite-editor/reference-reproducibility/2026-10-19T07-48-54.366Z-77276/summary.md).

### Historical verification plan at 08:02 UTC

At the 08:02 UTC documentation checkpoint, the full photographic composite run
passed **2 tests, 66 pairs, 0 failures or skips in 74.94 s**, with original DPR 2
geometry and all quality limits unchanged: street 30 pairs and deer 36 pairs.
Native capture and responsiveness were still pending at that time.
[Composite photographic summary](../artifacts/verification/2026-10-19T08-02-00-composite-photographic/playwright/summary.json).

Earlier 66-pair passes and global-v3 gradient failures retain their original
source identities and status. The earlier focused fast run passed **405 Node
checks in 22.70 s**; it preceded the composite selection and two new policy tests.
Those tests were unrun at 08:02 UTC. The subsequent focused invocation first
stopped at documentation formatting before build or native tests. These pending
statements and the commands below are historical; the later
[current results](#bazzite-current-results-october-19-2026) supersede their status.

The sequential plan at that time was to run focused policy checks, the exact
held-state replay and the native held-reply case with a matching candidate
build. The retained commands used the earlier 32-tile candidate; they are not
the current 512/final configuration:

```sh
npm run verify -- --target hdr-gesture-handoff --target edit-gesture-commit --target hdr-presentation-cache --target hdr-render-cache
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 VITE_LUMA_HDR_TILE_BATCH=32 npm run build
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 LUMA_INTERACTIVE_QUALITY_PROFILE=linux-held-reply-dpr1 npx playwright test --project=raw-gpu tests/interactive-preview-quality.spec.ts --workers=1
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 VITE_LUMA_HDR_TILE_BATCH=32 LUMA_TEST_UI_MODE=foreground npx playwright test --project=raw-gpu tests/interactive-preview-lifecycle.spec.ts --grep 'the last local input receives Float32 feedback' --workers=1
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32 VITE_LUMA_HDR_PRESENTATION_CACHE=1 VITE_LUMA_HDR_TILE_BATCH=32 LUMA_TEST_UI_MODE=foreground LUMA_PREVIEW_BENCHMARK=1 LUMA_RESPONSIVENESS_PROFILE=linux-native-dpr1 LUMA_RESPONSIVENESS_LAYOUTS=1440x900 LUMA_RESPONSIVENESS_FREQUENCIES=60 LUMA_RESPONSIVENESS_DISPLAY=sdr LUMA_RESPONSIVENESS_SLIDERS=Exposure npx playwright test --project=benchmark tests/editor-responsiveness-benchmark.spec.ts --workers=1
```

Use the short absolute `TMPDIR` described in the handoff. The numerical replay
does not establish Chromium capture equality or physical output. Keep the native
pixel limit, source/history/cancellation/CPU-recovery checks, original detail,
768 MiB presentation cap and every latency/cadence gate unchanged. Rebuild before
changing batch size or arithmetic selectors. The checkpoint required a matched
candidate/cache1 → reference/cache1 → candidate/cache1 Exposure comparison before
expanding to all eight sliders or background workloads. Later results below
record that comparison and the selected expansion. The older failed cohort does
not verify the new composite candidate. Canonical numerical and fixture failures
remain reported failures throughout.

## Bazzite current results: October 19, 2026

This section supersedes earlier pending statements for current status.
Historical failures, skipped invocations and their original shader/build
identities remain preserved. The candidate passes the bounded foreground SDR
selections below, while the background selection **fails** and native-gamut HDR
acquisition remains unresolved. Exact retry outcomes and the passing mandatory
RAW regression comparison are recorded separately below. This mixed result does not establish a
broader editor migration or change production defaults.

### Candidate and correctness boundaries

The passing candidate explicitly selects:

```sh
VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32
VITE_LUMA_HDR_PRESENTATION_CACHE=1
VITE_LUMA_HDR_TILE_BATCH=512
VITE_LUMA_HDR_INTERACTIVE_FENCE=final
LUMA_RESPONSIVENESS_PROFILE=linux-native-dpr1
```

The arithmetic family is `aces2-f32-interactive-v2-sdr3-hdr1`: confirmed SDR
feedback uses actual `aces2-f32-interactive-v3`, confirmed HDR feedback retains
the original `aces2-f32-interactive-v1`, and settled/native/export math remains
canonical `aces2-069b0bc3-v2`. Native timing/lifecycle evidence retains actual
per-frame arithmetic policy, target generation and fence selection; normal refinement
records `reference`. The source proof confirms all **11 audited canonical files
are byte-identical**. The rejected global canonical correction remains preserved
research outside this bounded implementation. Existing canonical Linux HDR
numerical failures and exact Float64-fixture reproducibility failures remain
unresolved; no reference, fixture or tolerance was changed.
[Source proof](../artifacts/bazzite-editor/composite-policy-source-proof.json),
[242-file application and build proof](../artifacts/bazzite-editor/final-build-and-source-proof.json),
[unaccepted-research restoration ledger](../artifacts/bazzite-editor/canonical-angle-unaccepted/restoration.json).

Both interactive precision and presentation caching remain disabled by default.
The tile-batch default remains 32, with 8/128/512 available only through explicit
selectors; the interactive-fence default remains `separate`. The final-fence
candidate preserves the completed CPU copy on every presentation, the awaited
final blit completion, and ownership/draining of discarded or cancelled GPU work.
Original-resolution detail, source/revision identity, single-entry gesture
history, CPU recovery and the 768 MiB aggregate presentation cap remain required.
Application fence/copy wall spans do not isolate GPU computation or measure
physical scanout.

### Completed verification

| Selection                                                           | Result                                                                                                                      |                                     Duration | Evidence                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered `interactive-preview-lifecycle`, including cheap checks  | **411 passed, 0 failed, 0 skipped**; includes four native lifecycle cases with the 512/final candidate                      |                                 **155.82 s** | [Summary](../artifacts/verification/2026-10-19T08-19-54.268Z-check-ucxJWe/summary.md)                                                                                                                                   |
| Full composite photographic quality                                 | **2 passed, 66 pairs, 0 failed, 0 skipped**; street 30 pairs and deer 36 pairs, original DPR 2 geometry and limits          |                                  **74.94 s** | [Summary](../artifacts/verification/2026-10-19T08-02-00-composite-photographic/playwright/summary.json)                                                                                                                 |
| Exact native-mode policy replay                                     | **1 passed, 1 failed, 0 skipped**; sRGB-only canvas comparison passes, native-gamut HDR acquisition fails before comparison |                                  **40.61 s** | [Summary](../artifacts/verification/2026-10-19T08-05-47.450Z-composite-mode-policy-exact-rerun/playwright/summary.json)                                                                                                 |
| Registered all-eight-slider responsiveness, including cheap checks  | **408 passed, 0 failed, 0 skipped**; one native benchmark case containing 48 gestures                                       |                                 **246.45 s** | [Summary](../artifacts/verification/2026-10-19T08-35-27.411Z-benchmark-U3Tn0G/summary.md), [compact metrics](../artifacts/bazzite-editor/all-eight-compact.json)                                                        |
| Registered Exposure background interference, including cheap checks | **407 passed, 3 failed, 1 skipped**; the native workload group has **0 passed, 3 failed, 1 skipped**                        | **677.02 s** registered; **652.49 s** native | [Registered summary](../artifacts/verification/2026-10-19T08-40-06.544Z-benchmark-i8JG2w/summary.md), [native summary](../artifacts/verification/2026-10-19T08-40-06.544Z-benchmark-i8JG2w/benchmarks/hdr/summary.json) |

The lifecycle result includes the real final-input held-reply path and native
failure/loss recovery; its pass does not relax the native pixel limit or replace
capture with metadata. Photographic shader comparisons and native Chromium
capture remain distinct evidence.

#### Native-mode replay and its limitation

The sRGB-only canvas case passes **six comparison phases and 11 bound shader phases**,
including reported HDR `headroomStops` approximately **4.57347**. This is
software rendering/capture evidence for that case. It does not certify physical
HDR luminance, native-gamut output or scanout.

The native-gamut case remains failed: the harness requests HDR but the observed
target remains SDR, so the HDR acquisition assertion fails **before its pixel
comparison**. The preceding invocation recorded **0 passed, 2 failed in 23.61 s**
with HDR acquisition failures; its exact replay improves the sRGB-only case but
does not clear native-gamut acquisition.
[Original mode-policy invocation](../artifacts/verification/2026-10-19T08-04-45.849Z-composite-mode-policy/playwright/summary.json).

#### Matched Exposure candidate–reference–candidate

Each invocation retains six trials: three at Fit and three at 100%, on the same
1440 × 900, real DPR 1, confirmed SDR target, with 60 Hz dispatched input and
presentation caching enabled. The requested 512/final scheduling configuration
is held fixed. The reference keeps canonical arithmetic and its original
offscreen synchronization behavior; its recorded deferred-fence count remains
zero. Candidate and reference source/arithmetic identities remain explicit.

| Cohort                                    | Status                            |    Duration | First-visible p95 range |
| ----------------------------------------- | --------------------------------- | ----------: | ----------------------: |
| Candidate A, after desktop activity ended | **1 passed, 0 failed, 0 skipped** | **30.67 s** |        **25.6–27.5 ms** |
| Canonical reference B                     | **0 passed, 1 failed, 0 skipped** | **30.84 s** |        **36.7–44.4 ms** |
| Candidate A2                              | **1 passed, 0 failed, 0 skipped** | **30.48 s** |        **21.3–24.6 ms** |

[Candidate A](../artifacts/verification/2026-10-19T08-30-23.990Z-matched-composite-a-attention/playwright/summary.json),
[reference B](../artifacts/verification/2026-10-19T08-32-45.618Z-matched-reference-b/playwright/summary.json),
[candidate A2](../artifacts/verification/2026-10-19T08-34-16.249Z-matched-composite-a2/playwright/summary.json).

Two preceding candidate invocations remain **incomplete: each recorded one
skipped case and zero passed cases**, because achieved input fell below the
unchanged 59.4 Hz configuration threshold. Their six-trial achieved-input ranges
were **57.76–60.16 Hz** and **57.79–60.26 Hz**. The user reported a meeting and
moving desktop windows during those separate runs. That observation motivated
fresh sequential runs after desktop activity ended; it does not convert the
skipped invocations into passes or prove that activity was their sole cause.
[First underdriven run](../artifacts/verification/2026-10-19T08-22-57.649Z-matched-composite-a/playwright/summary.json),
[exact underdriven rerun](../artifacts/verification/2026-10-19T08-25-06.582Z-matched-composite-a-exact-rerun/playwright/summary.json).

#### All eight sliders at the bounded layout and input rate

Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature and Tint
each complete three Fit and three 100% trials: **48 gestures total**. This is
one selected layout/rate case, **48 of the full matrix's 288 trials**, rather
than completion of all layouts and rates. The target is confirmed SDR P3,
generation 4, peak 1, with actual viewport DPR 1. The compositor's configured
mode is 144 Hz; observed native rAF cadence across these gestures is
130.20–143.75 Hz. Dispatched input is approximately 60 Hz. Physical scanout
remains unmeasured.

| Metric across all 48 gestures             |           Observed |                                      Unchanged gate |
| ----------------------------------------- | -----------------: | --------------------------------------------------: |
| Worst first-visible p95                   |        **32.4 ms** |                                              ≤33 ms |
| Worst first-visible p99                   |        **38.0 ms** |                                              ≤50 ms |
| Maximum first-visible latency             |        **59.9 ms** |                                             ≤100 ms |
| Minimum changed visible-update cadence    |       **59.72 Hz** |                                              ≥55 Hz |
| Maximum exact refinement                  |        **75.6 ms** |                                             ≤200 ms |
| Achieved dispatched input                 | **59.98–60.11 Hz** | ≥99% of requested 60 Hz, plus existing pacing gates |
| Maximum aggregate presentation allocation |     **691.53 MiB** |                                            ≤768 MiB |

The registered result includes its static/build/fast checks. It is a selected
responsiveness checkpoint and does not certify every GPU numerical suite or
every application regression.

### Background interference: failed bounded result

The Exposure selection is 1440 × 900 Fit at 60 Hz across four workloads. Its
complete selected contract is **four cases, 12 matched trials, 24 editor gestures
and 24 task executions**, rather than all-eight-slider background coverage.
The registered invocation reports **407 passed, 3 failed, 1 skipped in 677.02 s**;
the native group itself reports **0 passed, 3 failed, 1 skipped in 652.49 s**.
The 407 fast checks do not turn the failed native group into a pass.

| Workload                   | Case status              | Retained finding                                                                                                                                                                                                                              |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import, nine originals     | **Skipped / incomplete** | One gesture achieves approximately **57.93 Hz**, below the unchanged 59.4 Hz input requirement. Retained overlap/output evidence does not clear this configuration gate.                                                                      |
| Individual HDR export      | **Failed**               | Every editing repetition records **two history entries instead of one**. Export publication/overlap observations remain separate from this correctness failure.                                                                               |
| Nine-file HDR batch export | **Failed**               | Every editing repetition also records **two history entries instead of one**. Input achieves the required 60 Hz and timing checks pass, but the case still fails correctness.                                                                 |
| Nine-source noise merge    | **Failed**               | The first idle gesture changes target from **LG/sRGB generation 3 to Microstep/P3 generation 4**. All three editing gestures have **zero actual background-task progress observations** during their approximately four-second input windows. |

Both export failures are consistent with the unconditional editor flush in
`src/main/index.ts:329`: `export:start` calls the global `flushEditorEdits()` even
when the frozen export targets exclude the photograph whose gesture is active.
That flush splits one local gesture into a committed segment followed by another
segment, producing two Undo entries. The source-unchanged individual-export exact
rerun below reproduces the same correctness failure; the original failed result
remains preserved.

Merge review/preview preparation precedes `startMerge`, so an operation interval
can overlap a gesture while the actual background task has not started. Its
elapsed overlap includes preparation and scheduler waits; it is not evidence of
simultaneous task progress or hardware computation. The target transition and
missing actual task-progress evidence remain separate failed requirements.

All original contention requirements remain: achieved input and visible cadence,
idle/editing/contended latency, ≥500 ms overlap, ≥25 contended presentations,
observed task progress, task duration, encoder capability, actual policy/fence,
source ownership, one gesture/Undo entry and aggregate memory. A quick output or
passing batch timing result cannot substitute for the failed correctness gate.

### Exact retries and RAW regression gate

1. **Exact individual-export retry — failed: 0 passed, 1 failed, 0 skipped in
   74.75839 s.** All six gestures achieve **60.044–60.070 Hz** input and timing
   checks pass, with worst p95 **32.8 ms**. All three editing repetitions still
   record **two history entries instead of one**. This source-unchanged exact
   rerun reproduces the correctness failure; the original failure remains above.
   [Exact retry](../artifacts/verification/2026-10-19T08-53-00-export-individual-exact-rerun/playwright/summary.json).
2. **Import/merge exact retry — 1 passed, 1 failed, 0 skipped in 186.620164 s.**
   Import **passes in 52.768 s**; the original underdriven import invocation
   remains skipped/incomplete. Merge **fails in 133.446 s** with exactly three
   assertions: `progressSamplesDuringInput.length` is zero instead of greater
   than zero in each editing repetition. The earlier target transition does not
   recur, so target stability and absent actual task-progress evidence remain
   distinct observations. The original merge failure remains preserved.
   [Import/merge exact retry](../artifacts/verification/2026-10-19T08-54-00-import-merge-exact-rerun/playwright/summary.json).
3. **Required ≤15% uncorrected RAW-preview regression gate — passed.** Registered
   `preview-benchmark` passes **408 checks, 0 failures, 0 skips in 548.75 s**,
   including one benchmark case in **523.415 s**. It retains **180 observations**:
   four cold and 32 cached observations for each of five backend families.
   The real Sony fixture and baseline source identities are verified; all 11
   canonical files and all 242 application files remain unchanged from their
   respective saved proofs. Cheap checks repeat across registered invocations;
   their counts must not be added as distinct coverage.
   [Registered summary](../artifacts/verification/2026-10-19T08-59-12.216Z-benchmark-Wt1S4p/summary.md).

   The compatible [saved baseline](../artifacts/bazzite-editor/pre-angle-preview-baseline.json)
   has SHA-256
   `ba37ebb61eee940dd28cfd12f39f316ade4650051e3e02b9ca56c6fe38031e32`.
   Uncorrected CPU median is **61,197.04 ms**, a **0.022% improvement**;
   uncorrected GPU median is **2,215.08 ms**, a **1.345% regression**. Both
   remain below the unchanged 15% limits of **70,392.12 ms** and **2,513.54 ms**.
   All other existing benchmark assertions pass. This performance result does
   not clear the separately retained canonical HDR numerical failures or certify
   physical output.

### Next bounded implementation goal

Make export flushing aware of the frozen export targets. Starting or preparing
an export for other photographs must preserve the active photograph's unrelated
gesture and its **single Undo entry**. Exporting the actively edited photograph
must still flush its matching local draft and await pending writes before
freezing/using its persisted revision. Preserve the export preparation's target
identity checks, pending-write barriers and global shutdown/quit flush-and-drain
barriers; removing the global export-start flush without replacement is not the
required behavior.

Validate the concrete export/history failure first with focused tests for
unrelated and matching targets, in-flight persistence and shutdown barriers,
then rerun the exact failed native export case with unchanged correctness,
timing, overlap and memory limits. The current failed background result already
supports a **negative bounded validation conclusion**. It does not require broad
expansion or an indefinite search for a pass; retries and the mandatory RAW gate
must retain their own final statuses.

The foreground passes do not cover 120 Hz load, other layouts, all-eight-slider
background contention, HDR merge or physical HDR luminance/scanout. Preserve
historical and unresolved canonical numerical/fixture failures alongside the
final retry and RAW outcomes. No production-default or migration-readiness claim
follows from this mixed checkpoint.
