# Performance expectations and development effort

## User direction — 2026-10-31

Performance expectations must reflect the action and the experience of comparable
commercial photo editors. The user explicitly accepts a loading period when
enabling or recalculating denoising. Instantaneous denoising is not a requirement.
Use GPU acceleration where it makes practical sense, and prioritize useful image
quality and a responsive editing workflow over small timing gains.

Before a costly optimization, weigh its likely improvement against development
effort and the features it would delay. Make routine decisions independently;
ask the user when substantial effort buys a small or uncertain benefit. This is
an effort and interaction policy, not permission to weaken quality, preservation,
resource, or existing numerical acceptance gates.

The [GPU-first processing policy](gpu-processing.md) selects one common production
backend per stage across macOS and Bazzite. Prefer GPU image operations, native
multicore/SIMD kernels where appropriate, and TypeScript orchestration or inexpensive
calculations. Hardware and implementation language are independent choices. This
November 2 decision supersedes the earlier GPU-only requirement.

Measure complete cold RAW opening, merge preparation and export separately,
including decode, transfers, computation, readback, encoding and publication. Use
matched inputs, quality and cold/warm conditions. Report absolute times, percentage
changes, memory and the actual selected hardware. High CPU/GPU utilization is useful
bottleneck evidence, not an acceptance criterion. Adopt a replacement only when its
complete-workflow benefit justifies the implementation and maintenance cost.
Retain the existing owner after a failed bounded candidate; do not automatically
start another optimization experiment. Competing platform-specific production
backends require explicit approval and a very large, perceptible workflow benefit.

## Expectations by action

| Action                                                           | What should feel responsive                                                                                                | What may take time                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Exposure, color and other continuous adjustments                 | Control feedback and correctly attributed useful preview updates during the gesture                                        | The separately measured exact refinement after release                     |
| Pan and zoom of an already prepared photograph                   | Reuse immutable edit/mask preparation and rendered tiles; move the view without serializing encoded coverage on each frame | First computation of newly visible source tiles at the selected resolution |
| Enable/change denoising or another expensive spatial calculation | Immediate acknowledgement, continued interface use, cancellation/supersession and honest loading feedback                  | Preparation and the exact native-resolution result after commit            |
| Open a cold RAW or change crop geometry                          | Selection/gesture feedback and an explicit pending state                                                                   | Decode, preparation and correctly identified exact detail                  |
| Export, output proof and batch processing                        | Job acknowledgement, useful status and cancellation; editing can continue where supported                                  | Full-quality processing of the frozen requested output                     |

Do not apply a continuous-slider deadline to a different operation without an
explicit action-specific decision. Existing slider measurements retain their
original scope. Waiting for expensive processing is acceptable; freezing the
interface, showing a wrong revision, silently reducing final quality or ignoring
cancellation is not. The table describes requirements, not new verification
claims for every action.

## Commercial references and fair measurements

