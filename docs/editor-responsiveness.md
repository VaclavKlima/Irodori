# Everyday editor responsiveness

The active goal is to make sliders, photograph selection, zooming and panning
feel immediate on the M4 Pro without perceptible preview-quality degradation.
This is an implementation and application-verification goal. Research, isolated
kernel throughput and a few fast surviving frames cannot establish completion.
The initial production baseline is `bef6a61`. Bazzite verification is deferred in
TODO #29; Mac measurements establish no Linux result.

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
[presentation contract](display-rendering.md#interactive-presentation) retains a
768 MiB aggregate budget, adapter bounds, allocation accounting, revision-aware
recovery and cleanup. Existing disk-cache and worker limits also remain in force.

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

## Initial candidate evidence

Both candidates are currently opt-in experiments on `perf/editor-responsiveness`.
`VITE_LUMA_HDR_INTERACTIVE_PRECISION=f32` selects the separately versioned
`aces2-f32-interactive-v1` math during after-view editing gestures. It retains
the same source, mip, sample positions, alpha and adjustment equations. Before,
split, navigation, settled rendering and exports keep canonical compensated
math. `VITE_LUMA_HDR_PRESENTATION_CACHE=1` independently enables exact completed
surface reuse. Its 64 MiB reservation reduces active tile capacity within the
existing 768 MiB presentation limit. No default has been changed.

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

The corrected candidate subsequently passed all 48 trials at 1440 × 900,
Console closed and 60 Hz: eight sliders × Fit/100% × three repetitions. This
run enables both experimental selectors. Fit's worst interaction p95/p99 were
26.0/26.4 ms, and 100%'s were 17.9/18.4 ms. Worst individual interaction latency
was 51.2 ms, longest presentation gap 42.9 ms, minimum visible update rate
59.23/second, and longest exact refinement 124.1 ms. At most two of 240 input
values were coalesced without a visible result; every gesture produced one
history entry and passed source, loader and attribution checks. Logical
presentation allocation was 754,566,347 bytes, including the 64 MiB reservation.
[Eight-slider report](../artifacts/verification/playwright-1792347606774-70a84872-0f11-4b05-a68d-9e85df39dea4/playwright/summary.json).

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

The navigation observer currently conflates a still-visible loader or a newer
pending request with wrong pixels in its attribution counter. At least one
flagged frame has the correct source and committed parameters while React has
not removed the loader. Preserve conservative first-useful timing, but separate
identity errors from unfinished presentation before judging attribution.

The fixed 64 MiB reservation also narrows the pre-existing GPU frame envelope:
6400 × 4800 with a 1000 × 1000 physical canvas fits without reservation at
767.94 MiB, while the reserved minimum exceeds 768 MiB. A 7008 × 4672 source can
fail even the initial upload preflight. Both are within the existing native
Float32 asset size limit. This must be corrected by draining/deactivating retained
presentations and retrying ordinary planning; raising the presentation cap is
not an option. The cache stays experimental until this and navigation tails are
resolved.

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
