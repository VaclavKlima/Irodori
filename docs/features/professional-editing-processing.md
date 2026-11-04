# Professional editing processing decisions

## Status and boundaries

**In progress; updated 2026-10-31.** This is the decision and evidence record for
[professional editing](professional-editing.md). Focused combined RAW/raster/HDR
gain-map/merge edit-export-restart, native keyboard/minimum-size, full-source
resource and enlargement checkpoints now pass in their recorded scopes. The
Sony picker has a real-RAW functional checkpoint; physical-neutral and broader
illuminant validation remain open. Strong-noise photographic quality and the
remaining sustained responsiveness gates still prevent Goal 1 acceptance.
Goal 2 remains unfinished. See the dated records below and the
[current handoff](../professional-editing-handoff.md) for exact evidence and limits.

The settings document is now version **11/catalog 21**. Catalogs 17…20 and
settings 7…10 migrate transactionally with neutral defaults for missing crop,
creative-color and denoise/detail groups while retaining existing authored groups.
Settings 7 additionally receive neutral Saturation/Vibrance defaults. Revisions,
timestamps, redo branches, originals and durable masters remain intact. Existing
Light, white balance, ACES and numerical/performance thresholds are retained.
Denoise/detail now have public controls and focused small-raster application
coverage in the [operator record](detail-processing.md). Explicit standard export
enlargement has focused evidence in the [resize record](upscaling.md). Their
remaining photographic and performance gates stay explicit; earlier dated
checkpoints and the research table retain their status at the time of each run.
The [action-specific performance policy](../performance-decisions.md) accepts a
loading phase for expensive denoising and bounds further optimization by its
likely user benefit. It does not revise numerical gates or establish quality.

The [2026-10-31 GPU cleanup](../gpu-processing.md) makes default/automatic detail
and fractional-crop preparation strict GPU operations, with explicit unsupported
precision handling and unchanged accepted-domain math. Both discrete and
integrated Radeon adapters have focused numeric/cleanup evidence. Fractional
crop near the existing alpha cutoff now refuses former CPU-repair cases,
including some fully transparent outputs; identity/integer copies remain exact.
The refreshed foreground real-Sony minimum-size/Console-open check passes 883
checks in 78.23 s with inspected captures. These changes do not close the
strong-noise, sustained-performance or broader GPU-migration gates.
The existing scene-linear RAW/merge export-rendition branch also propagates GPU
faults after encoder/resource cleanup, retaining separate legacy raster/authored
rendition and CPU resize routes. A fresh combined real-source edit/export/restart
selection passes 883 checks in 99.92 s after these policy changes:
`artifacts/verification/2026-10-31T19-59-26.702Z-check-9x6X1C/summary.md`.
Its small native export crops retain the recorded functional scope.

## Current source and output domains

| Input                          | Existing working data                                                                                                                                       | New-operator constraint                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified Sony RAW              | Scene-linear Rec.2020/D65, signed Float32, capture scale/reference white 1; source preparation includes documented demosaic, orientation and lens handling. | Preserve scene exposure and above-white values; custom white balance uses the existing camera provider.                                       |
| Durable RAW merge/noise master | Scene-linear Rec.2020/D65 with source provenance and fixed preparation corrections.                                                                         | Do not infer one camera ISO or reapply already baked lens/source corrections.                                                                 |
| Authored JPEG/PNG/TIFF         | Color-managed display-referred sRGB, decoded to linear values for processing.                                                                               | Neutral edits retain authored appearance and do not run ACES. New color operations must not introduce hidden 8-bit intermediate quantization. |
| Supported ISO HDR JPEG         | Authored HDR Rec.2020/D65 rendition with a preserved SDR primary.                                                                                           | Keep the authored-source adapter and existing HDR/SDR policy; do not apply the RAW ACES transform a second time.                              |

The current scene pipeline is source preparation → native-reference denoise/detail
→ committed geometry → custom white balance → Light → Master → RGB curves →
Saturation/Vibrance → mixer → three-way grading → fixed ACES 2 HDR/direct SDR rendition → presentation or
export. Actual export resizes use linear-light Lanczos3 after rendition transforms
and before quantization/gain-map generation. Monitor headroom changes presentation
only. Raster and authored HDR adapters keep their documented different source
semantics; common controls do not justify making them scene RAW.

