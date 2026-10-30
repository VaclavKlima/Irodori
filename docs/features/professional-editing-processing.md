# Professional editing processing decisions

## Status and boundaries

**In progress, 2026-10-25.** This is the phase 0 decision and evidence record for
[professional editing](professional-editing.md). The inspector foundation and
Saturation/Vibrance have focused functional evidence. Native desktop inspection,
real-photo HDR acceptance and source-matched performance remain pending. The neutral
picker has focused worker/service and isolated component evidence; its real Sony
and physical-neutral acceptance remain pending. Later operator/workflow phases are unfinished.

The settings document is now version **11/catalog 21**. Catalogs 17…20 and
settings 7…10 migrate transactionally with neutral defaults for missing crop,
creative-color and denoise/detail groups while retaining existing authored groups.
Settings 7 additionally receive neutral Saturation/Vibrance defaults. Revisions,
timestamps, redo branches, originals and durable masters remain intact. Existing
Light, white balance, ACES and numerical/performance thresholds are retained.
Denoise/detail now have public controls and focused small-raster application
coverage in the [operator record](detail-processing.md). Explicit standard export
enlargement has focused evidence in the [resize record](upscaling.md). Both retain
real-source, native/photographic and full-size performance acceptance gaps.
Earlier dated checkpoints below retain their status at the time of each run.

## Current source and output domains

| Input                          | Existing working data                                                                                                                                       | New-operator constraint                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified Sony RAW              | Scene-linear Rec.2020/D65, signed Float32, capture scale/reference white 1; source preparation includes documented demosaic, orientation and lens handling. | Preserve scene exposure and above-white values; custom white balance uses the existing camera provider.                                       |
| Durable RAW merge/noise master | Scene-linear Rec.2020/D65 with source provenance and fixed preparation corrections.                                                                         | Do not infer one camera ISO or reapply already baked lens/source corrections.                                                                 |
| Authored JPEG/PNG/TIFF         | Color-managed display-referred sRGB, decoded to linear values for processing.                                                                               | Neutral edits retain authored appearance and do not run ACES. New color operations must not introduce hidden 8-bit intermediate quantization. |
| Supported ISO HDR JPEG         | Authored HDR Rec.2020/D65 rendition with a preserved SDR primary.                                                                                           | Keep the authored-source adapter and existing HDR/SDR policy; do not apply the RAW ACES transform a second time.                              |

The current scene pipeline is source preparation → native-reference denoise/detail
→ committed geometry → custom white balance → Light → mixer → Saturation/Vibrance
→ three-way grading → fixed ACES 2 HDR/direct SDR rendition → presentation or
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
positions of later curves/output-sharpening stages still require their own
comparisons. The [detail record](detail-processing.md) retains the selected
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
| Curves (Goal 2)             | Linear-light PCHIP with rational C1 tails; signed-log coordinates are graph-only. See the [curve decision](tone-curve-processing.md).                                                      | Independent CPU/small-GPU math passes; production owners, history/UI/MCP/export and photographic/performance acceptance remain unfinished.                                                                                                                         |
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