Adobe documents Lightroom Classic Denoise as GPU-intensive and describes Enhance
and batch AI edits running in the background so the application stays usable.
This supports a separate calculation workflow, not an instantaneous-result
requirement or a universal completion time. See [Adobe Enhance](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/enhance-details.html).
Adobe also identifies file dimensions/type, adjustments, display geometry and
preview caches as performance factors in its [performance guide](https://helpx.adobe.com/lightroom-classic/desktop/technical-support/performance-guidelines/optimize-performance-lightroom.html).
These are workflow references checked on 2026-10-31, not a measured Lightroom
versus Irodori speed comparison.

Use current primary product documentation to establish the workflow, supported
inputs, acceleration and whether the action has a separate processing step. Only
claim numerical commercial timings from actual measurements or a clearly
attributed published result. If no matched result exists, record the timing as
unknown and make a provisional product decision rather than inventing a target.

Record the application/version, algorithm, source dimensions, hardware/backend,
quality, cold/warm cache state and start/end events. Compare acknowledgement,
first useful preview and exact completion separately. A learned RAW denoiser and
a classical luminance/chroma filter may inform workflow expectations without
being numerically equivalent algorithms. Neither display refresh rate nor a
synthetic input rate proves useful photograph updates or physical presentation.

## Effort decision

Before substantial optimization, write a short decision with:

- The measured delay and how often it interrupts the user.
- The likely cause, expected improvement and confidence in that estimate.
- A bounded effort estimate and the implementation work it would delay.
- A recommendation: fix now, perform one bounded experiment, or defer.

A default investigation covers one focused diagnosis and one candidate
validation, then a benefit/effort review. Extend it when evidence supports a
material gain. Ask before a substantial speculative rewrite or repeated research
cycles with uncertain benefit. Do not ask again for already authorized routine
work. When the experience meets the agreed action-specific expectation, stop
optimizing. Keep the measured limitation and the condition for revisiting it.

Record proposed acceptance-target changes explicitly before applying them;
preserve old results, source identities and thresholds. A failed or incomplete
run remains failed or incomplete. Test-infrastructure defects must not be
reported as production performance defects or silently converted to passes.

## Current professional-editing decision

As of 2026-10-31, strong-noise removal is blocked by photographic quality, not by
a requirement to finish instantaneously. Stop C16 after its retained edge failure
and weak real-photo cleanup. A bounded
[published-method trial](features/denoising-method-review.md) now evaluates a small
existing Vulkan BM3D distribution, with no application integration. Its stronger
crop cleanup is accompanied by texture and repeatability concerns, and its fixed
setting fails both retained edge gates. The trial is stopped. Reassess the
noise/domain/control mapping and reproducibility cost before another cycle;
do not automatically search more sigma values. Evaluate production runtime only after
it qualifies for adoption; CPU research execution time is not application runtime.
Before another substantial algorithm search, review the quality benefit and
remaining effort instead of automatically starting another candidate.

## Bounded post-preview check — 2026-11-01

After the strict HDR failure/retry refactor, one existing, untraced Exposure
selection was measured at native-maximized 120 Hz: Fit and 100%, three trials
each, 1,440 inputs total. The committed DSC03280.ARW, recorded SHA-256, Microstep
HDR monitor and Linux native DPR1 conditions were retained. No timer, input
driver, threshold or processing algorithm changed.

`editor-responsiveness-benchmark` is **incomplete**, exit 2: 883 shared checks
passed, zero assertions failed and the selected benchmark case skipped before
timing acceptance. The invocation took 70.08 s:
`artifacts/verification/2026-11-01T10-07-57.127Z-benchmark-Qw2IJb/summary.md`.
All display prerequisites agreed, but all six trials missed the unchanged
118.8 Hz input minimum: **106.816, 113.233, 117.249, 114.283, 115.643 and
116.836 Hz**. Recorded final-frame/histogram matches are true, but those
observations do not establish the skipped latency/cadence acceptance gates.

Stop this workstream after that single measurement. Do not repeat the grid,
reopen Chromium tracing or change the pacer merely to obtain a pass. Further
timing work requires a concrete new diagnosis or an explicit effort decision.
The remaining ten-control/native-120-Hz acceptance stays open; this is not a
demonstrated product latency failure. The separate 15% uncorrected-preview gate
does not apply to this HDR benchmark and remains a separate baseline-bound gate.

The following November 1 research stop decision remains in force under GPU-first processing: retain the completed CPU mathematical
research and use it where helpful for reference vectors. Stop the proposed
CPU-only quality-driver extension. Continue with a bounded GPU implementation and
its retained photographic references instead of building duplicate product or
verification backends. A small test-only calculation remains appropriate when
it answers a concrete correctness question.

Defer further speculative slider-pacer changes and repeated foreground cadence
experiments. Preserve the existing valid measurements and the incomplete runs.
Correct the known diagnostic trace-completeness error, then stop that investigation
unless a concrete feature decision needs more evidence. These decisions retain
the full [professional-editing scope](features/professional-editing.md), its open
acceptance gates and the existing [slider-specific contract](editor-responsiveness.md).