Freeze the extended operator graph before integrating each affected phase. Required
order constraints are denoising before source-pixel detail sharpening; white balance
before creative color; curves before the mixer and grading; all photo color edits
before final output mapping; crop/rotation geometry before final export sizing;
output sharpening after final resize. Source preparation and expensive neighborhood
stages need reusable, versioned intermediates. Do not repeat RAW decoding during a
downstream color gesture. Placement of denoising versus lens resampling and the final
position of later output sharpening still requires its own comparisons. Curve
placement is frozen by [#45](tone-curves.md). The [detail record](detail-processing.md) retains the selected
prepared-reference placement comparison and remaining photographic acceptance.

## Color-space substrate

The initial candidate is **Oklab/D65 with explicit sRGB or Rec.2020 linear primaries**.
[Björn Ottosson's original description](https://bottosson.github.io/posts/oklab/)
motivates its perceptual hue/chroma coordinates. The conversion constants are pinned
to [CSS Color 4, 2026-10-22](https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code),
including its consistent-white, high-precision matrices. This use is a mathematical
coordinate transform, not a claim of measured perceptual uniformity over scene HDR.

[color-model.ts](../../src/shared/color-model.ts) accepts explicit linear primaries,
uses signed cube roots, preserves negative and above-white values, and applies no
transfer function, gamut mapping, adaptation, alpha operation, or clipping. Its
identity is `oklab-d65-css20261022-v1`. The Oklab transform remains a research
substrate. Its explicit primary/XYZ matrices are also used by the CIE Lab operator below.

[color-reference.py](../../scripts/research/color-reference.py) supplies an independent
80-digit Decimal oracle. It derives RGB/XYZ matrices from primary chromaticities and
D65, evaluates the published forward model with Newton cube roots, and solves inverse
matrices by elimination. It never imports application constants or functions. The
[reference fixture](../../tests/fixtures/color-model-reference.json) contains 110
synthetic samples spanning both primaries, black, mixed/signed channels, and brightness
from 1e-12 through 16× reference white, with a generator hash and attribution in the
[fixture record](../../tests/fixtures/README.md#color-model-reference-vectors).

The frozen Float64 conversion tolerances are:

- Forward Oklab component: `2e-14 + 2e-13 * abs(reference)`.
- Inverse linear RGB component: `2e-13 + 2e-12 * abs(reference)`.
- D65 neutrals: opponent components below `1e-13`; neutral lightness agrees with the
  cube root of source brightness to 12 decimal places. Signed reflection is tested.
- A 361-sample circular hue sweep at L=1.5 and C=0.2 round-trips to 12 decimal places
  without clipping. This is a numerical check, not an acceptance chart for a grade.

The `color-model` Node target verifies the external-derived vectors and reference
generator identity. Production GPU/native ports and complete operators must separately
meet the existing canonical numerical requirement `2e-6 + 2e-5 * abs(reference)`;
these conversion tests neither widen that bound nor establish perceptual quality.

## Saturation/Vibrance candidate and comparison

The [CPU research candidate](../../scripts/research/color-intensity-candidate.ts)
`oklab-chroma-intensity-v1` keeps Oklab L and hue and scales the
opponent coordinates. For integer controls S and V in −100…+100, its gain is
`(1 + S/100) * 2 ** ((V/100) * w)`, where
`w = L² / (L² + 16 * (a² + b²))`, with zero weight at the all-zero denominator.
Zero controls and exact RGB neutrals return original values exactly. S=−100 returns
equal channels at `L³`; V=−100 reduces low relative chroma toward half strength,
while V=+100 raises it toward double strength. High relative chroma is weighted
less. Weights depend on relative chroma and do not introduce an exposure threshold,
skin classifier, transfer conversion, or gamut clipping.

The independent Decimal80 fixture includes **770 operator vectors**. The candidate's
frozen reference tolerance is `2e-12 + 2e-11 * abs(reference)` per linear RGB channel.
Additional properties verify exact bypass and neutrals, complete desaturation,
Oklab L and hue preservation, exposure homogeneity from 1e-12 through 16×, relative
chroma weighting, and a closed hue sweep with the analytic circular chord length.
The preserved brightness coordinate is Oklab L; linear Y is measured separately.

A separate Decimal80 comparison evaluated saturation −50/+50/+100 on 150 positive
synthetic source/strength samples per method. The retained
[comparison](../../artifacts/research/professional-color-20261025T093029Z/comparison.json)
records these maxima:

| Method                            | Oklab hue change | Relative Oklab L change | Relative linear Y change |
| --------------------------------- | ---------------: | ----------------------: | -----------------------: |
| Linear luminance/opponent scaling |          54.409° |                 15.780% |              Below 2e-79 |
| Oklab chroma scaling              |     Below 3e-14° |             Below 4e-79 |                 159.981% |

This is a numerical comparison on an explicit synthetic corpus, not a perceptual
photo score, performance benchmark, or algorithm adoption. The luminance change in
saturated inputs requires further evaluation, including a luminance-normalized
candidate and the actual output rendition. Keep the candidate out of persisted
settings and UI until those decisions, photographic checks, and production ports
are complete.

A wider [domain sweep](../../artifacts/research/professional-color-20261025T093810952Z/luminance-normalization-domain.json)
evaluated 17,100 positive-source and 9,125 signed-source combinations across both
primaries and the full control range. Despite finite results, 270 positive-source
combinations and 178 signed-source combinations with positive input Y produced
nonpositive output Y. For example, Rec.2020 `[0, 0, 0.5]` at S=V=100 produced
Y=−0.02556 from input Y=0.02965. Directly dividing by output Y is therefore unsafe
as a luminance-normalization fix. The candidate is retained under research, outside
application processing. Resolve this behavior before adopting a production color
operator; passing its mathematical reference tests does not establish image quality.

## Implemented Saturation/Vibrance decision

The implemented operator is `cie-lab-d65-chroma-v1` in
[color-intensity.ts](../../src/shared/color-intensity.ts). It uses CIE 1976 Lab
relative to D65, deliberately distinct from CSS Lab's D50 white. The primary/XYZ
matrices and CIE piecewise constants come from the pinned
[W3C conversion reference](https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code).
The linear low-end branch extends to signed channels; neither working RGB nor Lab
is clipped to the display gamut or to reference white.

For integer S/V in −100…+100, scale Lab a/b by
`(1 + S/100) * 2 ** ((V/100) * w)`, with
`w = L² / (L² + 4*(a²+b²))`, or zero at a zero denominator. Preserve XYZ Y directly.
Zero controls, exact RGB neutrals and an identity gain bypass exactly. S=−100
returns three equal linear-Y channels. Positive Vibrance increases low relative
chroma toward double strength; negative Vibrance reduces it toward half strength.
There is no skin classifier. This preserves CIE Lab hue and linear luminance;
it does not claim perceptual hue uniformity, exposure-homogeneous weighting, or
measured HDR appearance. The earlier Oklab L-preserving candidate remains rejected
for this operator because its full-range output can reverse positive luminance.

The independent [Decimal80 fixture](../../tests/fixtures/color-intensity-reference.json)
has 924 vectors, both primaries and signed/near-black/16×-white inputs. Float64 RGB
must meet `2e-12 + 2e-11*abs(reference)`; Lab coordinates must meet
`2e-11 + 2e-12*abs(reference)`. A separate 6,480-case full-strength grid retains
finite results, linear Y within the same RGB bound, nonnegative Y for positive-Y
sources (allowing −2e-12 rounding), and Lab hue error below 1e-8 radians outside
near-neutrals (chroma at least 1e-5). GPU color retains the existing
`2e-6 + 2e-5*abs(reference)` channel bound. Thresholds were retained through the
GPU precision fix; they were not relaxed to accept its first result.

Color runs inside the existing WebGL raster, WebGPU RAW/HDR and export passes.
There is no new full-image texture upload, image pass or readback. The GPU evaluates
the algebraically equivalent XYZ chroma delta against original RGB, factoring
differences of cubes to avoid cancellation for small edits. Cached tiles and exact
completed-frame identities include both controls. First-surface neutral detection
also includes color, so a color-only edit cannot select its unadjusted branch.
An unrelated raster rendered-frame identity no longer recreates its working presenter;
the existing texture-reuse assertion now passes across color gestures.

The Float64 CPU path, raster export, preview workers and generated native CPU bridge
apply the same operator. The initial color-only native integration extended the
416-byte CPU2 and 432-byte MASKCPU2 layouts without moving existing fields. Its
historical staged helper was SHA-256
`1142235e295756d5c307e21b19d7bbd90e87174d386bef53bdc28f612252a58c`;
that receipt predates later detail integration and complete namespace adoption.
The current contracts are [native preview](../../src/shared/native-cpu-preview.ts)
and [native masks](../../src/shared/native-hdr-mask.ts). Matching rebuilt bundles,
source checksums and focused numerical evidence are retained in the
[adoption ledger](../../artifacts/irodori-rename/20261028T171959Z/summary.md).

UI numeric edits and mixed toolbar Undo/Redo/restart pass, including stdio MCP
color patches, invalid values and stale revisions. Export acceptance freezes both
color values across later editing and legitimate retries. The actual export shader
also passes independent Decimal80 color followed by independently compiled ACES CTL
for HDR and SDR; authored raster export is checked separately in linear sRGB.
These functional results do not close the real-photo/native/performance acceptance gates.

## Operator research still to complete

| Operator                    | Candidate/comparison                                                                                                                                                                       | Acceptance decision still required                                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saturation/Vibrance         | CIE Lab/D65 chroma scaling preserving linear Y; decision above.                                                                                                                            | Complete photographic/HDR visual checks and the saved performance comparison. Numerical, history and source-protection checks do not substitute for those gates.                                                                                                   |
| Curves (#45)                | Linear-light PCHIP with rational C1 tails; signed-log coordinates are graph-only. See the [curve decision](tone-curve-processing.md).                                                      | Implemented with focused Bazzite photographic/native/performance acceptance; see the [current brief and explicit boundaries](tone-curves.md).                                                                                                                      |
| Crop (Goal 1)               | Native-center affine geometry, exact copying and the [Catmull-Rom/alpha policy](crop-filter-processing.md); HDR/raster adapters, prepared variants, transient controls and frozen exports. | Functional UI/MCP, authoritative mutation checks, resource admission, migration/history and small-PNG round trips pass focused checks. Real RAW/HDR/gain-map/merge, native visual/input and source-matched performance acceptance remain open.                     |
| HSL mixer / three-way grade | Adopted original CIE Lab/D65 range/tonal model; see the [operator record](color-mixer-grading-processing.md).                                                                              | Complete real-source HDR application, photographic/native visual/input and source-matched performance acceptance. Functional history/UI/MCP and small-raster exports have focused evidence.                                                                        |
| Single-image denoise        | Original bounded NLM in fixed-reference signed coordinates selected over bilateral by the [detail comparison](detail-processing.md); separate manual Luminance/Chroma.                     | Internal CPU/tiny-GPU, preview/export reuse, constrained export admission and tiny shipped-native source consumption have focused evidence. Public history/comparison/UI/MCP, real-photo/native desktop and full-size resource/performance acceptance remain open. |
| Detail / output sharpening  | Original bounded luminance Gaussian high-pass with threshold/halo protection; see the [detail record](detail-processing.md).                                                               | Internal detail kernels, preview/export/cache reuse and tiny native consumption have focused evidence. Public adoption and real-source/full-size acceptance remain open. Output sharpening remains Goal 2 after final resize.                                      |
| Enlargement                 | Extend existing linear-light Lanczos3; optional upstream-pinned EASU/RCAS comparison.                                                                                                      | Keep no-enlargement defaults; verify output geometry and HDR/SDR round trips. FSR adoption needs the photographic/domain/port evidence in the milestone plan.                                                                                                      |

No operator is accepted merely because its conversion helpers pass. Algorithm quality
thresholds must be fixed before adoption using independent charts and real fixtures;
unfilled operator decisions remain blockers for that operator, not excuses to enable
unfinished controls.

## Persistence, resources and performance

New photo operators extend the revision-checked settings document transactionally,
including all history snapshots and redo branches, with exact neutral/identity defaults.
Add each schema change with its implemented operator; do not persist placeholder
fields or create a separate color/detail history. Numeric gesture handling remains in
the shared controller and `AdjustmentInput`.

Inspector disclosure state is additive workspace v1 data with defaults for older
checkpoints, validated by the catalog writer and restored independently of photo
settings. It does not require a photo-history or catalog schema migration.

Retain managed RAM/VRAM accounting, source leases, one interactive preview request,
stale-job cancellation and the 2 GiB disposable preview-cache limit. Neighborhood
operators must use bounded tiles/rows with validated overlap. Export/proof work shares
resource admission and freezes all settings before starting.

The saved 15% RAW preview regression described in the native-engine ledger remains
historical evidence. Its exact October 20 run directory is absent from this
checkout; unrelated benchmark JSON cannot substitute for the missing run. Before
pixel integration, an unmeasured source/build/runtime snapshot was saved at
`artifacts/professional-editing/pre-color-20261025T095721Z/manifest.json` (485 files,
20.4 MiB).

On 2026-10-29 the [isolated historical replay](../../artifacts/professional-editing/replay-20261029T073202Z/run-zPc0r5/summary.md)
completed all 180 measurements and its unchanged intrinsic gates in 512.81 seconds.
All archived source/build hashes and fixture bytes remained unchanged; the
isolated foreground profile was removed. The replay used current dependencies
matching every non-root locked entry, with actual runtime hashes recorded. This
measures the historical source under the current controlled runtime; it does not
reconstruct historical October 25 timings. The saved baseline SHA-256 is
`18efbc58d7d0a1c0de9b2009524acc38b85e09d2e928c49e0570da2da76e1d3b`.

The [current-candidate comparison](../../artifacts/verification/2026-10-29T08-25-43.683Z-benchmark-3JOmoY/summary.md)
passed its one complete benchmark case, all 180 samples and every unchanged gate
in 522.03 seconds, using that exact saved baseline. The named `gpu` bucket rose
**0.7364%** (2325.56 → 2342.68 ms) and `cpu` rose **1.1742%**
(59784.97 → 60486.99 ms); both remain below their existing baseline × 1.15 limits.
These cold totals include generation and the renderer presentation call. The
corrected-GPU/CPU, GPU/legacy and cached-presentation comparisons also pass. The
foreground window closed, its isolated profile was removed and the incoming
baseline SHA-256 remained unchanged.

The benchmark's historical `cpu`/`gpu` labels use optionless automatic lens
defaults: they are not explicit corrections-Off timings. The unchanged named-bucket
regression gate passes; dedicated corrections-Off performance acceptance remains
unverified. Do not relabel this saved dataset or infer scanout cadence from its
animation-frame waits and presentation-call durations.

A separate [real-Sony neutral comparison](../../artifacts/professional-editing/neutral-comparison-20261029T075728Z/run-rG4pnc/summary.md)
passes GPU paths with lens corrections explicitly Off and automatic verified
corrections On. Independent archived/current hosts and corresponding workers
produce equal dimensions and semantic camera/color descriptors after recorded
application-prefix substitutions. Actual retained RGBA and Float32 source bytes
are identical with zero tolerance: Off compares 80,725,248 RGBA bytes and
322,900,992 linear bytes; automatic compares 78,553,936 and 314,215,744 bytes.
All 485 original archive files, input/runtime hashes and the comparison's frozen
candidate source/output pins are preserved. The compiled preview dependency graph
used by the timing run still matches that neutral-output receipt.

These results establish default-neutral real-source output identity and the saved
preview-bucket timing comparison on this Linux host. They do not complete
denoise/sharpening photographic quality, full-size resource/contention limits, input latency, achieved
update cadence or missed presentations, native input, or physical HDR luminance.
Goal 1 and full-milestone acceptance remain pending. The user made the desktop/GPU
available on 2026-10-29 for these deferred checks; unrelated comprehensive
checkpoints still require separate agreement.

## Goal 1 combined real-source correctness — 2026-10-29

The [registered checkpoint](../../artifacts/verification/2026-10-29T08-35-51.231Z-check-DdvwV8/summary.md)
selects `professional-editing-acceptance`, `jpeg-ycbcr-model`,
`jpeg-ycbcr-reference`, `library-raw` and `import-preparation-raw`, plus cheap
checks: **792 passed, 0 failed/skipped, 114.34 seconds**, with static checks and
the production build. The two application cases take 18.48 and 40.18 seconds;
the runner retains the routine-budget warning without dropping assertions.
Automated imports use hidden, temporary profiles and preserve every original.

The first case imports the real CC0 Sony ZV-1 ARW, licensed alpine-lake photograph
and an explicitly synthetic encoded ISO gain-map chart. It combines Light,
Saturation/Vibrance, HSL, three-way grading, nonzero luminance/chroma denoising,
detail sharpening, supported custom RAW white balance and rotated/straightened
framing. Selective batch paste preserves destination crop, WB, lens and processing
identity and contributes one Undo/Redo step per changed photo. Two actual export
batches remain byte-identical after later edits; their manifests preserve accepted
revisions and settings. Tiny native crops export with explicit 2× Lanczos3
enlargement to HDR/SDR as appropriate; histories, outcomes and originals survive
restart. This is not full-size enlargement or photographic-quality acceptance.

The second case creates a fresh native-resolution v4 HDR review from the authorized
three-frame Sony BRK fixture and publishes it through the actual application API.
Published linear data and motion-mask hashes match the review. Combined edits and
selective paste preserve the master's reference WB and durable bundle. HDR/SDR
exports use a rotated/straightened 145 × 97 crop enlarged to 290 × 194. After
restart with disposable preview caches cleared, HDR re-export is byte-identical;
the complete master bundle and all source originals retain their hashes. No old
unsupported master or fabricated descriptor substitutes for the merge.

Every exported HDR RGB channel at both declared headrooms is reconstructed with
the independent Float64 ISO oracle. The maxima are **0.006798** for the mixed-input
case and **0.001253** for the merge case, below the unchanged strict **0.02** bound.
The [test-only JPEG reader](../../tests/jpeg-ycbcr-reference.md) declares its pinned
libjpeg-turbo 3.2.0/Python prerequisites and records actual library hashes. It reads
raw base YCbCr before independent floating-point conversion; gain-map channels
remain numerical RGB8 codes. A retained failed run exposed an extra base-RGB8
rounding error in the earlier oracle. No application codec, tolerance, pixel or
channel exclusion changed. Missing test prerequisites mean incomplete verification.

These passes close combined application correctness for those sources and settings.
Independent photographic/native-detail review, whole-source CPU/GPU agreement,
full-size resource/cancellation/contention and sustained native responsiveness
remain required before Goal 1 acceptance. They establish neither physical HDR
luminance nor coverage on other platforms. Both editing goals remain unfinished.

## Whole-source noise reduction and detail agreement — 2026-10-29

The [registered comparison](../../artifacts/verification/2026-10-29T09-06-39.086Z-check-sUEej5/summary.md)
selects `professional-source-agreement` and `professional-master-agreement`, plus
cheap checks: **787 passed, 0 failed/skipped, 372.75 seconds**, including static
checks and the production build. The real RAW case takes 167.75 seconds and the
master case 166.93 seconds, principally their deliberate canonical CPU reference
work. These durations are not editor responsiveness measurements.

The actual native Sony RAW produces a 5496 × 3672 Float32 Rec.2020 source; the
authenticated, freshly published v4 HDR master is 3654 × 5450. Distinct production
CPU and forced GPU strip implementations apply Luminance/Chroma 35/45 followed
by detail Amount 40, Radius 1.2 and Threshold 50. All **120,286,836 RGB channels**
across both complete sources meet the unchanged `2e-6 + 2e-5 abs(reference)` bound.
Maximum error-to-bound ratios are 0.124521 for RAW and 0.027078 for the master;
alpha is bit-exact, every result is finite and originals/masters retain their hashes.

Both GPU runs report native GPU tiles, zero CPU or precision-recovery tiles,
at most three retained source strips and zero remaining GPU allocation after
completion. Actual source/output files and individual strip hashes are retained
in the [ledger](../../artifacts/professional-editing/full-source-20261029T090639Z/summary.md).
The master-only target deliberately requires an authenticated retained current
bundle; its missing prerequisite means incomplete verification. Its three original
Sony inputs are committed fixtures and the combined case regenerates the bundle.

This closes full-source scene-linear NR/detail agreement for those inputs and
settings. It does not prove every color/display stage, physical peak RAM/VRAM,
cancellation, contention, native input or photographic quality. Late supplemental
process-RSS/global-VRAM samples remain separate observations with explicit limits.

## Full-native resources and enlargement — 2026-10-29

The [registered checkpoint](../../artifacts/verification/2026-10-29T10-01-57.409Z-check-iFODGw/summary.md)
selects `professional-detail-resources` and `professional-enlargement-fullsize`,
plus cheap checks: **787 passed, 0 failed/skipped, 63.99 seconds**. The actual
full-RAW resource case takes 7.86 seconds and enlargement takes 17.31 seconds.

The resource case prepares the real 5496 × 3672 Sony source, exercises exact
stream-budget admission and one-byte-under GPU VRAM, GPU host RAM and CPU RAM
refusals before publication/allocation, then cancels actual GPU and canonical CPU
work after the first written 64-row band. Owned partial outputs disappear only
after retirement. GPU retry at the same path verifies every strip and full hash,
1,276 GPU tiles, zero CPU/recovery tiles, at most three source strips, unchanged
source/original bytes and zero remaining GPU allocation. This is completed-band
cancellation, not an in-flight shader reset or whole-application contention test.

The enlargement case uses the actual application, an isolated library and public
2 GiB RAM/VRAM preferences. Nonneutral Light, Saturation/Vibrance, HSL, three-way
grading, denoise/detail and corrections-Off settings are frozen from the full
uncropped RAW. The unchanged 33,554,432-pixel cap causes the actual 2× request
(10992 × 7344) to fail without publishing a JPEG. A separate, explicit 1.25×
Lanczos3 request produces a real 6870 × 4590 quality-100 SDR JPEG. Worker revision
receipts and admitted render/encode plans match the accepted job despite later
edits; output hash, history, originals and accepted settings survive restart.
The JPEG and a clearly resized review PNG remain outside the removed profile.
No limit was raised and no full-size HDR or performance claim follows.

## Native editing and pending-save focus — 2026-10-29

The [foreground checkpoint](../../artifacts/verification/2026-10-29T10-04-16.925Z-check-pkm3n6/summary.md)
selects `professional-editor-native` and `adjustment-input-visual`, plus cheap
checks: **788 passed, 0 failed/skipped, 79.76 seconds**. Three isolated native
cases preserve the original 1600%/Console capture, all four compact tonal-control
captures, Sony 8000 K/Tint 25 composition, and a real Sony edit through crop,
color/mixer/grading and all detail controls at 1100 × 700. Frame revision, completed
serial, source identity and display generation agree; the displayed source's
actual cached metadata identifies sensor-decoded linear data. Nonblank native
captures and original hashes are retained. Keyboard delivery uses trusted Electron
events with native focus guards; physical input devices and HDR luminance remain
unverified.

This exposed and fixed a real shared-input issue: a pending save disabled the
focused element and dropped keyboard focus. Numeric fields now become read-only
and sliders guard busy gestures while retaining their DOM focus. Genuine
unavailability still disables controls; serialization remains in the existing
edit owner. Gated hidden regressions verify Tab/copy/selection, rejected busy
changes, held-key/pointer releases and subsequent valid edits without extra history.

Five legacy background resize cases stalled in Wayland's hidden compositor
stability/IntersectionObserver paths. Their edit/history/restart assertions remain
in background tests using measured geometry; native capture/visibility assertions
remain in the explicit foreground target. All five exact reruns pass, followed by
the corrected white-balance history/restart case. No automatic visible fallback,
weakened quality threshold or comprehensive checkpoint was introduced.

## Strong-noise acceptance remains open — 2026-10-29

The historical seven-source native review includes published low/high-ISO Sony portraits,
real noise-burst frames, foliage, genuine merge boundaries and an attributed
observed starfield. All real inputs are retained in GitHub; generated evidence
stays ignored. The [gallery](../../artifacts/professional-editing/native-detail-proof-20261029T084420Z/extended-review-20261029T093454Z/gallery.html)
retains exact native/output pixel mappings and bounded model observations.

The ISO 6400 portrait remains heavily noisy at v1 strengths 50 and 100. Separate
75/100 characterization retains the same source, ACES settings and original
comparison; it changes no algorithm or gate. Source/proof hashes and bounded
patch-weight analysis show a fixed-bandwidth/guidance efficacy limit rather than
an inactive filter. The user explicitly chose stronger noise removal **within
Goal 1**. Noise-aware candidates therefore require a predeclared comparison,
unchanged original quality gates, additional high-noise truth/holdouts and explicit
legacy settings/history/export/batch compatibility before adoption. Existing v1
edits and failed evidence must remain intact. Neither goal is complete.

Comparison 3 retained 21 high-noise flat measurements and 360 nominal measurements.
All three deployable alternatives failed the original texture gate; none was
adopted. In [Comparison 4](../../artifacts/detail-research/comparison-4-draft-20261029/),
narrower luminance widths 0.024 and 0.032 each passed all 120 original and 48 fresh
nominal cases. Both were then rejected: the maximum-strength high-noise
isoluminant boundary leaked about 9.71% of its clean step, exceeding the unchanged
3% limit. The other 17 selected high-noise cases per candidate passed. Reserved
high-noise levels/seeds remain unexamined. The next comparison must address
chroma boundaries and gentle low-strength behavior before any versioned adoption.

Comparisons 5 and 6 also remain rejected. Narrower chroma widths and a separately
declared smooth, opacity-aware reference-weight policy preserved screened stars
and texture but still exceeded the same colored-edge limit (about 3.27–3.37%
against 3%). The ungated reference-weight diagnostic damaged isolated stars and
is explicitly ineligible for adoption. Retained-source analysis found that the
unfiltered noisy edge already has a 3.41% column-mean error; narrow pixelwise
patch matching largely retains that fluctuation, while broader matching mixes
across the edge. These results motivate examining overlapping patch estimates;
they do not authorize a weaker threshold or an accepted replacement operator.

Comparison 7 now evaluates actual overlapping normalized patch estimates, with
an explicit Float32 publication between estimation and aggregation. Its
[initial 88-measurement screen](../../artifacts/detail-research/comparison-7-draft-20261030/run-bke65rma/summary.md)
retains every old gate and adds mandatory A/B fine-color textures. Two narrow
chroma settings passed all 22 selected cases each, including the previously
failing colored edge. The broader setting was rejected for flattening period4
color texture; its results and the rejected pixelwise comparator remain intact.
The two survivors subsequently passed **160 nominal, 64 examined-seed regression
and 64 fresh-seed cases each**, with all frozen source/reference and result-file
hashes verified. These are synthetic research measurements, not application tests
or a new accepted denoiser. The candidate with stronger screened chroma reduction
continues through the declared high-noise cases. Independent Decimal80 stage
references, full high-noise holdouts, native photographic quality, CPU/GPU,
legacy compatibility, resource/cancellation and performance remain open.
Existing v1 processing and authored edits are unchanged.

On October 30, the independent reference review corrected an exponential-tail
shortcut, introduced an explicit canonical-zero policy for intermediate E values,
and extended the checker to all alpha/transparent/neutral pixels plus final RGB.
The [explicit reference target](../../artifacts/verification/2026-10-30T08-11-16.229Z-check-Gb0tgp/summary.md)
passed **788 checks in 60.28 seconds**, with no failures/skips. The numerical
selections cover all15 declared recipes for C .040:414 and322 configurations
with a shared pair anchor,1537 integer-converter vectors, exact intermediate
words, signed/HDR, tiny/subnormal alpha and common scaling. These selections
overlap; they do not establish candidate GPU or photographic acceptance.

The subsequent [reserved strongest-noise boundary](../../artifacts/detail-research/strong-noise/run-b2i3rw_t/summary.md)
rejects **both** remaining fixed-width C7 candidates: at sigma .10 / seed1 /
Rec.2020 / strength100, leakage is3.453% for C .024 and3.331% for C .040,
exceeding the unchanged3% limit. Edge width, finite values and exact alpha pass.
Earlier passes and the new failures remain preserved, including an archive of
the exact frozen sources. No fixed-width C7 candidate is accepted, and the
remaining reserved high-noise cases were not run. A separately declared
noise-scaled chroma bandwidth retains the same patchwise estimator,
source-bound global statistics and original quality gates.

The separately frozen C8 study tested chroma maximum
`sqrt(.024^2 + k^2 * (varianceA + varianceB))`, with k .40 and .55. Both passed
the initial 15-source screen, 320 nominal measurements and two 128-measurement
examined-seed regressions. The [128-measurement fresh cohort](../../artifacts/detail-research/strong-noise/comparison8/run-zalu54va/summary.md)
then produced four required texture failures: the shared period-4 luminance
realization entered at about 1.060304 clean-relative amplitude and left at about
1.060434, above the unchanged 1.05 limit for both factors/primaries. Both C8
candidates remain rejected; the remaining high-noise cohorts were not executed.
The sources, failures, thresholds and exact frozen-code archives are retained.

The small chart's coherent entering noise makes that per-case amplitude metric
an unreliable isolated measure of operator gain. A separate future population
must be frozen and qualified before filtering; this does not rescue the failed
C8 protocol or permit changing its limits. The partial population helper is
committed for continuity, with no executable C9 study or acceptance claim.

The [combined independent reference selection](../../artifacts/verification/2026-10-30T08-55-41.936Z-check-J7g3Lh/summary.md)
passed **790 checks in 100.84 seconds**, including all 15 recipes for C .040 and
both C8 factors. The separate [source-wide estimator selection](../../artifacts/verification/2026-10-30T08-32-10.192Z-check-hVvgPs/summary.md)
passed **793 checks in 41.61 seconds**, including eight estimator cases. These
selections overlap in their cheap checks. The bounded CPU estimator remains
unwired research: caller-owned source verification/admission, deterministic
directional sampling, alpha-weighted MAD, cancellation and independent Python
agreement are checked. Full-source throughput, GPU processing, photographs,
versioned integration and remaining resource/performance acceptance stay open.

## Strong-noise research: qualified population and GPU prototype — 2026-10-30

The separate [C9 methodology](../../assets/tests/references/detail/strong-noise/texture-population.md)
preserves C8 mathematics, coefficients and quality limits. It changes only the
prospectively declared fresh periodic texture population to 136 × 136 nominal
grids, with original amplitudes/noise and new fixed seeds. Accepted original
small-chart regressions remain mandatory, and every C8 failure remains rejected.
The independent source-only [qualification](../../artifacts/detail-research/strong-noise/comparison9/qualification-i0jvobmt/summary.md)
completed all **64 inputs in 8.09 seconds**, with zero baseline failures and no
candidate import/filtering. Its 36 identity texture scores span 0.991340–1.006952;
the unchanged interval is 0.90–1.05. Clean/entering hashes, dimensions and actual
pattern-energy design uncertainty are retained before any C9 output.

The selected k .55 candidate then passed the [complete fresh family](../../artifacts/detail-research/strong-noise/comparison9/run-jtxn_2oh/summary.md):
**64 measurements, zero required failures, 299.42 seconds**. Texture retention
spans 0.953415–1.006083. All 192 Float32 files and 18 frozen source pins were
hash-verified and the source archive retained. This is one candidate and one
cohort, not adoption or completion of the required high-noise matrix.

The unenabled `gpu.ts`/`gpu-wgsl.ts` research owner uses feature preparation,
per-center patch estimation and output gathering, with a 256-pixel tile and halo 5. Six reusable GPU buffers total **11,550,384 bytes**; conservative owned numeric
storage including its private source copy, output and uniform totals 13,731,184
bytes. Source leases/cache and driver/runtime overhead remain separately owned.
The owner validates admission before allocation, freezes parameters before await,
serializes jobs and retires submitted work before release. Tiny positive alpha
below 2^-20 remains explicitly unsupported pending equivalent Float64 recovery.
Nonfinite internal features propagate checked refusal, including extreme finite
HDR inputs that overflow intermediate Float32 arithmetic.

The [corrected exact-case rerun](../../artifacts/verification/playwright-1793353234578-6a4031e4-ed86-4c90-b9e6-e8f01b255dd6/playwright/summary.json)
passes all three selected hardware cases: **558 independent Decimal80
configurations, 5,298 RGB channels**, largest normalized tolerance error 0.008788,
132 explicit tiny-alpha refusals, extreme-feature refusal, and bit-identical
whole/tiled output on a separate signed/HDR fractional-alpha chart. Admission,
neutral, cancellation/busy and queue-retirement cases pass separately. Preserve
the initial invalid-dimension test and subsequent shader constant-NaN compilation
failure; neither is a passing target invocation. Raw intermediate estimate words
now retain their declared Float32 bits in scalar Uint32 storage; no RGB/quality
tolerance changed. The GPU checks prove final referenced RGB and alpha/copy
behavior, not the stronger CPU exact intermediate-word proof.

The isolated research-child target adds full-source hash verification, bounded
whole-source estimation, sequential requests, exact parent/child GPU output,
neutral bytes, wrong-hash/path refusal and cleanup. Its [focused selection](../../artifacts/verification/2026-10-30T09-44-57.982Z-check-uEmgax/summary.md)
passed **786 checks in 40.05 seconds**, including type checking, lint, formatting,
build and overlapping fast Node checks. Dawn remains external to the research
bundle. The GPU study driver requires the frozen C9 qualification and can bind
every CPU input/output and estimator statistic before accelerating quality work.
This remains research: no public v2 settings, fallback, migration, photographic
quality, full-size resources or sustained presentation acceptance is claimed.

## Strong-noise C9 high-noise rejection — 2026-10-30

The resumed checkpoint includes the [interrupted high-noise GPU run](../../artifacts/detail-research/strong-noise/comparison9-gpu/run-6zfo1gji/failure.json):
410 of 624 measurements completed before KeyboardInterrupt, with the child closed
and its reader retired. Four completed required rows already fail `edgeLeakage`.
The absent terminal summary did not make those retained failures disappear. The
64-input qualification applies to the separately declared fresh population; it
does not qualify the entire high-noise matrix or override any quality gate.

| Retained row | Primaries | Sigma / seed / strength | Entering edge error | GPU output edge error |
| ------------ | --------- | ----------------------- | ------------------- | --------------------- |
| 292          | sRGB      | .10 / 1 / 75            | 4.264053%           | 3.260991%             |
| 298          | Rec.2020  | .10 / 1 / 75            | 4.264059%           | 3.260997%             |
| 317          | sRGB      | .10 / 0xDEADBEEF / 100  | 2.561674%           | 4.166658%             |
| 323          | Rec.2020  | .10 / 0xDEADBEEF / 100  | 2.561668%           | 4.166655%             |

The fixed limit remains **3%**. In the strongest pair the entering image passes
and the filter introduces the failure, so input phase noise cannot explain it.

A [four-row archived CPU replay](../../artifacts/detail-research/strong-noise/four-row-cpu-replay-7f_z_frt/summary.md)
then filtered only those exact retained Float32 inputs, using the archived
equations and frozen whole-source estimator descriptors. All 78 source/input/
output/runtime/driver pins remained unchanged. In **33.607 seconds**, all four CPU
outputs failed the same edge gate, while all **221,952 RGB channels** agreed with
the GPU under the unchanged `2e-6 + 2e-5 * abs(reference)` bound. The maximum
normalized error was **0.027298**; all **73,984 alpha words** matched exactly.
No input regeneration, new seeds, GPU work, full matrix rerun or photographic
acceptance was performed.

The **C9 k .55 policy is rejected**, independently of the GPU port. The preceding
fresh-family passes remain valid but insufficient. The other C9 candidate has no
new acceptance; C7/C8 rejection and the public NR v1 implementation remain
unchanged. Preserve the interrupted run and its original declarations. Camera
updates changed AGENTS.md/assets documentation pins, so a future study needs a
new frozen execution epoch rather than edited historical hashes.

The retained [mechanism analysis](../../artifacts/detail-research/strong-noise/four-row-cpu-replay-7f_z_frt/diagnosis.md)
locates opposite-signed cross-edge chroma changes in patch proposals, before RGB
reconstruction. Noise-bias subtraction followed by zero clipping is a proposed
explanation for accepting dissimilar noisy patches; individual clipped-match
counts have not been measured. A possible next authored policy would add a
noise-corrected patch-mean chroma distance, with exact overlap/clamp/alpha
covariance, while preserving every source, coefficient and quality threshold.
It is not implemented, declared, executed or accepted by this record. Freeze and
independently verify any such policy before filtering or GPU adoption.

The new source-only study audit preserves cumulative mandatory/CPU-agreement
failures in durable progress and derives terminal reporting from completed rows
after child cleanup, including interruption and cleanup errors. GPU preflight
also reconstructs the embedded CPU evidence descriptor from pinned CPU rows
before starting a child. Its independent retained-run command writes only into
a separate fresh directory and marks truncated/malformed or changing snapshots
incomplete. It reports recorded gates, not source/photographic revalidation.

The [retained C9 audit](../../artifacts/detail-research/strong-noise/c9-resumed-retained-audit-20261030/summary.md)
reports **410/624 rows, four mandatory failures, zero malformed rows, no incomplete
tail and recorded child closure**. Exit 1 is expected for that interrupted,
rejected selection; the old run is untouched. The registered
`strong-noise-study-audit` target plus shared static/fast checks passed **871
tests, zero failures/skips, in 46.4 seconds**. Its four synthetic regressions
exercise interrupted/malformed rows, immutable standalone auditing, fake-child
termination and CPU descriptor tampering, with no GPU, filtering, new inputs or
comprehensive checkpoint. Evidence:
`artifacts/verification/2026-10-30T12-24-13.230Z-check-m2CuoJ/summary.md`.

## Strong-noise C10 mean guard rejected — 2026-10-30

The separately [declared mean-distance guard](../../assets/tests/references/detail/strong-noise/patch-mean-guard.md)
preserved C9's source estimator, coefficients, footprint, strength transfer,
self contribution, Float32 stage, aggregation and inverse. It raised only the
chroma matching distance using a patch mean with exact overlap/clamp/alpha noise
covariance; luminance guidance remained unchanged.

The independent `strong-noise-mean-guard` helper selection passed **844 statistics
configurations / 3,376 fields**, **45 guard evaluations**, exact rational grouping
and covariance proofs, hidden-feature/common-alpha-scale invariance and both
deliberately wrong helper rejections. Maximum normalized statistics error was
**0.000155105**; the smallest positive tested coverage was **1.76727e-89**.
All four service tests passed in **1.7 seconds**, without denoising or GPU work.
Evidence: `artifacts/verification/mean-guard-helper-b6skqj6l/`.

The diagnostic declaration froze **148 code/input/runtime/reference pins** and
all forty prospective examined regression inputs before filtering. Its first
stage then completed the four known failing inputs in **109.315 seconds**:

| Row | C9 leakage | C10 leakage | Fixed limit |
| --- | ---------- | ----------- | ----------- |
| 292 | 3.260991%  | 3.523892%   | <=3%        |
| 298 | 3.260997%  | 3.523899%   | <=3%        |
| 317 | 4.166658%  | 3.902423%   | <=3%        |
| 323 | 4.166655%  | 3.902419%   | <=3%        |

Every case still fails `edgeLeakage`; all other recorded gates and exact alpha
words pass, and every frozen pin remains unchanged. Reducing individual matching
weights does not guarantee a better normalized estimate: its bias change depends
on covariance between the weight reduction and sample changes. The guarded
policy is **rejected**. Per the predeclared stop rule, the 24 flat and 12 texture
stages and a GPU port were **not executed**. No public processing/history version
or acceptance threshold changed. Retain the failed first freeze preflight as a
harness count correction: the guard proof has five statistics configurations and
45 distance evaluations, rather than 45 statistics configurations; no candidate
was imported by that failed preflight.

Frozen declaration SHA-256:
`817cb5ee18a4a2e68ee90860d71404fa8f0cec6f1802dbc63dd7e6e1d96341e5`.
Evidence:
`artifacts/detail-research/strong-noise/c10-mean-guard-screen-20261030/run-edge-regression-hydk6meh/summary.md`.
The standalone frozen driver/source copies remain with that ignored experiment;
the maintained policy, equations and independent helper tests preserve its math.

Before inventing a further kernel, evaluate the already-declared C9 k .40 option
under a new execution epoch. It has no C9 outputs. Its old C8 nominal/C4/C7
regressions passed; C8's two failed small fresh texture realizations remain
rejected under C8. One k .40 high-noise edge is already examined and narrowly
passes at 2.992067%: sigma .10 / seed 1 / Rec.2020 / strength 100. Preserve that
continuity anchor and do not call it a new holdout. A selected eight-case edge
screen does not replace C9 fresh-population, full high-noise or other acceptance.

## C9 k .40 edge screen rejected — 2026-10-30

A new execution epoch preserved the unchanged C9 equations and all prior failures,
then completed candidate-free qualification of the same 64 fresh inputs with no
baseline failures. The qualification is bound to the new CPU declaration rather
than edited historical pins. The predeclared k .40 alternative then ran eight
sigma .10 edge cases: both primaries, seeds 1/0xDEADBEEF and strengths 75/100.

The GPU [eight-case selection](../../artifacts/detail-research/strong-noise/comparison9-gpu/run-vcolhc_q/summary.md)
completed in **5.958 seconds**, with four required edge failures and clean child
retirement. Seed 1 / strength 75 gives **3.376283–3.376292%** leakage; seed
0xDEADBEEF / strength 100 gives **3.268155–3.268161%**. The limit remains **3%**.
Other recorded gates pass. This is not a full C9 matrix or an independent
photographic result.

A [four-row archived CPU replay](../../artifacts/detail-research/strong-noise/k40-four-row-cpu-replay-vuoeffl4/summary.md)
reproduces every failure in **48.484 seconds**. All **221,952 RGB channels** match
the GPU under the unchanged bound, with maximum normalized error **0.027230**;
all **73,984 alpha words** match exactly and all 86 frozen pins remain unchanged.
The retained passing Rec.2020 / seed 1 / strength 100 anchor also matches the
existing C8 CPU output without another filter run: source hashes are identical,
all 55,488 RGB channels agree, and 18,496 alpha words are exact. Its GPU leakage
is **2.992066%**, versus the saved CPU **2.992067%**. That examined anchor is not
a new holdout.

Both predeclared C9 noise-scaled policies are therefore rejected by CPU policy
behavior, not GPU numerical error. Stop their quality matrices. C10's separate
mean-distance guard also remains rejected. No public v2 method, compatibility
migration or photographic acceptance is enabled by these experiments.

The next policy review should examine the spatial weighting rather than tune
another bandwidth against these failures. The
[primary NLM formulation](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm)
uses patch-distance weights within a bounded search; our additional Gaussian
spatial prior favors nearby samples. An authored chroma-only uniform-search
hypothesis could retain the existing 7x7/3x3 footprint, k .40, all luminance
weights and every other coefficient, while increasing relative support from
distant candidates. It also increases incorrect distant matches and boundary
self multiplicity; improved bias or quality is not guaranteed. Keep the d=0
self contribution explicit, preserve the C9 default path, and freeze new
independent full-operator references and the finite screen before any execution.
This is a proposed next direction, not an implemented or accepted policy.

The final focused `strong-noise-mean-guard` selection completed **875 tests with
zero failures/skips in 54.2 seconds**, including static checks, overlapping fast
Node regressions and the four independent helper cases. It performs no GPU or
quality filtering and does not overturn the C10 rejection. Summary:
`artifacts/verification/2026-10-30T13-13-37.133Z-check-9EiOQh/summary.md`.

## Strong-noise C11 independent arithmetic — 2026-10-30

The separately declared [C11 uniform-search policy](../../assets/tests/references/detail/strong-noise/chroma-uniform-search.md)
changes only chroma's spatial multiplier inside the existing 7×7 search.
Luminance retains its Gaussian prior and original chroma guide. This unenabled
candidate does not replace public NR v1 or overturn any C7–C10 rejection.

The registered `strong-noise-chroma-uniform` target passes **875 checks, zero
failures/skips/interruptions, in 69.92 seconds**, including shared cheap/static/
build checks. Its four service cases take 11.90 seconds and cover 108 core,
84 alpha, 12 asymmetric and 180 C=0 identity configurations. The separate direct
Decimal80 reference checks 1,908 pre-final and 1,908 final RGB channels and
50,058 exact published stage words. C=0 comparisons preserve 87,750 research-C9
stage words exactly; this is not an identity claim about public NR v1. A
Gaussian-chroma substitution is rejected. The routine duration exceeds the
60-second aim without removing assertions. Summary:
`artifacts/verification/2026-10-30T13-39-32.604Z-check-yzpvdy/summary.md`.

Before quality filtering, a candidate-free freeze binds all four executed
reference/comparison/approval groups, exact retained input words and estimator
descriptors, equations, driver, runtime and archived metric helpers: **177 pins,
38 archived source/evidence copies, 44 examined regression records**. Declaration:
`artifacts/detail-research/strong-noise/c11-chroma-uniform-screen-xtfwtlmp/freeze-dtldlfhc/declaration.json`,
SHA-256 `2b9be40874785df6455451cf6d27ba906f0740ff6c266727420d7b3578781952`.
Root independently rehashed every pin/copy before authorizing only the complete
eight-edge first stage. No quality result or GPU execution is established by
this numerical checkpoint. Later stages require passing earlier receipts;
unchanged quality gates, photographic review, equivalent recovery, compatibility,
full-source resources and sustained performance remain required.

The first quality launch stopped before candidate import, lock acquisition or
output because the archived invocation helper's `study-audit.py` dependency was
missing. Preserve that failed preflight and declaration; no filtering occurred.
A new driver/declaration adds only that dependency, with **178 pins and 39
archived copies**, all independently rehashed by root. Repaired declaration:
`artifacts/detail-research/strong-noise/c11-chroma-uniform-screen-v2-q84x78l7/freeze-zl9iuoqp/declaration.json`,
SHA-256 `cc9abd8a2f15202be4ce57e07c04ac182381ce2d5d82a55ad92d1fd7d959ffd4`.
Its candidate-free freeze takes 0.230 seconds; equations, inputs, proof receipts
and thresholds stay unchanged. Quality work resumed after the separately
authorized native desktop checks closed.

The repaired eight-edge CPU stage completed **8/8 in 69.832 seconds** with four
mandatory leakage failures, so **C11 is rejected**. Seed 1 at strength 75 fails
in sRGB/Rec.2020 at `0.03081309937` / `0.03081315331`; seed `0xDEADBEEF` at
strength 100 fails at `0.03322926074` / `0.03322921219`, against the unchanged
`0.03` limit. The other four cases pass. Every remaining edge-width, finite and
alpha gate passes; all 178 pins and 39 archived copies stay unchanged. The owned
lock is released with no children or bytecode writes. Summary:
`artifacts/detail-research/strong-noise/c11-chroma-uniform-screen-v2-q84x78l7/run-edge-regression-on90xff5/summary.md`.
Do not run C11's later flat/texture stages or GPU tests as adoption evidence.
Its passing numerical checks do not override this quality rejection. Public
NR v1 remains unchanged.

## Strong-noise C12 arithmetic and frozen screen — 2026-10-30

The separate [C12 wider-chroma policy](../../assets/tests/references/detail/strong-noise/chroma-wide-search.md)
retains luminance's radius3 Gaussian search and changes only chroma's uniform
support to radius10. All previous rejections, coefficients, strength semantics,
original required labels and quality limits remain unchanged. Public NR v1 is
unchanged; no new application denoiser is enabled.

The explicit `strong-noise-chroma-wide`, `jpeg-ycbcr-fullsize-reference` and
`jpeg-ycbcr-reference` selection passes **880 checks, zero failures/skips/
interruptions, in 90.53 seconds**. Its routine duration warning is retained.
Summary: `artifacts/verification/2026-10-30T14-26-46.807Z-check-yqmwiH/summary.md`.
C12's four numerical cases cover 120 core, 84 alpha, 12 asymmetric and 180 C=0
identity configurations. Independent Decimal80 checks cover **2,016 pre-final
and 2,016 final RGB channels, 55,728 exact published stage words**, plus 87,750
old research-C9 C=0 stage words. The new25x3 vector explicitly includes a
farther source sample, different L/C bound radii and wrong-radius/Gaussian
counterfeits. These passing arithmetic checks do not establish quality.

A new candidate-free freeze binds all four executed comparison/reference/
approval groups and the same44 examined regression records as C11, with exact
input/estimator associations and archived metric helpers. Root and a second
reviewer independently rehash all **178 pins and 39 archived copies**. Declaration:
`artifacts/detail-research/strong-noise/c12-chroma-wide-screen-zmxaqv83/freeze-cowbzvrh/declaration.json`,
SHA-256 `27f7538061c6a0af8d46ba48f16912c94855e6581912afa5078b8acf783cc663`.
The invocation helper's audit dependency and the entire legacy C=0 import chain
are included. Mutable status ledgers and unrelated JPEG/HDR helper sources are
excluded from these pins.

Only the complete eight-edge first stage is authorized, using one Python worker
at nice15 while the user plays. Output:
`artifacts/detail-research/strong-noise/c12-chroma-wide-screen-zmxaqv83/run-edge-regression-nn9o_0u7/`.
No later stage, GPU work, new photograph or performance acceptance is authorized
by this screen. Preserve every row and judge quality only after all eight
complete. A required failure rejects the candidate; later stages require exact
passing earlier receipts and root verification of completion counts. The
inherited one-off driver writes a failure record and unwinds its lock on error,
but an exceptional exit may lack the normal final cleanup receipt; do not
reinterpret that as a completed stage.

The first stage completed **8/8 in 700.397 seconds** at nice15, with **two
mandatory failures**, rejecting C12. Rows5/7 (seed `0xDEADBEEF`, strength100,
sRGB/Rec.2020) leak `0.03953493736` / `0.03953490768` against the unchanged
`0.03` limit. The other six cases and all remaining edge-width/finite/alpha
gates pass. Every output hash and136x136x16 byte count, all178 pins and39 source
copies are verified unchanged; the worker exited and owned lock was released.
Summary: `artifacts/detail-research/strong-noise/c12-chroma-wide-screen-zmxaqv83/run-edge-regression-nn9o_0u7/summary.md`.
No later flat/texture stage or GPU execution ran. This single-worker research
duration under game contention is not a production performance measurement.
Wider chroma support alone does not resolve the required strong-noise edge
behavior. Retain this rejection and diagnose the retained feature/output error
before declaring another candidate.

## Strong-noise C13 arithmetic and rejected screen — 2026-10-30

The [C13 matching-context policy](../../assets/tests/references/detail/strong-noise/chroma-matching-context.md)
changes only chroma's matching patch from 3x3 to 5x5. Chroma retains C12's
radius 10 uniform search and 3x3 estimated targets. Luminance retains the original
radius 3 Gaussian search, 3x3 matching and pad1 prefix arithmetic. Source halo
therefore grows to 13, while proposal bounds remain L3/C10. This is unenabled
research; public NR v1 and existing history remain unchanged.

Root and an independent reviewer inspected the CPU, separate Decimal80 oracle
and numerical witnesses before generation. Approval:
`artifacts/detail-research/strong-noise/c13-root-math-approval-nf6z1n94/approval.json`.
The explicit `strong-noise-chroma-context` target passes **875 checks, zero
failures/skips/interruptions, in 179.78 seconds**. Summary:
`artifacts/verification/2026-10-30T15-45-08.741Z-check-hXdh0Y/summary.md`.
Its four service cases take 128.09 seconds, including 103.85 seconds for core and
the five counterfeits. The routine duration warning remains; assertions and
limits were not removed. This CPU reference duration under game contention is
not a production benchmark.

The four groups cover 132 core, 84 alpha, 12 asymmetric and 180 C=0 configurations:
**2,052 pre-final and 2,052 final RGB components, 58,158 exact stage words** and
87,750 old research-C9 C=0 stage words. Whole-grid luminance identity checks
cover 11,808 Float64 proposal words and 89,190 published Float32 words; 6,660 and
59,940 of those respectively have nonzero chroma. Root independently checks
these coverage counts against every declared scene size/control combination.
Counts overlap and must not be added as distinct assertions.

The 29x7 context witness changes a pixel 13 positions from its owner: beyond the
radius 10 proposal range and old matching support, inside the new halo. Wrong
chroma/luminance matching, old chroma search, Gaussian chroma weights and an
insufficient halo all fail actual stage/RGB comparisons. The old strict numeric
bounds, transparency, asymmetric controls and C=0 identity remain intact.

An independent selection audit confirms the exact same 44 C12 records, complete
estimator objects, old metrics and required gates. All 88 raw inputs and 44
retained outputs have unchanged hashes and 136x136 RGBA32 byte counts; both
C12 rejection/diagnosis hashes match. Receipt:
`artifacts/detail-research/strong-noise/c13-independent-selection-0WsAFQ/receipt.json`,
SHA-256 `f667437b1516fd6d8202bd4ab2f263a120ec8c20476d4d6ca23efa152cc1622e`.
The new declared order starts with the two known failures, then requires all
six other edges, 24 flats and 12 textures. All 44 remain mandatory for a complete
screen pass. These arithmetic and input-audit passes do not establish quality.

The new driver binds the complete 875-pass verification receipt, all four
normal proof/reference/approval groups, all five numerical counterfeit outputs
and sources, root source approval, independent input audit and both rejection
files. Earlier-stage receipts require complete ordered rows, passed Boolean
gates, unchanged source/estimate identities, output hashes/sizes/alpha/finite
words and clean retirement. Failure/cancellation records partial results and
cleanup after the token-checked lock exits.

Root and an independent reviewer approve the driver, SHA-256
`ec20e1660c58037d93a4afce75571d79763c6676a841e988759ba04deb52671a`,
then independently verify all **196 pins and 58 archived copies** in declaration
`artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/freeze-g0ztad7n/declaration.json`,
SHA-256 `9c6266be05f86f406cc089efaf1d86142f4ee33bb4148b6f16db4ba646b5a52d`.
Only the complete two-case `hard-edge-regression` stage is authorized at nice15
on one CPU worker. Output:
`artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/run-hard-edge-regression-k_cwlgz3/`.
The stage completed **2/2 in 182.882 seconds**, with zero required failures.
Leakage is `0.029942189484229685` / `0.029942153910216943`, narrowly below the
unchanged `0.03` limit. These are the two primaries of the same examined noise
realization, not independent fresh observations. All edge-width, finite, alpha
and exact source-alpha gates pass. Root and an independent reviewer rehash all
pins/copies, complete outputs and cleanup; independent retained-output metric
replay matches the entire metrics objects exactly in 0.23 seconds without
filtering. Summary SHA-256:
`4decac0cbff4e789c592b5552b80ce2faaa721463dd9b4de240dbecafd0c836e`.
The first worker exited and its owned lock retired. The timings describe this
Python study under game contention, not production performance.

Only the next complete six-case `edge-regression-anchors` stage is now
authorized at nice15 using that exact passing prior receipt. Output:
`artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/run-edge-regression-anchors-4zdu9350/`.
The anchor stage completed **6/6 in 563.382 seconds**, with **four required
leakage failures**, rejecting C13. Rows 0/2 fail at `0.04301227877421054` /
`0.04301232302766968`; rows 1/3 fail at `0.03396463721585097` /
`0.03396466820083502`. Rows 4/6 pass at about `0.0199109`. All other edge gates
pass. Summary SHA-256:
`fd86f2e27d62de98c99f51291545c7544d00cc4848a5af5e53334c6b83ae0361`.
Root and independent terminal audits verify all 196 pins, 58 copies, all eight
edge outputs and exact source/estimator associations. Independent retained-output
metric replay matches exactly; the worker exited and the shared lock is absent.
The first two narrow passes do not override these failures. No later flat/texture
stage or GPU execution ran. Only 8 of 44 examined cases completed; the rejected
candidate does not qualify for later stages or public adoption.

A cheap retained-output comparison checks both C12/C13 rows 0 and 5 without
filtering. At row 0's failing right boundary, entering A error is about
`+0.0170562`; recovered target error is `+0.00808571` for C12 and `+0.01696674`
for C13. Inverse coupling adds only `+0.00023817` to the latter. Publication
uncertainty is around `1e-7`, far below this difference. The opposite boundary
improves; row 5's narrow final pass is inverse-assisted. Output Y agrees within
about `2.13e-8`, and inputs/estimates/pins remain unchanged. Receipt:
`artifacts/detail-research/strong-noise/c13-retained-context-diagnosis-d1cevr9s/diagnosis.json`,
SHA-256 `0675315c8c25aa323fee5d65e0c35800264e35b4c166e06dfd2a17ca864e2059`.
This supports a localized chroma estimation trade, not an inverse-only remedy.
Actual normalized neighbor weights are not retained, so the causal contribution
of sample restriction and noise-conditioned selection still needs a diagnostic.

The synthetic edge recipe adds Gaussian noise directly in encoded L/A/B before
inverse conversion to RGB32. Real-camera RGB-noise heteroscedasticity alone
cannot explain these synthetic regressions. Analytic clean-step geometry shows
that matching radius 2 with target radius 1 removes a horizontally diverse,
zero-clean-distance center family from both first edge columns; radius 1/1
retains it. This is a source-support fact, not a noisy weight-mass measurement.
A boundary-only weight diagnostic now evaluates the existing operators directly,
without a candidate import, full filter call or alternate RGB output. Root and
independent source review approve its signed decomposition and explicit
prefix/direct, two-publication and retained-RGB rounding envelopes under the
stated explanatory binary64/libm assumptions. Review catches and fixes a
provenance guard: the actual Python hash must not overwrite a frozen expectation.
Final diagnostic source SHA:
`c27608fa79ce675efeeae96a3ab1853d89debaf6f923a5d70bdfb372ea2599db`.

The diagnostic passes **1,024 method-owner evaluations / 2,048 A/B components**
in about 16 seconds on one nice15 CPU worker. All 322 pins rehash unchanged.
Largest retained-target reconstruction error is `6.4891e-8`, maximum declared
bound ratio `0.299959`; largest decomposition error is `5.55e-17`. Root and an
independent reviewer check every stored bound and class partition, summary
statistics, exact scope and clean lock retirement. Report:
`artifacts/detail-research/strong-noise/c13-boundary-effective-weights-draft-20261030/run-1024-owners-v1/diagnosis.json`,
SHA `5a053128643fd85bc760ee727aa9d9673526f4d90fc036966c38864f6728c48d`.

At row 0's right boundary, the measured mass changes are:

| Operator | Same column, including self | Other same-side columns | Across edge | Effective sample count |
| -------- | --------------------------- | ----------------------- | ----------- | ---------------------- |
| C12      | 66.13%                      | 32.00%                  | 1.87%       | 29.01                  |
| C13      | 98.23%                      | 0.86%                   | 0.90%       | 14.11                  |

C13 reduces clean cross-edge transport from about `-0.00750` to `-0.00361`,
but weighted entering noise increases from `+0.01558` to `+0.02058`. This
explains the failing positive target error without blaming increased clean
cross-edge mixing. Conversely, C12 row 5's right error is mostly clean transport
(`-0.01528` of `-0.01584` total); C13 reduces that transport but retains more
column noise. Effective sample count describes weight concentration, not
calibrated independent samples. These are two examined sources, not fresh
validation; transcendental bounds are explanatory, not formal certificates.

The next [C14 declaration](../../assets/tests/references/detail/strong-noise/chroma-full-patch.md)
therefore tests complete 5x5 chroma target estimation/gathering while retaining
C13 matching, coefficients, estimator, inverse and original L3 arithmetic. It
restores only one of five flat-side center families, so improvement is unproven.
The active semantic stage is L9+C50=59 words, source halo 14, proposal bounds
still L3/C10. All 44 original records and every gate remain required. Root and
independent policy/evidence review preceded the arithmetic pass and rejected
quality screen recorded below. No GPU, photographic, compatibility, resource,
performance or application acceptance follows.

## Strong-noise C14 arithmetic and rejected screen — 2026-10-30

The [complete-patch policy](../../assets/tests/references/detail/strong-noise/chroma-full-patch.md)
changes only chroma target estimation/gathering from 3x3 to 5x5, retaining C13's
matching, search, coefficients and frozen estimator. L keeps its original pad1
prefix arithmetic and 3x3 targets. The active stage is L9+C50=59 Float32 words;
C=0 preserves physical legacy27 or the neutral no-stage bypass. Source halo is
14, proposal bounds remain L3/C10. Public NR v1 remains unchanged.

Root and independent source review pass before numerical generation. The
explicit `strong-noise-chroma-full` target passes **875 checks, zero failures,
skips or interruptions, in 410.57 seconds**. Summary:
`artifacts/verification/2026-10-30T16-56-39.996Z-check-yH2Yor/summary.md`.
All four service cases pass in 357.46 seconds, including 307.00 seconds for core
and six negative comparisons. The routine duration warning remains; no assertion
or quality bound was removed. A bounded 64-entry direct-patch reference cache
avoids thrashing the new 33/35-center vectors and is cleared per primary. These
reference timings under game contention are not production benchmarks.

Groups cover 144 core, 84 alpha, 12 asymmetric and 180 C=0 configurations:
**2,088 strict pre-final and 2,088 final RGB components**, **226,678 exact semantic
stage words**, plus 87,750 old C9 raw stage words. Whole-grid L identity covers
15,156 Float64 proposals and 114,300 published words, including 9,450 and 85,050
respectively with active chroma. Root verifies those coverage counts against
every declared scene size/control combination. Counts overlap. The old target
extent and insufficient halo13 each fail 30 actual RGB comparisons in the fixed
halo14 context scene; matching/search/spatial/L counterfeits also fail numerical
checks. All original signed/HDR, alpha, clamp and strict tolerance policies stay.

The independent input audit confirms the same 44 complete C12 records, including
full estimators, old metrics/gates, all 88 inputs and 44 retained outputs. All
three retained streams and six rejection/diagnosis bindings match. Receipt:
`artifacts/detail-research/strong-noise/c14-independent-selection-urVLkr/receipt.json`,
SHA `9c719a2d53d1adbc0550e4976926ab0f6c828a6bfe7b2a96044fa34ecb4c8a39`.
The new driver preserves complete predecessor/output/cleanup checks and binds
the exact successful verification receipt, four reference/approval groups and
six numerical counterfeits. Root and independent review approve driver SHA
`9aa3e1fb46e797676c76274d0e233ab438b9f11f792147ed9f88b7ae10623c46`.

The candidate-free declaration is
`artifacts/detail-research/strong-noise/c14-full-patch-screen-draft-kzUT9uyq/freeze-7qi1e42r/declaration.json`,
SHA `28ed367db91614ab5052687859db095c3ace95759f11a1efda0dc7fab80edc24`.
Root and independent review rehash all **202 pins and 64 archived copies**.
The complete two-case `context-edge-regression` stage (rows 0/2) ran at nice15 on
one CPU worker. Output:
`artifacts/detail-research/strong-noise/c14-full-patch-screen-draft-kzUT9uyq/run-context-edge-regression-h8gqmt_m/`.
Both cases completed in **264.406 seconds** and failed the unchanged
`edgeLeakage <= 0.03` gate: row 0 is `0.031373091629910886`; row 2 is
`0.03137312234449121`. **C14 is rejected.** Both output files, all 202 pins and
64 archived copies verified unchanged; cleanup records the owned lock released,
zero child processes and no execution error. The later 6/24/12 stages and a C14
GPU port stop here. All 44 examined cases remain mandatory for a full screen
pass. The 875-check numerical pass establishes arithmetic only; public NR v1
and all prior rejection evidence remain unchanged. No photographic, resource,
performance or application adoption is established.

A source-only [GPU forecast](../../artifacts/detail-research/strong-noise/c14-gpu-resource-forecast-20261030.md)
derives 284-square input/features, 260-square centers and a 59-word stage for a
256-square output tile: 20,631,872 buffer bytes / 22,971,072 under the current
working convention, excluding caller frames and runtime overheads. This is not
implemented or measured. Existing halo13/source-edge282 admission cannot accept
halo14/edge284 unchanged; a reviewed geometry/resource path is needed. No shader,
production default, GPU workload, performance threshold or capability claim
changes on this forecast.

## Strong-noise C15 source and publication seams — 2026-10-31

The [prospective pilot-guided pointwise policy](../../assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md)
and `comparison15.json` select one new CPU research experiment. A fixed C14
pre-inverse feature estimate guides similarities; final chroma values come from
the original features. Original L feature proposals and the exact legacy C0 route
remain unchanged. Pilot59, guide3 and final11 publications are separate. C14
remains rejected as an output operator; no new application method is enabled.

The CPU implementation, independent Decimal80/host-Float64 verifier and five-group
service harness are now in the working tree. Root and independent source reviews,
AST/symbol checks, strict metadata checks, type checking and focused lint pass.
The exact-word graph uses only independently computed pilot words and requires
already-published Float32 diagnostics; it does not reinterpret arbitrary Float64
diagnostics by merely packing them. Python, the math extension and identifiable
loaded Linux libm files are fingerprinted during numerical runs. This establishes
a host-runtime contract, not a portable correctly-rounded transcendental theorem.
Separate Decimal80 strict RGB and original-value bound checks remain required.

Artifact-free plans confirm **156 core, 84 alpha, 12 asymmetric, 180 identity and
15 publication cases**, with 13 transitive source bindings. The new 49x9 context
scene declares owner (12,4), marker (36,4), source halo 24 and original-value
chroma radius 10. The complete arithmetic run below now verifies its declared
numerical counterfeit checks.
The maximum composed sharpening halo is 33; old application admission does not
automatically support it.

At the initial restricted-compute checkpoint, only the scalar publication case ran. It
passes **one service test in 0.85 seconds overall** (266 ms test body):
[report](../../artifacts/verification/playwright-1793434261210-17a4669b-030d-4209-98ab-8097df5c004c/playwright/summary.json).
It checks 15 guide additions, 15 canonical delta publications, 15 normalization
seams and six independent coefficient words. The reviewed external freeze grants
only the publication group; a negative CLI check rejects core generation with
exit 2 and no output. The explicit `strong-noise-chroma-pilot` target is
registered as service/exclusive, and its selection preview passes.

The user subsequently authorized CPU research while playing, with GPU and desktop
work still held. The complete `strong-noise-chroma-pilot` selection now passes:
**876 checks, zero failures/skips/interruptions, 849.71 seconds** in background,
service-exclusive mode. Read the
[summary](../../artifacts/verification/2026-10-31T08-49-21.018Z-check-FBppKa/summary.md).
All five actual cases ran: 156 core, 84 alpha, 12 asymmetric, 180 identity and
15 publication configurations, with all declared numerical counterfeits. The
routine-duration warning remains; this is arithmetic validation, not application
performance or a portable libm guarantee. The earlier publication-only approval
still grants no image computation; the complete run uses its separate reviewed
five-group source/plan approval.

C15's first retained-quality stage passes, but a required alternate-seed edge
fails in the following stage as recorded below: **C15 is rejected for adoption**.
Photography, GPU, resource, compatibility and performance adoption remain open.
All 44 retained quality inputs and
gates remain mandatory. Exact L/C0 identity refers to **C9 research**, not the
shipped public NR v1 with compiled bandwidth maxima `.048/.16`. Existing public
v1 pixels, settings and every historical snapshot must retain that operator.
The future versioned dispatch/migration, cache, export/batch and capability
changes remain design-only; no v2 application path is integrated. Public NR v1
and all older rejection evidence stay intact.

The independent [C15 selection audit](../../artifacts/detail-research/strong-noise/c15-independent-selection-8lz5v5ro/receipt.json),
SHA `3086d21610092856caceece57f918a798e3ecd0a73d554a49497723a53e04e2a`,
confirms all 44 exact records, full estimators, old metrics/gates, 88 inputs,
44 comparator files, three streams and 14 evidence pins unchanged. It uses byte
hashes and JSON metadata without decoding Float32 images or importing a candidate.
Legacy JavaScript digest formatting is preserved alongside explicit Python
canonical digests; an initial metadata-format mismatch is retained separately.

The initial source-reviewed `scripts/research/strong-noise/pilot-screen.py` requires
complete five-group numerical proof and eight actual numeric counterfeits before
freezing a quality run. It binds the canonical computation model, archived metric
model, runtime, complete source graph and exact predecessor-receipt lineage.
Its lightweight plan confirms 2/6/24/12 cases; a publication-only freeze request
correctly returns incomplete exit 2 before output/lock/candidate creation.
Full quality execution and real cancellation behavior remain untested. The first
complete freeze exposed a separate destination failure, recorded below.

The separate `strong-noise-pilot-screen` service target passes **five isolated
metadata tests in 1.54 seconds**, with no failures/skips:
[report](../../artifacts/verification/playwright-1793436317880-c8bd0246-e47a-4348-9f46-24252a23f175/playwright/summary.json).
They exercise actual guard/save functions with a private fake lock runtime:
normal token retirement, failure before/after owner publication, preservation
of a foreign fixture, and an injected interruption during owner replacement
after temporary identity capture. Project-processing imports and child launches
are blocked. The real verification lock, GPU and filter are untouched. Earlier
unknown identity/I/O failures remain conservatively incomplete; these tests do
not establish universal filesystem cleanup or full filter cancellation.

The [source-only GPU forecast](../../artifacts/detail-research/strong-noise/c15-gpu-resource-forecast-20261031.md),
SHA `d15fbd8171253b9f26d8108c55364c4678c23c0fe886a6bc463bd94d5e23d542`,
derives packed illustrative buffers totaling 25,936,320 bytes at NR edge 256 and
29,402,688 at edge 274 before maximum sharpening. Original user-L also needs
center support through N+2 or verified reuse; padding, workspaces, caller frames,
transfers and precision changes remain separate. These are algebraic forecasts,
not measured peaks, selected GPU layouts or permission to expand old admission.

The first complete candidate-free freeze reused its output `directory` variable
for a retained-input directory, writing the C15 declaration and source copies
into `comparison9/run-jtxn_2oh`. That freeze is rejected and no candidate
filtering started. Root preserved the misdirected declaration and 81 new files,
then restored the original C9 declaration exactly from a verified archived copy.
The [recovery verification](../../artifacts/detail-research/strong-noise/c15-freeze-recovery-et2u8g1x/recovery-verification.json)
records original declaration SHA
`fda6afcce721ebbfbbe4c9a5718b94d6a5f3337a43566a13c570b08de4e909b0`,
unchanged original archive SHA
`8e45c5a9ddc151cea40c4d9697e50cd3e2a08c11a25b29c64501ea482c217195`,
221 rechecked freeze pins, 158 selection-evidence items and 192 original C9
files. The extra source directory is absent; the new misdirected files and bad
declaration remain quarantined in the same incident directory. Recovery does
not establish a successful freeze or quality result.

The independently reviewed fresh-destination driver fix is now published at SHA
`d27c0f57b23a842d016eabbfd6030f9da347c7cf6f9b985881f387a8ff3386fc`.
It captures an immutable new directory identity, separates read-only source
directories, guards all archive/metadata paths and checks the returned declaration
location. One actual archive-assembly regression passes **1/1 in 0.812 seconds**:
[report](../../artifacts/verification/playwright-1793438308691-525247d0-d0d6-4a5a-bf65-ff1b664fd966/playwright/summary.json).
The full registered `strong-noise-pilot-screen` target now passes **877 checks
in 47.80 seconds**, including all six isolated guard/assembly cases, with zero
failures/skips/interruptions:
[report](../../artifacts/verification/2026-10-31T09-18-36.205Z-check-lBMG5B/summary.md).
The corrected candidate-free freeze contains all 44 records, 221 pins and 81
source copies in a fresh directory:
[declaration](../../artifacts/detail-research/strong-noise/comparison15-retained/freeze-k7yqo6oi/declaration.json),
SHA `9709b26a1f0132278a66de13235d27b6620dd9f5eff119fdfbfbfe935aa3843b`.
Its own invocation lock retired. Independent read/hash review passes all
pins/copies, full records/stage order and mathematical bindings/proofs, with the
original C9 declaration/archive unchanged. The first two retained edge cases
pass **2/2 in 328.111 seconds**, with zero required failures, in
`artifacts/detail-research/strong-noise/comparison15-retained/run-context-edge-regression-egtqw4ge/`.
Leakage is `0.021970112987365398` / `0.021970128139770333` in sRGB / Rec.2020,
below the unchanged `0.03` limit. In the following six-row stage, row 4 (alternate
seed, sRGB, strength 75) fails with leakage `0.04573674205118607 > 0.03`.
Row 5 at strength 100 passes with `0.01970787692101685`. **C15 is rejected.**
The selected six-row stage completed **6/6 in 951.620 seconds**, exit 1, in
`artifacts/detail-research/strong-noise/comparison15-retained/run-edge-regression-anchors-eiirs64x/`.
Row 6 reproduces the failure in Rec.2020 (`0.04573668328419722`); row 7 at
strength 100 passes (`0.01970781306363343`). All eight examined edges therefore
contain six passes and two failures. Inputs/copies/outputs verify and the owned
lock retired with no children. Its complete summary SHA is
`cb7b6ea77199dad33cb8a7639c9c3930522a27db850e30cefdbbe001c5889ae8`.
The later 24 flat-stress and 12 texture cases are blocked by the required failure;
they remain mandatory for any future complete pass, not presumed passes here.

A [retained-output diagnosis](../../artifacts/detail-research/strong-noise/c15-retained-row4-diagnosis-e1x8sm17/corrected-comparator-labels/diagnosis.md)
places the extra right-boundary bias before final inverse/publication. Actual
guide-derived weights are still needed to distinguish clean cross-side transport
from weighted original-noise bias; neither mechanism is established alone. The
metric measures boundary mean feature error, not cross-side weight mass. No
parameter change follows from that partial diagnosis alone.

The subsequent bounded [actual-stage replay](../../artifacts/detail-research/strong-noise/c15-boundary-ledger/freeze-cvewf6vh/summary.json),
SHA `1c7fc7235ab444026c2a5061cdf8ae68dfb1c31fbb7ac3b793345ba2fc287749`,
completes both sRGB strengths 75/100 with exact retained RGB32 bytes and identical
observed guide bytes. Matching-loop replay reproduces every tested owner E word.
Opposite-side weight mass is only `7.9215e-30` / `3.6709e-12`; clean transport
is negligible, while weighted original A noise is `-0.01831195369793477` /
`-0.007946561705252826`. The decomposition closes below `6.84e-16`.
For these observed boundary samples, the failure is same-side weighted noise,
not substantial clean cross-side transport. This is descriptive evidence from
one source, not a general independence/unbiasedness theorem. All pins/copies
verify; cleanup retires the owned lock with no child process or error. C15 stays
rejected and later quality stages remain blocked.
GPU/desktop work stays held while the user plays; CPU research is authorized
separately.

## Remaining native Goal 1 acceptance audit — 2026-10-30

The initial audit and failed attempts below are retained chronologically. The
later [idle-desktop acceptance](#idle-desktop-native-and-full-size-acceptance--2026-10-30)
closes the functional RAW picker, opened dropdown and full-size HDR checks.
Measured-neutral color accuracy and remaining sustained configurations stay open.

The existing `professional-editor-native` receipt proves general keyboard,
1100x700 Console layout, independent/pinned scrolling and pending-save behavior.
Its Temperature/Tint checks do not operate the neutral picker on a real RAW, and
its closed Aspect ratio Home/Down/Home check does not prove an opened popup's
lifetime. Those two requirements remain open. The focused real-RAW native picker
case initially used committed privacy-reviewed `DSC03280.ARW`; after bounded
fixture-suitability checks it now uses the reviewed ISO400 carpet/blank-paper
`DSC03483.ARW`, with unchanged original bytes, isolated shared launcher and strict
native focus guards. Neither fog nor blank paper is a measured neutral target.
Physical neutral accuracy under two measured illuminants remains a separate
criterion in the picker brief.

The registered foreground `professional-picker-native` selection stopped before
picker sampling: **871 passed, 1 failed, 0 skipped, 64.70 seconds** in
`artifacts/verification/2026-10-30T13-28-04.519Z-check-zbxEe0/summary.md`.
Its native window and web contents lost focus after ordinary isolated import;
the renderer still reported focus. The cause of this first failure is unproved.
One unchanged exact-case retry also stopped after import (**0 passed, 1 failed,
5.69 seconds**), recorded in
`artifacts/verification/playwright-1793367023170-5eddfb75-9d38-4b46-8efd-db184342ceb2/playwright/summary.json`.
Its input evidence includes unsolicited trusted `d` key events and a `w` release
interleaved with the test's Enter activations.

The test then adopted the existing native suite's setup order at startup and
restart: verify the isolated profile, settle 1100x700 native/renderer bounds,
establish focus once, and require one second of stable geometry and native focus
before Console/import interaction. The exact-case retry stopped in that stricter
precondition (**0 passed, 1 failed, 2.50 seconds**) before any test input or import:
`artifacts/verification/playwright-1793367273915-2efc5975-e965-4f0d-ab59-55c22775151a/playwright/summary.json`.
It nevertheless recorded unsolicited trusted `a` events and `s`/`a` releases.
Both retries therefore show external desktop input; they do not establish an
application focus defect. All three runs closed their isolated processes and
removed temporary profiles. No valid proposal, Apply/history/restart or native
pointer acceptance is claimed. No focus guard or picker validity threshold was
relaxed. Cleanup now
retains evidence even when an early precondition fails, while successful runs
still require trusted input in both application sessions.

The user's subsequent idle-desktop window permitted three further exact cases;
each finished with **0 passed, 1 failed, 0 skipped** before native picker UI work.
All recorded native focus guards passed, input evidence contained only expected
Enter events, the read-only proposals retained exact source-area agreement and
unchanged history, and windows/processes closed with temporary profiles removed:

- Original eight-position `DSC03280.ARW` preflight: **5.64 seconds**, all eight
  `uneven-sample`; minimum log scatter 0.049602 versus the unchanged 0.04 limit.
  `artifacts/verification/playwright-1793368093806-f4ccce27-2f59-4dda-ae8e-9d6343e99294/playwright/summary.json`.
- Prospectively frozen row-major 12x8 integer-percentage grid, diameter 31,
  stopping at the first valid proposal, on the same fog original: **6.97 seconds**,
  95 `uneven-sample` and one `dark`; minimum scatter 0.047389.
  `artifacts/verification/playwright-1793368296633-5a6e4ab3-057c-4f7a-b677-25a62a09540b/playwright/summary.json`.
- The identical 96-position policy on reviewed `DSC03483.ARW`, selected for
  functional fixture suitability: **7.08 seconds**, all 96 `uneven-sample`;
  minimum scatter 0.065338. The test records SHA-256
  `7e6e048962eacf890ef8bfb04fcadb5ac42e578bc5b67aa7912f08281975569f`.
  `artifacts/verification/playwright-1793368363618-a6155748-17e0-4d9b-b960-f71c4302bfa5/playwright/summary.json`.

These failed functional preflights preserve the original invalid proposals;
they select no photographic-quality winner and establish neither a valid patch
nor a processing defect. Native numeric/pointer sampling, valid proposal Apply,
Undo/Redo and restart remain incomplete. The desktop was handed back afterward;
further foreground checks need a coordinated idle window.

Static source inspection finds consistent authenticated 64-row RGBA strip
indexing and pre-creative, unfiltered, uncropped source sampling in linear
Rec.2020. The stored camera matrix is composed into that same working space
before inversion. Uniformity is a per-pixel 90th-percentile maximum log-ratio
deviation, so a larger region does not average away pixel chroma noise. All these
invalid proposals stop before Kelvin/Tint fitting, with null residuals. Noise or
scene variation remains plausible; preparation/CFA errors are not excluded by
inspection alone. An existing retained ISO400 preparation has exactly the
picker's source SHA-256
`2e31c59ed18d3415e309fb68df61299e8b56f8f03690762569fddbef857d9aa9` in
`artifacts/professional-editing/patchwise-integration-prep-20261030/carpet-source-preparation-v2/declaration-j9LFiu/run-5rxsYf/report.json`.

A subsequent authorized bounded CPU diagnosis verifies that exact retained
Float32 source and all strip hashes, then independently replays the same 96
proposals. Direct-row and strip-row bytes, geometry and all rejected/inlier
counts agree; maximum scatter discrepancy is 4.44e-16. Independent pivoted
Gauss-Jordan inversion gives identity error 2.22e-16, and camera-matrix working-space
composition agrees within 5.55e-17. Three paper regions selected from the retained
full-scene privacy PNG have scatter 0.08541, 0.10387 and 0.11470. Removing a fitted
linear spatial trend for diagnosis leaves 0.08678, 0.10251 and 0.11275; parity-mean
offsets are small beside within-region variation. This does not indicate a
simple stride, matrix, gradient or Bayer-parity-offset explanation. Raw RGBA,
recovered camera RGB, coefficients and hashes are retained in
`artifacts/professional-editing/picker-uniformity-20261030/run-s8a4kguj/report.json`
(1.61 seconds). A diagnostic-script NameError and its partial observations are
preserved separately; they are not an application failure.

The already decoded, authenticated LibRaw 0.22.1 linear 16-bit camera-RGB privacy
frame independently shows scatter 0.07128, 0.09655 and 0.10477 in the same three
normalized paper regions:
`artifacts/professional-editing/picker-uniformity-20261030/cpu-companion-0ta542ux/report.json`
(0.10 seconds). Its 5496x3672 native geometry differs from the application's
5422x3622 lens-corrected source, so these are scene-region observations rather
than registered pixel pairs. They support RAW/demosaiced chroma variation as the
reason the per-pixel uniformity policy refuses these samples; they do not prove
sensor-noise origin, exclude every preparation defect or validate neutral color.
Neither diagnosis performs a new RAW decode, GPU work, an 8-bit camera-JPEG
validity check or a changed acceptance gate. A suitable valid patch and the
remaining native workflow are still required.

At the initial audit, the reviewed-input wide/120-Hz creative HDR cadence receipt
remained valid, while compact/Console 60/120-Hz and wide 60-Hz selected
configurations still needed their own evidence. The later continuation below
closes those three configurations; a broader all-control/native-maximized
matrix is not implied.
At this earlier checkpoint, full-native 1.25x SDR export did not prove full-size
HDR enlargement; the later dedicated HDR receipt is recorded below.

Before fresh execution, update the historical Sony input in
`professional-editor-native` and `professional-enlargement-fullsize` to a reviewed
committed original, retaining its exact source hash and any necessary source
geometry assertions. Historical receipts remain preserved and scoped; the fixture
policy is not waived to obtain a new pass. This source migration and the new
functional picker input were completed before the following runs. Comprehensive
application acceptance still requires a separately agreed checkpoint.

## Idle-desktop native and full-size acceptance — 2026-10-30

The user explicitly made the desktop and GPU available again. Three separate
registered selections passed on Bazzite, with isolated profiles, unchanged
acceptance limits and their ordinary static/fast checks. Counts overlap:

| Target                              | Mode       | Result                                    | Evidence                                                                                 |
| ----------------------------------- | ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `professional-dropdown-native`      | foreground | 874 passed, zero failures/skips; 66.35 s  | [summary](../../artifacts/verification/2026-10-30T17-49-37.769Z-check-plMJxa/summary.md) |
| `professional-enlargement-fullsize` | background | 873 passed, zero failures/skips; 119.55 s | [summary](../../artifacts/verification/2026-10-30T17-54-34.524Z-check-REYTHL/summary.md) |
| `professional-picker-native`        | foreground | 872 passed, zero failures/skips; 53.45 s  | [summary](../../artifacts/verification/2026-10-30T17-56-47.992Z-check-Pgdcs1/summary.md) |

All three dropdown cases keep the actual Aspect ratio popup open across three
refresh periods, then exercise option selection, Escape and outside click.
Refresh resumes afterward; strict native focus and minimum-size guards remain.
The first run completed all interaction bodies but timed out during teardown:
the test left a crop draft active, correctly preventing application quit.
Test cleanup now cancels that draft through the guarded native UI. An initial
compositor resize race is handled only before native input, requiring both real
native and renderer 1100x700 geometry to remain stable for one second. The exact
mouse-choice rerun passed before the complete three-case selection. Failed
artifacts remain preserved. Production Wayland refresh behavior is unchanged;
these cases do not demonstrate a production dropdown defect or physical-device
and cross-monitor coverage.

The full-size cases use the committed, hash-verified `DSC03280.ARW` original.
They exercise the complete 5496x3672 source and 6870x4590 Lanczos3 output:
31,533,300 pixels at 1.25x. SDR retains its 2 GiB managed-RAM setting and the
fixed-cap refusal of an oversized 2x request. HDR uses native GPU rendering and
native encoding under explicit 3 GiB RAM / 2 GiB VRAM settings. It independently
checks every output RGB component at both declared headrooms, totaling
189,199,800 component comparisons below the unchanged exclusive 0.02 error
bound. Frozen settings, later edits, original hashes and restart remain checked.
The fixed 33,554,432-pixel and codec limits are unchanged. These are functional
and reconstruction checks, not a throughput, contention or physical HDR result.
The resource settings govern managed admission; they do not measure whole-app
physical memory peaks.

The picker now uses the [functional ISO125 RAW](../../assets/tests/images/raw/sony-zv-1a/white-balance-functional/README.md)
`capt_DSC07247.ARW`, SHA-256
`8a2e09a6798e303ea2a991139dbc50245aedc218bffe11d614f307b93d7b1cfb`.
Both embedded images, all 2,139 exposed metadata fields, the complete native
overview and all six full-resolution scene tiles passed privacy review before
commit and use. Exact original bytes and provenance are published in commit
`3067fd8796408b5bd970e884a2c798ac32b6037e` on
`codex/white-balance-functional-fixture-20261030`. The earlier printed-paper
capture remains excluded. Camera sessions are closed and settings restored.

The unchanged 31-pixel, 96-position row-major preflight finds a valid patch with
the original scatter/validity limits. Native keyboard and pointer coordinates,
clipped endpoints, 7/15/31-pixel sample controls, 100% pan, Fit, Escape without
history, one combined Kelvin/Tint edit, Undo/Redo, complete restart and As Shot
pass at 1100x700 with Console open. Originals remain unchanged. The photograph
and lighting are unmeasured: functional acceptance does not close the separate
two-illuminant neutral-accuracy criterion. Electron-delivered trusted input also
does not certify a physical pointer device. Strong-noise quality, remaining
sustained configurations and all Goal 2 integration remain open. No comprehensive
checkpoint was run; the two routine-duration warnings remain recorded.

The source audit also separates spatial preparation from point-control cadence.
Existing whole-source agreement and full-RAW resource/cancellation targets cover
production NR v1, while the responsiveness suite's 18 controls do not include
commit-only NR/sharpening or cold crop preparation. Those tools require a separate
reviewed-source cohort: cold commit to matching full-detail presentation,
superseded-work retirement, then warmed editing under actual import/export
advancement. Retain existing warm latency gates; declare cold/cancellation limits
before measuring them. Crop admits the full floating-point input, unlike NR's
bounded strip reader, so combined accounting needs its own observation. None of
these existing v1 scopes accepts a rejected strong-noise candidate.

## Remaining creative cadence configurations — 2026-10-30

The three previously missing reviewed-input configurations now pass on Microstep
HDR, DPR 1, target generation 3. The compact/Console selection passed **873
checks in 519.25 seconds**, including both cases and shared checks:
[summary](../../artifacts/verification/2026-10-30T17-59-20.083Z-benchmark-OsNvAS/summary.md).
The wide/60-Hz exact retry passed **one case in 286.71 seconds**:
[report](../../artifacts/verification/playwright-1793384037435-5bc21994-dff5-4803-b04b-0ef4a2a1fc4f/playwright/summary.json).
Each configuration contains eight representative HSL/grading controls at Fit and
100%, with three repeats: **144 passing trials and 34,560 requested inputs**.
The earlier wide/120-Hz receipt is preserved without a duplicate run.

| Configuration            | Requested input achieved, Hz | Completed visible updates/s | Worst P95/P99 latency, ms | Inputs without individual visible output |
| ------------------------ | ---------------------------- | --------------------------- | ------------------------- | ---------------------------------------- |
| 1100x700 Console, 60 Hz  | 59.958–60.062                | 59.761–60.026               | 8.1 / 21.2                | 1                                        |
| 1100x700 Console, 120 Hz | 118.888–119.998              | 117.311–119.830             | 15.3 / 26.0               | 31                                       |
| 1440x900, 60 Hz retry    | 60.058–60.062                | 59.770–60.028               | 17.1 / 22.2               | 0                                        |

The original wide/60-Hz invocation is retained as a failure: **871 passed,
one failed, 266.90 seconds** in
[its summary](../../artifacts/verification/2026-10-30T18-08-30.158Z-benchmark-jOYhkK/summary.md).
It completed 35/48 trials, then lost native window/web-contents focus before the
next timed trial; the source, frame and confirmed monitor remained ready.
One native blur is recorded, with its cause unproved. The unchanged exact-case
retry used the existing build and all original guards. Neither partial trials
nor the renderer's separate focus flag turn that failed configuration into a pass.

The [bounded post-run audit](../../artifacts/professional-editing/cadence-audit-20261030/run-3-attempts-v1/receipt.json),
SHA `a0c93309ec414fb17936f3a3cfac1d9ef8b916f7abe9be41aff4aad34d2ff732`,
replays input/request/presentation serial sets. Its exit 2 deliberately retains
the failed attempt and its incomplete matrix, alongside the three passing
configurations. Across passing trials, 32 inputs lack individual visible output;
288 unobserved request serials are separate attribution gaps. Native rAF ranges
141.983–144.206 Hz and does not substitute for completed presentation cadence.
Worst maximum latency, presentation gap and refinement are 39.3, 41.9 and
56.0 ms respectively; the existing latency, cadence, identity, focus, history,
histogram and managed-resource gates pass. These are completed GPU presentation
observations, not measured physical scanout or luminance.

All four attempts' recorded policy windows closed, profiles were removed and
50/50 recorded source/build/package-lock pins match bytes observed at audit
time. This equality does not certify continuous immutability during a run.
The root's separate check of all 13 launches in this native/GPU batch found no
remaining owned app/profile or policy violation. Auxiliary audit process/task
retirement is explicitly unavailable rather than inferred from those pin checks.
The selected eight-control configurations are now covered; broader 18-control,
native-maximized and cold spatial preparation/contention acceptance are not
implied. No acceptance limit changed or comprehensive checkpoint ran.

## Reviewed inputs and sustained-input scope — 2026-10-29

The updated fixture policy excludes identifiable people, private interiors and
sensitive metadata from new repository inputs. Historical receipts above remain
evidence of their exact source/code conditions; those photographs are not reused
as new acceptance inputs. The reviewed replacement
[Sony fog/animal-fur original](../../assets/tests/images/raw/sony-zv-1a/fog-dogs/README.md)
is published in commit `7dd6541b52bd8f871ad4de8701fe105f101389d3` on
`codex/privacy-reviewed-fixtures-20261029`. Only its original and two notices were
committed; every pending working-tree path and the uncommitted tracked diff were
verified unchanged. Source-card bytes remain intact. ISO 400 does not replace
high-ISO acceptance; a [three-frame capture brief](../sony-high-iso-test-captures.md)
records verified ZV-1A instructions for the remaining photographic input.

The [reviewed-input sustained check](../../artifacts/verification/2026-10-29T11-03-37.254Z-benchmark-CyErHN/summary.md)
passed one selected 1440 × 900 case: eight creative controls × Fit/100% × three
repeats, **48 trials, 187.03 seconds, no failed/skipped cases**. Untimed preflight
now requires stable native focus and agreement among the actual monitor, target,
completed photo/source/revision/serial and analysis before recording input.
During-trial assertions and timing limits are unchanged. Prior cadence-incomplete
and native-display-change failures remain preserved.

This pass used the LG SDR display at about 75 Hz: requested input was
119.751–119.998 Hz, while completed visible updates were 73.198–74.717/s.
Of 11,520 requested input states, 4,334 lacked individual visible output.
Maximum P95/P99 latency was 20.20/28.50 ms; final refinement stayed within 54.80 ms.
All focus/target/source/history/histogram checks passed; app/profile cleanup and
50 unchanged hashes are recorded in the
[receipt](../../artifacts/professional-editing/editor-safe-cadence-20261029/README.md).
This SDR result establishes neither HDR nor 120 fps output. At that checkpoint,
other reviewed-input layouts and actual HDR-monitor cadence remained open.

The later [required-HDR retry](../../artifacts/verification/2026-10-29T11-53-33.338Z-benchmark-8jYFyr/summary.md)
passed all **48 trials in 191.27 seconds** on Microstep HDR, DPR 1, generation 3.
Input cadence was 118.882–120.004 Hz, native rAF 142.993–144.206 Hz and completed
visible updates 118.053–119.812/s. There were 26 requested input states without an
individual visible update. Maximum P95/P99 latency was 20.70/30.40 ms, maximum
latency 43.90 ms, presentation gap 34.20 ms and final refinement 65.30 ms; all
original gates passed. Native/renderer focus stayed stable, all 51 recorded hashes
were unchanged and the app/profile were cleaned up. The earlier focus-loss run is
retained as a failure; the user confirmed an idle desktop for this retry.
The [receipt](../../artifacts/professional-editing/editor-safe-hdr-cadence-retry-20261029T115333Z/README.md)
retains every sample, diagnostic serial gap and resource observation. Other
reviewed-input configurations and physical scanout/luminance remain unverified;
no comprehensive checkpoint was run.

## Reviewed RAW/raster/merge rerun — 2026-10-29

All three replacement Sony fixture sets are published on
`codex/privacy-reviewed-fixtures-20261029`, now at
`108e69c3eee1ff94d9a1168a1475b426062060f3`: the ISO 400
[fog/dogs original](../../assets/tests/images/raw/sony-zv-1a/fog-dogs/README.md),
a [genuine three-frame exposure bracket](../../assets/tests/images/raw/sony-zv-1a/forest-bracket/README.md),
and the requested [ISO 400/6400/12800 carpet captures](../../assets/tests/images/raw/sony-zv-1a/carpet-high-iso/README.md).
Every original and embedded preview passed visual and metadata privacy review.
Original bytes and hashes are preserved; the notices grant repository/test use,
not a general open-content license. Only these selected photographs, notices and
the capture brief were committed. Unfinished application changes remain local.

The [focused replacement-input acceptance](../../artifacts/verification/2026-10-29T12-07-25.420Z-check-2b7KF1/summary.md)
passed `professional-editing-acceptance`: **787 passed, no failures or skips,
98.77 seconds**, including its shared static/fast checks. The two real-source
cases exercise the reviewed RAW, licensed raster, synthetic ISO gain-map and
genuine v4 merge master through combined edits, selective transfer, frozen
enlarged HDR/SDR export and restart. Existing assertions and thresholds remain.
Every test window was hidden; isolated profiles and processes were cleaned up.
This rerun does not exercise cancellation or a new denoising operator.

The carpet set is now a reproducible high-noise input. Its lower-ISO frame is
an approximately exposure-matched companion, with different recorded white
balance and unverified focus/registration; it is not clean ground truth.
The [native photographic protocol](../../artifacts/professional-editing/carpet-denoise-photo-plan-v2-20261030/README.md)
fixes paper, boundary, yarn and fine-fiber regions before candidate outputs.
On October 30, all three complete neutral working sources were prepared through
native RAW decoding and GPU processing, with automatic lens correction:
**5422 × 3622**, 57 verified strips each. The first declaration had used the
5496 × 3672 privacy-decode grid; its guard stopped the first run. That result is
preserved, and the separate corrected declaration retains every region coordinate
and extent unchanged. The repeated ISO 400 source matches the stopped run
byte-for-byte. The [preparation receipt](../../artifacts/professional-editing/patchwise-integration-prep-20261030/carpet-source-preparation-v2/declaration-j9LFiu/run-5rxsYf/summary.md)
records all source/code/runtime hashes and worker cleanup. This establishes
reproducible inputs, without denoising or photographic quality acceptance.
Stronger-noise numerical research, independent references and photographic
acceptance remain open. The replacement-input functional pass continues to use
the unchanged v1 detail operator and does not close those gates.

## Inspector implementation evidence

Focused color integration receipts (Linux, hidden UI, no foreground benchmarks):

| Invocation                                                                                    | Selection                                                                                                                  | Result                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [10:56 t14zAj](../../artifacts/verification/2026-10-25T10-56-19.670Z-check-t14zAj/summary.md) | `adjustment-renderer-ui`, `color-intensity-gpu`, `hdr-presentation-cache`, `hdr-first-surface`, static/fast checks         | 688 passed, 0 failed/skipped; 76.86 s. Routine duration warning retained.                                              |
| [11:05 277Mfx](../../artifacts/verification/2026-10-25T11-05-02.865Z-check-277Mfx/summary.md) | `native-cpu-controller`, `native-hdr-mask-controller`, `native-hdr-mask-capability`, `color-intensity`, static/fast checks | 720 passed, 0 failed/skipped; 41.98 s. Real native signed/HDR color pairs and mask bytes match the CPU oracle exactly. |
| [11:11 xyryhf](../../artifacts/verification/2026-10-25T11-11-29.862Z-check-xyryhf/summary.md) | `color-export`, `catalog-migration`, `export-context`, `edit-history`, static/fast checks                                  | 726 passed, 0 failed/skipped; 42.07 s.                                                                                 |

These counts overlap and must not be added. The earlier
[10:49 UI run](../../artifacts/verification/2026-10-25T10-49-46.836Z-check-Ts852K/summary.md)
passed all eight adjustment-wiring cases, mixed color/light history/restart and
stdio MCP, but failed two raster texture-reuse assertions. Their actual extra
source upload was fixed and verified by the later 10:56 run. Other retained failed
evidence includes the initial GPU cancellation error, an export test's incorrect
single-attempt assumption, a native request-hash slice needing its explicit endpoint,
and a sandbox-blocked native invocation. None is reclassified as a pass; focused
reruns document the fixes. Real Sony color preview/native-device-loss acceptance,
native desktop checks, photographic appearance and timing comparisons remain pending.

The neutral picker passed
[11:37 5xPHdj](../../artifacts/verification/2026-10-25T11-37-27.417Z-check-5xPHdj/summary.md):
698 checks, 0 failed/skipped, 72.13 s, selecting the picker model, geometry and
service targets, editor MCP and inspector UI. The later
[11:54 o8DemI](../../artifacts/verification/2026-10-25T11-54-27.638Z-check-o8DemI/summary.md)
passed 698 checks, 0 failed/skipped, 74.39 s, selecting `white-balance-picker-ui`,
`white-balance-picker-service` and `editor-mcp` plus static/fast checks. Both routine
duration warnings remain recorded. The UI suite is an explicitly synthetic child-frame
component fixture in the shared hidden isolated Electron launcher; it is not a real
RAW preview or photographic acceptance claim. It checks one combined apply, typed
coordinates, Enter/blur/invalid entry, late replies, photo/revision changes, Escape,
read failures and loss of focus. The service suite uses real files and the real
isolated image worker, verifies authenticated strips across a seam, no creative-edit
contamination or repeated source preparation, read-only sampling, conflict/cancellation,
one shared history entry, Undo/Redo/restart and unchanged originals. The
[picker decision](white-balance-picker.md#initial-estimator-decision) records fixed
signal/coverage/scatter/residual limits and the remaining prepared-source clipping
and physical-camera limitations. The user reconfirmed that they are playing, so
RAW-heavy, native desktop and GPU benchmark gates stay deferred.

Tone-curve research passed
[12:17 ZpRnQ8](../../artifacts/verification/2026-10-25T12-17-33.832Z-check-ZpRnQ8/summary.md):
694 checks, 0 failed/skipped, 33.24 s, selecting `tone-curves`, `color-intensity` and
`white-balance-picker` plus static/fast checks. The later
[13:50 09Eyg1](../../artifacts/verification/2026-10-25T13-50-38.842Z-check-09Eyg1/summary.md)
passed 695 checks, 0 failed/skipped, 33.04 s, selecting `tone-curves` and
`tone-curves-gpu` plus static/fast checks. The small native GPU kernel checks
independent Decimal80 scalar and composed Master/RGB references in sRGB and Rec.2020,
including dense steep intervals, signed inputs, above-white values, identity and
unchanged alpha. High/low parameters occupy 3,200 bytes per curve set; they are not
yet integrated into production renderers or accounted production owners. See the
[curve decision](tone-curve-processing.md). No curve UI/history/MCP, photographic
acceptance or performance readiness is claimed. Dense CPU monotonic/envelope tests
retain all 6,708 segment samples and 12,294 whole-curve samples with aggregate extrema
assertions, avoiding thousands of separate assertion calls without relaxing limits.

The user then requested a [Lightroom-inspired scope review](lightroom-comparison.md)
and accepted its two-goal split. Goal 1 brings crop and selective copy/paste forward
while retaining grading, denoise/detail and standard enlargement. Advanced curve
integration, named presets, final-size proof/output sharpening and the optional FSR
decision move to Goal 2. The full milestone stays active across both goals; research
and focused passes above are not reclassified as full acceptance.

The inspector now has a reserved histogram area, consistent keyboard disclosures,
mounted bodies, compact spacing, and workspace-persisted section choices. Histogram
analysis attributes stay on their existing element, and the analysis status retains
its reserved geometry during updates. Older workspace checkpoints receive defaults
without modifying photo history. The crash-recovery regression now waits for a
checkpoint containing the requested active photo and selection before forcing exit;
scroll-position persistence alone was insufficient setup for that assertion.

The focused background invocation at
[2026-10-25T09-18-28.331Z-check-XPGK1M](../../artifacts/verification/2026-10-25T09-18-28.331Z-check-XPGK1M/summary.md)
passed **697 checks, 0 failed/skipped, in 122.34 s**, including static checks/build,
the fast Node checks, workspace recovery service/UI, the inspector suite, adjustment
wiring, and lens UI. Native 1100 × 700 renderer geometry with the Console open,
section state across photo changes/restart/crash, pending edits on collapse, and
invalid/legacy workspace records pass. The run exceeded the 60-second routine budget;
its slowest case was the existing full workspace restart at 25.40 s. No assertions
were removed or cut short. Later color candidate tests have separate evidence.

The final math-only `color-model` invocation at
[2026-10-25T09-41-49.387Z-check-fAyLIl](../../artifacts/verification/2026-10-25T09-41-49.387Z-check-fAyLIl/summary.md)
passed **682 checks, 0 failed/skipped, in 27.45 s**, including static checks and five
color/reference cases. It verifies the conversion substrate and research candidate's
declared mathematics after separating the candidate from application code; it does
not accept that candidate's known luminance behavior or enable color controls.

Native dropdown reproduction (#10), manual visual acceptance, broader HDR histogram
regressions, and presentation/performance evidence remain pending. Backlog #26–28
stays open until its remaining acceptance is complete; this background result does
not establish another platform or physical display behavior.

## Goal 1 crop foundation — 2026-10-25

**Early snapshot through 14:40 UTC; the later filtered-worker progress follows below.**

[Geometry](../../src/shared/crop.ts) now defines bounded normalized native framing,
aspect locks, exact quarter turns, strict corner containment, explicit uniform Fit,
output dimensions and inverse source sampling. The independent original
[Decimal80 oracle](../../scripts/research/crop-reference.py) uses Taylor trig,
binary-search corner containment and repeated rotations rather than application
coefficients: 216 cases, 1,512 coordinate vectors, all quarter turns/angle limits,
non-square/max-edge dimensions, fractional centers and aspect locks. Frozen scalar
limits are 2e-9 native pixels and 2e-14 normalized fitting extents.

The [preview mapping](../../src/renderer/src/preview/geometry.ts) accepts an optional
compiled crop. Its 108 Fit/native/zoom/pan scenarios retain the original 7/15/31-pixel
picker region; no displayed pixels or cropped pseudo-sensor samples are used.
The actual preview caller does not supply crop until feature integration is complete.

[Integer strip processing](../../src/main/processing/crop.ts) preserves every Float32
bit in 72 source/crop/rotation/strip-layout cases, including signed/HDR channels,
negative zero, alpha and 64-row seams. Ordinary integer crops copy a whole row where
possible; turns use bounded, strided bit copies without color conversion.
[Working-asset preparation](../../src/main/processing/crop-working.ts) reuses identity
without extra I/O/allocation, authenticates nonidentity input strips and the complete
source, uses a caller-owned admitted destination, writes matching output strip/global
hashes, retains source/WB provenance, and removes only its exclusively created partial
file on failure or cancellation. Fractional geometry is explicitly rejected by this
exact-copy path. Production allocation admission and worker dispatch are not wired yet.

Focused evidence (overlapping counts, not additive):

- [14:26 9ZkYIF](../../artifacts/verification/2026-10-25T14-26-18.994Z-check-9ZkYIF/summary.md):
  `crop-geometry` plus static/fast checks; 698 passed, 0 failed/skipped, 28.81 s.
- [14:32 NjRv1f](../../artifacts/verification/2026-10-25T14-32-57.352Z-check-NjRv1f/summary.md):
  `crop-geometry`, `crop-preview-geometry`, `crop-pixels`, `white-balance-picker-geometry`
  plus static/fast checks; 702 passed, 0 failed/skipped, 27.80 s.
- [14:40 ePVGcc](../../artifacts/verification/2026-10-25T14-40-49.944Z-check-ePVGcc/summary.md):
  `crop-working`, `crop-pixels`, `crop-preview-geometry` plus static/fast checks;
  705 passed, 0 failed/skipped, 32.62 s. File-based service checks verify output hashes,
  provenance/original preservation, cancellation, damaged strip/global hashes,
  pre-existing output protection, identity reuse and explicit unsupported filtering.

These are scalar and synthetic Node/service checks. Crop settings remain absent from
application edit/MCP patches; no enabled control, migration, live crop preview/export,
full worker-dispatch, native visual, photographic/filter or performance acceptance is
claimed. Next finish spatial-filter decisions and bounded processing, then integrate
preview/history/export before exposing the tool. Keep foreground/RAW-heavy work deferred
while the user is playing.

## Goal 1 filtered crop worker — 2026-10-25

The [filter decision](crop-filter-processing.md) records quality limits before the
comparison, its results, linear-light/alpha semantics and remaining photographic
acceptance. Shared Catmull-Rom evaluation preserves the old lens arithmetic. The
independent Decimal80 corpus now contains 648 positions over eight Float32 scenes,
including analytic linear/quadratic reproduction, signed/HDR values, partial/zero
coverage and faint opaque constants. CPU tile partitions retain identical Float32
bytes. Native GPU reference tests retain the existing channel tolerance, including
large coordinate descriptors using small windows; they do not allocate or certify
an enormous full-resolution photograph.

The [bounded preparator](../../src/main/processing/crop-preparation.ts) now has a real
[preview-worker request](../../src/main/preview-worker.ts). It authenticates prepared
pixels, freezes the job, preserves source/profile data, checks shared RAM/VRAM admission,
streams 64-row output bands, hashes new assets, and retains exact-copy/identity fast paths.
[GPU ownership](../../src/main/gpu/crop.ts) reuses 4,275,824 managed buffer bytes, awaits
in-flight work on close, and uses canonical CPU recovery near the coverage cutoff.
Automatic initialization/admission/device errors have CPU paths; service device-loss
coverage is simulated, not a physical GPU-reset result. A separate small native Dawn
case verifies actual GPU-produced working assets against CPU with signed/HDR/alpha data.

Focused receipts (counts overlap):

- [15:03 pbmr4Y](../../artifacts/verification/2026-10-25T15-03-58.009Z-check-pbmr4Y/summary.md):
  `crop-filter`, `lens-correction` plus static/fast; 706 passed, 0 failed/skipped, 28.89 s.
- [15:14 IcTb02](../../artifacts/verification/2026-10-25T15-14-46.900Z-check-IcTb02/summary.md):
  `crop-filter-gpu`, `tone-curves-gpu` plus static/fast; 708 passed, 0 failed/skipped,
  31.78 s. Shared compensated-arithmetic extraction preserves the curve math; this
  does not pull curve integration forward from Goal 2.
- [15:45 7fnD4n](../../artifacts/verification/2026-10-25T15-45-10.994Z-check-7fnD4n/summary.md):
  `crop-preparation`, `crop-resources`, `crop-working`, `white-balance-picker-service`,
  `crop-filter-gpu`, `crop-preparation-gpu` plus static/fast; 723 passed,
  0 failed/skipped, 35.91 s. Real Node dispatch, native GPU output, retirement before
  simulated recovery, refused admission, cancellation, source/partial-file protection,
  malformed data and authenticated output pass.
- [15:58 IC2LLu](../../artifacts/verification/2026-10-25T15-58-04.640Z-check-IC2LLu/summary.md):
  strengthened production-kernel chart verification; `crop-filter` plus static/fast,
  709 passed, 0 failed/skipped, 28.01 s.
- [16:06 FC23qA](../../artifacts/verification/2026-10-25T16-06-48.956Z-check-FC23qA/summary.md):
  expanded quadratic/648-position references and diagonal/impulse/checker reporting;
  `crop-filter`, `crop-filter-gpu` plus static/fast, 711 passed, 0 failed/skipped,
  32.26 s.

Retained failed invocations include the GPU test's overly broad typed-array input type
(15:06 vi4qrL), a narrowed literal result tag/unused test import (15:35 c1HKE4), and a
test fixture trying to mutate immutable resource snapshots (15:40 2sJWVU). Fault fixtures
now clone snapshots; production immutability and numeric/quality thresholds were kept.
Those runs remain failures; the scoped reruns above verify their fixes.

Crop edit patches/UI are still disabled. Main history/schema migration, uncropped versus
cropped cache leases, raster/SDR-primary adapters, preview/analysis and frozen export
integration remain the next work. The [crop integration checkpoint](crop-straighten.md#remaining-integration-checkpoint)
orders it. No real RAW/photo/native-window/performance or whole-feature acceptance is
claimed; the user is still playing and those gates remain deferred.

## Goal 1 crop adapters and export — 2026-10-25

The file preparator and authored raster now use one
[bounded band engine](../../src/main/processing/crop-bands.ts), including native GPU
buffers, equivalent CPU recovery, cancellation and early-iterator disposal. The
[frame adapter](../../src/main/processing/crop-frame.ts) preserves its borrowed
linear pixels and display transform; it does not label sRGB as camera Rec.2020.
It streams 64-row output bands without a second full source plane. Retained preview
output has its own explicit incremental admission. Identity retains the same frame
and buffer; quarter turns/integer crops preserve all Float32 bits.

[Export rendering](../../src/main/export/renditions.ts) consumes frozen internal crop
settings before final sizing, Light/color/output mapping and alpha flattening. Its
prepared HDR and preserved authored SDR-primary paths receive equivalent geometry.
Geometry/admission are cloned at the isolated exporter entry and again at rendering;
the source-preparation request explicitly clears crop and retains the uncropped
identity. Source/master files stay unchanged. Export diagnostics include geometry and
filter versions, memory plans, tile counts and backend/recovery evidence.

Synthetic checks cover oriented PNGs, signed/HDR/alpha frames, matching frame/file
bytes, timer cancellation, iterator retirement, simulated GPU loss, denied admission,
identity output, cropped sizing, paired authored-rendition semantics and frozen
worker edits across later mutation. The isolated worker uses an already prepared
source with a decoder path that must never launch. Independent Sharp JPEG reading
checks the resulting crop dimensions and uniform HDR-source SDR values within the
existing 0.03 encoded tolerance. The paired test is a synthetic authored pair,
not an actual ISO gain-map decoder round trip.

The integration tests caught a real geometry metadata defect: object spreading a
rich working frame retained pixel buffers/provenance in a nominal size field. Size
projection is now explicit, and mathematical zero coefficients are canonical across
JSON/IPC. A regression verifies that geometry never carries the input payload.
No Float32 pixel signs or frozen numerical/quality bounds changed.

Evidence:

- [16:47 SJ9nur](../../artifacts/verification/2026-10-25T16-47-09.746Z-check-SJ9nur/summary.md):
  `crop-frame`, `crop-export`, `crop-preparation`, `crop-working`, `crop-frame-gpu`,
  `crop-preparation-gpu`, `adjustment-engine`, `export-context`, `full-previews`,
  plus static/fast checks: **776 passed, 0 failed/skipped, 37.64 s**. The service
  stage took 6.02 s and the two small native GPU cases took 1.09 s. These durations
  are functional suite timings, not image-pipeline performance measurements.
- Failed [16:39 rG3chi](../../artifacts/verification/2026-10-25T16-39-03.662Z-check-rG3chi/summary.md)
  retains an unused test import caught by static checks; no tests ran.
- Failed [16:41 7rPYgb](../../artifacts/verification/2026-10-25T16-41-00.324Z-check-7rPYgb/summary.md)
  retains 720 passes and three geometry metadata/transport failures. Exact failed
  cases passed after the size projection/zero fix and rebuild; the final selection
  above confirms all affected groups. The failed evidence remains preserved.

No crop edit patch or UI is enabled. Next connect authoritative uncropped source
leases and cropped preview variants, source-space picking/analysis, then transactional
history and revision-checked crop context. Connect committed crop/admission and
geometry/filter versions to accepted export manifests before enabling UI/MCP together.
The preview worker explicitly rejects a crop that has no prepared variant, rather
than silently ignoring it. Real RAW/raster/gain-map/merge round trips, native controls
and performance acceptance remain open while the user is playing. No comprehensive
checkpoint or full-image GPU workload ran.

## Goal 1 crop preview integration — 2026-10-25

[FullPreviews](../../src/main/full-previews.ts) now creates geometry variants in its
existing cache, queue and lease model. The uncropped source keeps its established
identity; [variant identity](../../src/main/working-assets.ts) adds compiled native
sampling geometry and geometry/filter versions. Authoring-only aspect changes reuse
pixels. Raster source decoding, grading, translation, identity reset and restart
are covered with actual small oriented PNGs. Prepared HDR sources are synthetic;
these tests do not establish real RAW decode/reuse acceptance.

The [crop preview worker](../../src/main/processing/crop-preview.ts) creates matching
working/display data without changing primaries or decoding the source again.
Prepared GPU and CPU crop data agree within the frozen channel bound. The native
GPU worker case uses a nonexistent RAW path and an independently leased 97×131 F32
source; it verifies prepared-source use, not a RAW decoder or presentation benchmark.
Cancellation/removal waits for worker retirement before releasing the protected
source and unpublished directory. Refused crop admission retains the completed base
for a later retry. Production resource-owner admission still needs to be installed.

CPU recovery leases validate the current crop identity. HDR statistics/pixels use
cropped data, while white-balance proposals explicitly lease the uncropped source.
Renderer click/ROI projection uses inverse geometry with native sample sizes.
`getCropContext` and `irodori_get_crop_context` share authoritative native dimensions,
geometry and revision checks before/after preparation. Real service/stdio MCP checks
ignore deliberately wrong catalog dimensions, preserve history/originals and reject
stale revisions. The UI bridge exports only the specific ID/revision operation.

The [working-preview hook](../../src/renderer/src/hooks/useWorkingPreview.ts) keeps
the same working data for downstream color changes, hides old data for a changed
sampling map even at equal output dimensions, and ignores late preparations.
Isolated React/Electron component tests verify requests, fetches and returned pixels;
they do not measure GPU upload counts or native crop-tool usability. The raster
worker additionally retains a matching decoded original/hash in RAM: its first color
change succeeds even with an unavailable prepared-file path. A cached crop cannot
replace the original or different prepared bytes of the same dimensions.

Evidence:

- [17:29 WiVWxf](../../artifacts/verification/2026-10-25T17-29-30.945Z-check-WiVWxf/summary.md):
  `crop-preview-cache`, `crop-context`, `crop-frame`, `full-previews`,
  `white-balance-picker-service` plus static/fast; **746 passed**, 0 failed/skipped,
  34.40 s. This includes uncropped picking against a cropped active preview.
- [17:41 mTAM06](../../artifacts/verification/2026-10-25T17-41-37.979Z-check-mTAM06/summary.md):
  cache/context, hidden renderer components and the small native GPU worker path;
  **720 passed**, 0 failed/skipped, 37.42 s.
- [17:49 JmSPd5](../../artifacts/verification/2026-10-25T17-49-25.174Z-check-JmSPd5/summary.md):
  final RAM/source-identity fix; `crop-preview-cache`, `full-previews`,
  `adjustment-engine`, `crop-working-preview-ui`, `crop-context`,
  `crop-preparation-gpu` plus static/fast; **745 passed**, 0 failed/skipped,
  38.40 s. Service/Electron/native-GPU stages took 2.34/3.09/1.22 s. These are test
  durations, not hardware processing or presentation measurements.
- [Isolated bridge case](../../artifacts/verification/playwright-1792949794283-0fca8394-fa1b-4f90-819c-b1c22b146da8/playwright/summary.json):
  the existing desktop startup/preload-isolation case passed once in background
  mode, 0.96 s, with the current typed API inventory. This does not close the full
  workspace/native capture target.
- Failed [17:26 aJxLBn](../../artifacts/verification/2026-10-25T17-26-00.722Z-check-aJxLBn/summary.md)
  retains a redundant initializer and a ref read during React rendering, caught by
  lint before tests. Both were corrected; the failing lint stage passed before the
  scoped reruns above. No verification bounds or assertions were removed.

Next connect current production renderer ownership to preview/export admission,
then migrate current/all historical settings and implement the transient crop editor
with one revision-checked Apply. Keep nonidentity edit patches disabled until UI/MCP,
history, preview and frozen export manifests are complete. Real-source/gain-map/merge
round trips, native controls/ROI appearance and the saved performance gates remain
open while the user is playing. The full milestone and later Goal 1/2 work stay active.

## Goal 1 crop ownership, persistence and accepted export policy — 2026-10-25

Production crop preview/export admission now combines current resource policy with
a nonce-checked renderer query. The bridge returns only managed RAM/VRAM counts;
it exposes no filesystem paths or arbitrary IPC. Sources, presentation/bitmap caches,
in-flight fetch/hash transfers and presenter owners are counted conservatively.
Retiring owners retain their charge until their existing fence/receiver drain settles.
Failed constructors do not publish phantom owners. Unknown native GPU capacity stays
conservative; these bounds are not process RSS or measured physical VRAM.

Settings 9/catalog 19 add exact identity framing to current and all historical
settings from supported catalogs 17/18 in the startup transaction. Settings 8 retain
their nonneutral color values; settings 7 additionally acquire zero color defaults.
Preflight validates current, undo and redo geometry before any migration/recovery
write. Tests preserve original bytes, metadata, revisions, timestamps, cursor and
redo through restart and cover rollback when a later row aborts the transaction.
Existing nonidentity version-9 snapshots survive reopen unchanged. Crop mutations
remain unavailable while the editor and authoritative commit validation are unfinished.

Accepted export manifests now record geometry/filter versions. New render attempts
copy that frozen policy and obtain a fresh resource snapshot, including after a
foreground retry. Unsupported/missing nonidentity policies fail before source decode
or worker launch; older identity-only jobs retain their existing path. The worker
freezes settings, policy and admission before asynchronous preparation. These service
checks include independently decoded small JPEG output and source-byte preservation.

The specific `requestCropPreview` bridge operation prepares and leases an uncropped
native source at an expected revision, using the existing cache and active request.
Both revision checks bracket preparation. It creates no history edit; opening and
leaving framing reuses the same base pixels. Native CPU source references may use
uncropped pixels only while that framing owner remains active, and become invalid
when it is released/replaced. The working hook consumes an already prepared raster
framing source directly, avoiding a request for the committed crop.

Evidence:

- [18:33 kGHL8P](../../artifacts/verification/2026-10-25T18-33-15.942Z-check-kGHL8P/summary.md):
  `image-resource-owners`, `image-resource-query-ui`, `crop-working-preview-ui`,
  `crop-preview-cache`, `export-context` plus static/fast; **748 passed**, 0 failed/skipped,
  44.46 s. Hidden resource-query checks import only a generated 128×96 PNG.
- [18:54 DFyaJL](../../artifacts/verification/2026-10-25T18-54-20.439Z-check-DFyaJL/summary.md):
  `crop-export`, `export-context`, `catalog-migration` plus static/fast;
  **757 passed**, 0 failed/skipped, 36.25 s.
- [18:59 zXBkBv](../../artifacts/verification/2026-10-25T18-59-36.845Z-check-zXBkBv/summary.md):
  `crop-preview-cache`, `crop-context`, `full-previews`, `crop-working-preview-ui`
  plus static/fast; **749 passed**, 0 failed/skipped, 38.96 s.
- Failed [18:46 d3w4iS](../../artifacts/verification/2026-10-25T18-46-46.081Z-check-d3w4iS/summary.md)
  preserves a fixture-only negative-zero expectation mismatch, 766 passes and two
  failures. The exact cases passed after correction and the migration target passed
  in the final export/persistence selection. Earlier type errors in new test fixtures
  remain under [18:46 nec9PY](../../artifacts/verification/2026-10-25T18-46-07.509Z-check-nec9PY/summary.md)
  and [18:51 Ph7gX1](../../artifacts/verification/2026-10-25T18-51-21.965Z-check-Ph7gX1/summary.md);
  each failing typecheck passed before functional reruns. No assertions or tolerances
  were weakened.

These are focused synthetic/service and hidden component checks. No real RAW decode,
full-size GPU workload, foreground test or comprehensive checkpoint ran. Native
framing interaction, real-source/gain-map/merge round trips and source-matched
performance acceptance remain open. Next implement the transient crop controller,
overlay and one revision-checked Apply, then enable the shared UI/MCP crop patch.

## Goal 1 functional crop editor and shared mutations — 2026-10-25

Crop is now enabled in the toolbar/inspector and the existing `updateEdits` API/MCP.
Main copies patches before asynchronous work, validates shape, then prepares the
authoritative native source before validating output size, aspect and containment.
Combined lens/crop edits prepare the proposed correction variant without publishing
settings first. The writer's expected revision remains the final concurrency check.
Invalid geometry does not create a history snapshot.

[Authoring helpers](../../src/shared/crop-authoring.ts) constrain translation without
shrinking, and resize around the opposite corner while stopping at source edges.
Angle/size/aspect commands explicitly fit the shown draft. Literal quarter-turn,
edge and ratio references plus 4,320 rotated/straightened corner resizes and 1,080
translations cover containment, minimum dimensions and ratio preservation, including
32K geometry without allocating a large image. Authoring uses the same frozen
1e-9-pixel edge representation allowance; rendering tolerances remain unchanged.

The [controller](../../src/renderer/src/hooks/useCrop.ts) flushes earlier edits,
obtains revision-checked context and owns a transient draft. Shared numeric controls,
aspect/quarter turns, keyboard/native-pixel handle movement, pointer capture, capture
loss, focus loss, external edits and late context replies have hidden component checks.
Apply sends one combined edit; opening, changing or cancelling a draft writes none.
Photo-wide Undo/Redo shortcuts pause while framing. An Apply sent to main drains
before Cancel is available, rather than implying that a committed write was cancelled.

The controlled inspector retains disclosure state independently of photo history.
Earlier workspace checkpoints acquire the collapsed Crop disclosure default on read
and save. The toolbar opens that section; collapsing it keeps the tool/subscriptions
mounted. Before/split/picker/other adjustments pause while framing. The preview reuses
the uncropped native source; source switching hides the other geometry immediately
and rejects late replies. Cancel restores the committed crop and previous zoom/pan.
Retained frames carry source-space and geometry-revision tags so crop/lens changes
cannot present a retained surface for older geometry.

Framing currently displays the uncropped source with a quadrilateral/thirds overlay.
The exact resampled/leveled view appears after Apply. This source-oriented interaction
still needs native visual/usability review; the component evidence does not establish
that it is preferable to rotating the photo under a rectangular frame.

The new [public-service workflow](../../tests/crop-edit-service.spec.ts) uses an
actual 100×80 oriented PNG with deliberately incorrect catalog dimensions. Its
committed pixels match independently oriented/extracted Sharp bytes. Histogram size,
frozen JPEG geometry/color, original bytes, Undo/Redo and a redo branch after restart
agree; a warmed prepared source survives that restart without another decode/crop.
Caller mutation, invalid native extents/ratio and concurrent edits are covered.
The actual stdio MCP commits the same bounded crop object through the shared service.
The actual hidden application imports only a generated 100×80 PNG and checks Apply,
transient Reset/Cancel, restored 800% view and unchanged history after cancellation.

Evidence:

- [19:30 XwFO4F](../../artifacts/verification/2026-10-25T19-30-07.481Z-check-XwFO4F/summary.md):
  `crop-editor-ui`, `crop-authoring`, `crop-preview-cache`, `crop-working-preview-ui`,
  `crop-context` plus static/fast; **738 passed**, 0 failed/skipped, 46.87 s.
- [19:37 FgTVWv](../../artifacts/verification/2026-10-25T19-37-36.040Z-check-FgTVWv/summary.md):
  full/working source-switch hooks plus static/fast; **724 passed**, 0 failed/skipped,
  38.64 s. Revision zero, immediate suppression, restored geometry and late replies
  are checked without a photo decode or full-size GPU workload.
- [19:42 N1lHsV](../../artifacts/verification/2026-10-25T19-42-25.978Z-check-N1lHsV/summary.md):
  `crop-context`, `crop-preview-cache`, `full-previews` plus static/fast;
  **750 passed**, 0 failed/skipped, 35.06 s, including proposed-lens source dimensions.
- [20:18 fi4xLx](../../artifacts/verification/2026-10-25T20-18-00.213Z-check-fi4xLx/summary.md):
  `crop-edit-service`, `edit-history`, `crop-application-ui`, `crop-editor-ui`,
  `crop-source-preview-ui`, `crop-working-preview-ui` plus static/fast;
  **741 passed**, 0 failed/skipped, 49.75 s. Service/Electron stages took 1.67/15.35 s.
  The Node stage took 16.93 s, above its 15-second aim; the geometry sweep took 1.93 s.
  No checks were removed or cut short to meet a time budget.
- Failed [19:28 OUXoGU](../../artifacts/verification/2026-10-25T19-28-45.980Z-check-OUXoGU/summary.md)
  and [20:03 D5rmNt](../../artifacts/verification/2026-10-25T20-03-43.989Z-check-D5rmNt/summary.md)
  preserve new-hook lint findings; each failed lint stage passed before functional
  reruns. Failed [20:13 8zaoDL](../../artifacts/verification/2026-10-25T20-13-07.321Z-check-8zaoDL/summary.md)
  retains 725 passes and a missing statistics forwarder in the new test adapter.
  That exact public-service case passed after the adapter fix, followed by the
  complete focused selection above. Its earlier passing stdio MCP/workspace checks
  remain valid; no assertions or thresholds were weakened.

These receipts establish focused functional behavior on Linux. Full-size real RAW,
HDR/gain-map/merge round trips, native minimum-size/Console/input appearance and
source-matched CPU/GPU/presentation performance remain required. No foreground or
comprehensive checkpoint ran while the user was playing. Continue light Goal 1
HSL/three-way grading work; retain all deferred gates and keep the full milestone active.

## Goal 1 color mixer and three-way arithmetic — 2026-10-26

The [operator decision record](color-mixer-grading-processing.md) now defines the eight
reference ranges, protected circular selection, explicit hue/saturation/luminance
semantics, three tonal weights, blending/balance and black/HDR behavior. Independent
Decimal80 vectors cover both working primaries, signed/near-neutral values and
1e-12…16× exposure. The scalar fused implementation retains the old intensity path
exactly when new operators have no influence.

Actual native C++, WebGPU and hidden Electron WebGL arithmetic pass fixed reference
limits. Compensated shader math fixes the initial signed-HDR precision failures;
shared cross-product results prevent gaps at exact hue anchors. Parameter data is
416 bytes, with no new image plane in the point core. The WebGL port shares the same
pure equations and uses a reserved positive-zero uniform word for rounding. A faster
rounding helper reduced the complete small hidden probe from 40.52 to 3.53 seconds;
these include compilation/harness time and do not replace full-image performance gates.

[Final selected verification](../../artifacts/verification/2026-10-26T16-00-47.366Z-check-GZxkJX/summary.md):
`creative-color`, `creative-color-gpu`, `creative-color-native`, `creative-color-webgl`
plus static/fast checks, **728 passed, 0 failed/skipped, 45.22 seconds**. Scalar/native
cover 5,040 independent vectors; each GPU backend covers 2,520 Float32-input vectors,
including selection, neutral and alpha checks. The Node stage took 18.31 seconds,
above its 15-second aim, with no reduced assertions. Failed numeric, boundary and
formatting receipts are preserved and linked from the operator record.

Subsequent CPU adapter work installs the prepared calculation in `adjustHdr`, working
HDR statistics, SDR preview conversion and raster export. Small reference checks cover
the existing clamps, alpha, histogram and equality semantics. A shared 52-component
logical packet feeds native transport preparation and GPU high/low packing. The C ABI
uses fixed integer flags; fourteen malformed packet probes fail before output.

[Combined adapter/regression receipt](../../artifacts/verification/2026-10-26T16-31-52.115Z-check-HME1fd/summary.md):
the five `creative-color*` targets plus `color-export`, `crop-export`,
`catalog-migration` and static/fast checks, **751 passed, 0 failed/skipped, 49.65 seconds**.
The Node stage took 19.65 seconds, above its 15-second aim; no assertions were reduced.

At that arithmetic checkpoint, settings 9/catalog 19 rejected undeclared groups.
The subsequent [application adoption](color-mixer-grading-processing.md#versioned-application-adoption-2026-10-27)
now implements GPU/native frame adapters, rebuilt authenticated helpers, settings
10/catalog 20 migration, partial API/MCP patches and inspector wheel/numeric controls.
Small-raster proof/histogram/source reuse/frozen export and hidden mixed-history
workflows pass; full real-source and native/performance acceptance remains pending. Keep ordinary/neutral GPU shaders unchanged and prepare creative
variants only when needed, avoiding their compilation cost on uncorrected previews.
Photographic, real-source, native/foreground and source-matched performance acceptance
remain open. Tests stayed light and hidden while the user was playing; there was no
full-size GPU/RAW workload, benchmark or comprehensive checkpoint.

## GPU export resize refresh — 2026-11-01

The [resize checkpoint](upscaling.md#gpu-implementation-checkpoint--2026-11-01)
records strict GPU reduction/enlargement, independent references and explicit
policy/version compatibility. The focused resize/export selection passes
918 checks; small cases pass on both available Radeon adapters. The separate
full-size target passes **885 checks, zero failures/skips, 217.78 s**:
`artifacts/verification/2026-11-01T09-05-41.962Z-check-p9Pkvf/summary.md`.
Actual unchanged committed Sony RAW exports to 6870 × 4590 SDR/HDR through real
jobs and restart with the new GPU backend asserted. Complete independent HDR
reconstruction retains 189,199,800 channel comparisons at two headrooms. Fixed
pixel-cap refusal, frozen settings and sequential RAM/VRAM admission remain intact.
Counts overlap shared prerequisites. These checks refresh functional full-size
GPU export correctness; the run spans gaming and idle conditions and establishes
no speedup, sustained responsiveness or strong-noise photographic acceptance.

## Full-RAW sharpening supersession — 2026-11-01

The new explicit `professional-spatial-commit` target runs hidden in the exclusive
RAW/GPU group. Its registered selection passes **884 checks, zero failures/skips,
58.20 s**:
`artifacts/verification/2026-11-01T10-51-26.279Z-check-FXILHX/summary.md`.
After tightening the held-reply guard to reject unrelated errors or empty assets,
the exact case passes again in **14.74 s**, reusing the build:
`artifacts/verification/playwright-1793530446303-b06b9cc4-09e8-4083-bdbe-e70b21a77e07/playwright/summary.json`.

Tracked DSC03280.ARW warms the native linear source under an explicitly SDR
presentation target. The first sharpening variant uses NR 0/0 and detail
50/1/50. A real preparing request is superseded with Amount 0; its cancellation
reply is delivery-held until the neutral source is presented, then released.
It cannot replace the current source or history. Retrying presents the matching
filtered source with **1,276 GPU tiles, zero CPU tiles/precision repair**, on
RX 7900 XTX/RADV NAVI31. Revisions 0–3 contain exactly the initial snapshot and
three requested edits. View state, original/managed RAW bytes and the upstream
Float32 hash remain unchanged.

Three app-owned memory snapshots retain complete process/PSS and DRM discovery
with no reported sampling errors in the registered run. They are observations,
not peak usage, a combined physical-memory total or resource-budget acceptance.
Both windows stayed hidden with no focus/show violations; test processes exited
and temporary profiles were removed.

This is late-reply cancellation/source-ownership correctness, not guaranteed
shader-in-flight cancellation or a cold RAW decode test. Diagnostic timings have
no new speed gate, and retry can reuse a completed variant. Cold NR/crop,
action-specific preparation limits, actual import/export contention, sustained
cadence, photographic quality and other-platform coverage remain open.

## Real crop/sharpen import and export contention — 2026-11-01

The explicit exclusive RAW/GPU target `professional-spatial-contention` now passes
its exact hidden case, **one passed, zero failures/skips, 26.71 s**, reusing the
build:
`artifacts/verification/playwright-1793532018790-95c86a18-ae8a-4191-b21e-88c68d1ba08a/playwright/summary.json`.
Current type checking, affected-file lint, formatting and whitespace checks pass.
The earlier registered selection passed its 883 shared checks but failed this
case; it is not relabeled a complete checkpoint pass.

DSC03280.ARW prepares a previously absent 60% crop at center 0.51/0.49 and 1.25°,
with NR 0/0 and sharpening 50/1/50. Actual output is 3297 × 2203. Fractional crop
uses GPU; detail records 1,276 GPU tiles and zero CPU tiles/precision repair.
Observed cold variant commit-to-matching presentation is 6,448.90 ms, with the
RAW source already warm. This is a diagnostic observation, not a speed gate.

After preparation completes, three distinct tracked/privacy-reviewed forest RAWs
(DSC03277–DSC03279) enter the real import path. Two nonoverlapping observations
inside the warm editing interval show strict byte/copied/prepared advancement;
three files publish successfully while the active photograph is preserved.
An already admitted export then completes validated producer stages during one
uncommitted Exposure gesture, between two actual local draft/frame updates.
The same worker attempt emits all three stages without dropped receipts and
retires before the sole gesture commit. Final publication follows editing.
No continuous-input cadence or continuously simultaneous GPU compute is claimed.

The frozen SDR export is 512 × 342 and uses GPU rendering/resize. Its complete
JPEG bytes match a second reduced output made after restoring identical settings
(SHA-256 `678263ecf711f6442897006e4668ac7d646e40cc863960dbf9add057f9025ec4`).
Revisions 0–5 have exactly six expected snapshots. Original/managed bytes for all
four RAWs, upstream Float32 hash, prepared source identity, view and healthy
canvas/device/upload count remain intact. Three memory snapshots report no
sampling errors; they are not physical peaks. The window remained hidden with
zero show/focus events or violations, then closed; its process/profile retired.

Retained failures explain the final test protocol. The first invocation stopped
at formatting before launch. The next registered run
(`2026-11-01T11-08-40.521Z-check-Tqvxu8`, 883 passed/one failed, 95.55 s) used
repeated Enter commits, each of which intentionally preempted export. No producer
stage completed during that interval; the frozen file completed afterward and
matched its reference. Frequent commits can therefore delay file-level progress.
The first gesture correction was intentionally interrupted after 179.29 s at
`artifacts/verification/playwright-1793531793543-11186a2a-28e7-427b-b033-1bb3cd3e72e1/playwright/summary.json`:
it incorrectly awaited publication while keeping the activity that blocks it open.
The final test waits for worker retirement, commits, then awaits publication.
Only test ordering changed; no production scheduler or acceptance threshold did.

This adds real-source cold-variant and contention correctness. Action-specific
cold limits, warm latency/cadence under these spatial settings, physical memory
peaks, eligible strong-noise quality and remaining photographic coverage stay open.

## #45 integration — November 4, 2026

The individually scoped [tone-curve delivery](tone-curves.md) now integrates the
retained mathematical operator with version 12 history, shared drafts/gesture handoff,
atomic UI/MCP patches, revision-bound 5 × 5 targeting, selective copy and frozen
GPU preview/export. The user selected Saturation/Vibrance before Mixer; migration
retains numeric controls and deliberately adopts the new rendered appearance in
all history snapshots. The old Decimal80 color reference remains unchanged; v2 data
lives under `assets/tests/references/creative-color-v2/`. Numerical limits stay fixed.
Historical Phase 3 entries above describe their original research scope.

The [curve evidence](tone-curves.md#acceptance-criteria-and-evidence) records initial
integration (919 passes, 71.31 s), corrected exact photographic/output reruns, the
foreground fidelity/native/dragging selection (891 passes, 75.76 s), final native
picker/layout checks (887 passes, 64.92 s) and bounded integrated WGSL/output checks
(889 passes, 50.27 s). These four selections have zero failures/skips; original
failed invocations remain preserved and linked separately.

The final service/asset selection has 899 passes and three existing HDR-asset test
failures in 48.70 s; all four curve service cases, including CPU-analysis refusal
and retained identity statistics, pass. The same three failures reproduce against
untouched HEAD: two retired CPU proof stubs lack the required GPU capability, and
one still expects raster rendering v1 instead of v2. The brief links both receipts;
these separate #32 maintenance failures are not reported as a passing selection.

On RX 7900 XTX, achieved inputs are 60.13 Hz, visible updates are 59.61/s at Fit and
60.12/s at 100%, p95 input-to-visible latency is 14.6/14.4 ms and final refinement is
41.6/34.7 ms. All retained warm gates pass with unchanged source identity and one
history entry per drag. First activation is 6,889.9 ms; warm sample acquisition is
13.5 ms. These are separate measurements, not a general responsiveness claim.

Clipping masks and exact HDR statistics with active curves are explicitly unavailable pending qualified GPU
analysis. Electron continued to select the discrete GPU for GLSL compatibility;
integrated GLSL, macOS and physical luminance/input devices remain unverified.
Broader responsiveness, noise quality and calibration stay in their tasks.
