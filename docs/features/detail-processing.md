# Single-image denoising and detail sharpening

## Status

**Public settings/history/UI/MCP implemented; combined real RAW/HDR application/export, whole-source NR/detail CPU/GPU agreement, native keyboard interaction and full-source resource refusal/cancellation pass focused checks on 2026-10-29. Strong-noise photographic quality and remaining performance acceptance stay open.**
This is Goal 1 slice 4 in [professional editing](professional-editing.md).
The previous color, crop and inspector work is retained. This record retains the
comparisons, frozen quality gates and staged integration evidence. Passing
small synthetic checks alone cannot accept real photographs or performance.
The later [combined and whole-source checkpoints](professional-editing-processing.md#goal-1-combined-real-source-correctness--2026-10-29)
add actual Sony, ISO gain-map and genuine v4 master coverage while retaining those
remaining gates and every original numerical limit.
The published ISO 6400 portrait remains heavily noisy at NR 50 and 100. The user
requires stronger noise removal within Goal 1 before acceptance. The retained
v1 operator and its passing numerical references must remain reproducible;
noise-aware alternatives require a separately frozen comparison before adoption.
Earlier dated checkpoints below retain their status at that point; the latest
public-adoption checkpoint supersedes their public-tool availability statements.

## Candidates and source policy

Compare a bounded bilateral filter with a bounded patch non-local means filter.
[Paris and Durand](https://people.csail.mit.edu/sparis/bf/) describe the bilateral
family and its acceleration; [Buades, Coll and Morel](https://www.ipol.im/pub/art/2011/bcm_nlm/)
describe averaging similar patches. The proposed Irodori versions are original
implementations of the equations below, not copies of those projects' code.
No new library or model is bundled. The non-local means comparison is deliberately
bounded rather than an implementation of the paper's unrestricted search.

[Guided filtering](https://people.csail.mit.edu/kaiming/eccv10/index.html) and
[BM3D](https://webpages.tuni.fi/foi/GCF-BM3D/) provide useful further comparisons.
Scalar luminance guidance must not erase an isoluminant color edge. BM3D software
has its own usage terms; this milestone does not import it. Investigate another
candidate if neither original implementation meets the fixed gates below.

Research source: native decoded/demosaiced, oriented, lens-corrected floating-point
linear sRGB or Rec.2020/D65 in its prepared reference white balance. Raster and
authored gain-map inputs retain their own linear color-managed appearance; merge
masters retain their existing exposure/provenance. No sensor re-decoding, exposure
normalization, ISO inference, tone mapping, clipping or alpha modification occurs.
Single-image filtering is separate from multi-frame noise stacking.

The integration graph selected by placement comparison 1 is prepared source → denoise → detail sharpening →
committed geometry → manual white balance → Light → curves (Goal 2) → mixer →
Saturation/Vibrance → grading → output transform. Filtering before geometric
resampling defines radius on the prepared native grid and retains neighbors outside
a crop. Working in prepared reference white balance can retain a spatial cache across
manual color gestures. The [placement comparison](#placement-decision-for-integration)
retains both orders' measurements and the native-neighborhood evidence behind this
choice. Photographic acceptance remains open. The white-balance picker keeps
sampling the unfiltered source.

## Comparison domain and equations

Let `Y = wr R + wg G + wb B` use the primary-derived linear luminance coefficients,
`U = R - Y`, `V = B - Y`, `k = 0.18`, and `s = hypot(Y, k)`.
The candidate features are `L = asinh(Y / k)`, `A = asinh(U / s)` and
`B = asinh(V / s)`. These signed, fixed-reference coordinates do not normalize an
image by its content and remain defined at zero/negative luminance. This is a Irodori
engineering proposal, not a claim that this domain is perceptually uniform or that
its manual strength is a calibrated sensor noise estimate.

Manual Luminance/Chroma strengths are candidate integer amounts 0…100, initially
zero. Bandwidths are `hL = 0.08 (Luminance/100)^2` and
`hC = 0.16 (Chroma/100)^2`; zero bypasses its component. Luminance matching also
uses opponent guidance bandwidth 0.12; chroma matching uses luminance guidance 0.08.
These constants are candidate semantics, frozen for the first comparison. Do not
retune them after looking at results without retaining the failed candidate and
recording a new comparison version.

Both candidates use the 7×7 search window and spatial Gaussian sigma 2 prepared
pixels. Bilateral matching compares center features; non-local means compares a
3×3 patch. For each displacement, compute mean squared `L` difference and mean
squared opponent-vector difference over corresponding patch samples, weighted by
the product of both samples' alpha. Normalize by that coverage. Match weights are
`exp(-dL/hL²-dC/0.12²)` and `exp(-dL/0.08²-dC/hC²)`, respectively, multiplied by
spatial weight and the candidate center's alpha. Zero-coverage patches contribute
nothing. The original center always supplies a valid positive weight for a visible
pixel. Image extension replicates the actual photograph edge; tile edges never
become image edges. The finite halo is 3 pixels for bilateral and 4 for patch NLM.

Accumulate weighted feature differences from the center. Convert feature changes
back by stable differences: for an entering component `x`, scale `s` and feature
change `d`, `delta = 2 x sinh(d/2)^2 + hypot(x,s) sinh(d)`.
Luminance uses scale `k`; opponents use the entering `hypot(Y,k)`. Reconstruct by
adding `deltaY + deltaU` to R, `deltaY + deltaV` to B and
`deltaY - (wr deltaU + wb deltaV)/wg` to G. Thus Luminance-only filtering preserves
the entering linear opponent differences; Chroma-only filtering preserves linear Y.
Never apply a display gamut clamp. Preserve alpha and fully transparent pixels
exactly, including hidden RGB. Alpha-zero neighbors cannot influence visible output.

## Detail sharpening candidate

Use bounded luminance unsharp filtering after denoising. The
[MIT computational photography chapter](https://people.csail.mit.edu/fredo/comp-photo-book/03-basic-image-processing-and-isp-06-neighborhood-operations-and-convolution.html)
describes the noise amplification and halo problems that motivate protection.
Candidate Amount is 0…100, Radius 0.5…3.0 prepared pixels in 0.1 steps (Gaussian
sigma; support `ceil(3 radius)`), and Threshold 0…100. Defaults are 0, 1.0 and 50.
An amount of zero bypasses, regardless of the remembered radius/threshold.

Compute the alpha-normalized Gaussian mean of feature L, subtract it from the
center, then multiply that difference by Amount/100 and
`difference² / (difference² + t²)`, with `t = 0.08 Threshold/100`.
Threshold zero passes the high-pass difference; exact zero stays zero. Reconstruct
the luminance difference stably, then constrain the proposed linear Y to the valid
neighborhood's minimum/maximum extended by 3% of that neighborhood's linear range.
Add the resulting Y difference equally to RGB. Opponents and alpha remain unchanged;
there is no SDR clip or fabricated texture. This is separate from Goal 2's
export-only output sharpening after final resize.

## Predeclared quality and agreement gates: comparison 1

Use reproducible known clean charts with independently generated noise in the
declared feature coordinates. Record entering and filtered errors against the clean
truth, not only smoother-looking images. Evaluate both candidates with identical
manual strengths and support; keep the unfiltered baseline and every failed result.
Quality evaluation uses Luminance/Chroma 50 where relevant and feature noise sigma
0.012. Those settings describe this test; they do not promise texture preservation
under intentionally excessive smoothing at every possible setting.

| Measurement                                | Fixed gate before candidate evaluation                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Neutral operator                           | Exact input bytes, including alpha and signed zero.                                                                                                                                                                                                                            |
| Flat luminance noise                       | Residual RMS at most 55% of entering RMS; absolute feature mean bias at most 0.003.                                                                                                                                                                                            |
| Flat chroma noise                          | Opponent residual RMS at most 45% of entering RMS; per-opponent mean bias at most 0.003.                                                                                                                                                                                       |
| Fine periodic detail                       | Retain 90…105% of clean projected amplitude for period-2/period-4 patterns with feature amplitude 0.024/0.03.                                                                                                                                                                  |
| Strong luminance / isoluminant chroma edge | Mean leakage within either edge-adjacent pixel at most 3% of the clean step; edge-width growth at most 0.5 prepared pixel.                                                                                                                                                     |
| Isolated stars                             | Preserve at least 90% of each entering noisy peak above background at 15-sigma contrast. No shifted peaks or newly introduced extrema.                                                                                                                                         |
| Spatially varying merge-like noise         | No induced mean discontinuity above 0.003 feature units on a flat field across a 4:1 noise-sigma boundary. This does not promise identical residual noise in differently sourced regions.                                                                                      |
| Alpha / HDR / signed channels              | Alpha and transparent pixels exact, no dependence on hidden alpha-zero RGB, all finite, no reference-white clipping; include negative channels and at least 16× white.                                                                                                         |
| Detail sharpening                          | Flat fields exact; edge overshoot/undershoot at most 5% of the entering linear edge range; halo reach no greater than the declared support. At Amount 50/Radius 1/Threshold 50, flat-noise RMS gain at most 1.10 and a soft edge's central slope must increase by at least 5%. |
| RGB CPU/GPU and tiled/full agreement       | Existing `2e-6 + 2e-5 abs(reference)` per RGB channel, unchanged. Float64 oracle comparison uses `2e-12 + 2e-11 abs(reference)`. Alpha exact.                                                                                                                                  |

Fixtures include flat shadows/gray/color, repeating texture, slanted/axis-aligned
edges, isolated stars, impulses, noisy merge-like boundaries, transparent borders,
signed channels and HDR. Include combined denoise/sharpen cases. Real skin, hair,
foliage, stars and deghost boundaries need independent native crops and paired real
captures when the desktop/GPU is available; synthetic success does not close them.

## Resources, caches and adoption

### Retained comparison 1 and declared comparison 2

The [first report](../../artifacts/detail-research/comparison-1/report.json) retains
both failures and its exact original scripts/inputs. Bilateral retains 76.9% of
period-4 amplitude and patch NLM retains 70.0%, failing the 90% gate. Both reduce
flat noise; sharpening's first flat-noise gain is 1.047, below 1.10. Nothing is
adopted on that evidence. The clean data, manual amounts and quality thresholds
are unchanged for the following comparison.

Comparison 2 measures a predeclared bandwidth Pareto grid: maximum luminance
bandwidths 0.032, 0.040, 0.048, 0.056, 0.064 and the failed 0.080 baseline. Chroma
bandwidth remains 0.16 and both support windows remain unchanged. Record noise and
texture jointly rather than selecting a lower strength only for a troublesome
chart. A candidate must pass every original gate with one consistent parameter
policy. Check the selected policy against independent noise seeds and additional
periods before production adoption. This is parameter research before any settings
or history version enables these semantics.

For the merge-like chart, induced discontinuity is the change in the two sides'
feature-mean difference after filtering, using the six columns on either side of
the boundary. Retain entering and clean errors too; an already different random
sample mean is not evidence that a filter introduced a seam.

### Bounded implementation

The [Pareto grid](../../artifacts/detail-research/comparison-2/pareto.json) finds
that no tested bilateral bandwidth passes both flat-noise and period-4 texture
gates. NLM at maximum hL 0.048 retains 97.4% of period-4 amplitude and leaves 42.1%
of flat luminance noise (18.3% chroma); 0.056 retains 93.9% and leaves 32.6% noise.
Carry the more texture-conservative 0.048 policy into the declared holdout rather
than accepting the first passing noise result. All original gates remain fixed.
Holdout uses seeds 1, 12345, 3735928559 and 1515870810, plus periods 3/6/8 at feature
amplitude 0.03. Record every individual result; aggregate projected amplitudes
over these independent noise realizations to separate random entering projection
bias from systematic filtering loss. A failed holdout still blocks adoption.

The [holdout report](../../artifacts/detail-research/comparison-2/holdout.json)
passes every individual gate for all four seeds. Luminance residual ratios are
0.399…0.451; mean retained amplitudes for periods 2/3/4/6/8 are approximately
1.020/1.020/0.983/0.958/0.956. Select bounded NLM with maximum hL **0.048** and hC
**0.16** for implementation research, retaining the 3×3 patch, 7×7 search, sigma-2
spatial weights and all earlier thresholds. The initial 0.080 mapping remains a
failed candidate, not persisted semantics. Radius/strength values are manual
engineering units, not an automatically estimated noise model.

All radii/support refer to prepared image pixels, never CSS size, zoom or device
pixel ratio. The combined maximum halo is 13 pixels. Candidate tile edge is 256;
at most 282×282 source pixels feed one combined tile. Reject malformed dimensions,
missing halo, aliases, nonfinite parameters and size-arithmetic overflow before allocation.
Reject nonfinite computed pixels before publication.
Use bounded strips/tiles and cancellation between dispatches/tiles. Keep a finite
CPU fallback and explicit GPU-loss/retirement ownership. Do not weaken existing
managed image budgets, admission policy, fences or preview timing thresholds.

GPU features should prepare once per tile/source variant, use shared neighborhood
reads where beneficial, and keep constant packets separate from image buffers. A
neutral stage allocates no filtering surfaces or specialized pipelines. Prepared
spatial variants must retain source/master provenance and include algorithm,
parameters, reference-white-balance/lens identity, dimensions and support in cache
keys. Later color gestures reuse them. Freeze the final memory formula and hardware
timing comparison before adopting the chosen backend.

Public settings/history/UI/MCP adoption follows passing operator decisions and
complete processing adapters. Migrate all historical snapshots with zero/bypass
defaults, preserve redo/revisions/timestamps and immutable originals/masters, and
freeze committed parameters in exports. No automatic noise estimator is enabled
without validated calibration or measured statistics/confidence and explicit accepted
parameters. Fit uses the actual filtered source or a separately validated, clearly
identified approximation; 100% always means exact source pixels. Full-size hardware,
real RAW/gain-map/merge, foreground and performance gates remain deferred while the
user is playing, not waived. The full professional-editing goal remains active.

## Implemented internal kernels and bounded owner

[CPU kernels](../../src/shared/spatial-detail.ts) implement the selected NLM and
protected luminance sharpening, with original alpha, signed-zero/neutral bypass,
explicit native halos and Float32 publication between stages. The independent
[Decimal80 oracle](../../scripts/research/detail-reference.py) derives primary
coefficients independently and enumerates full patches/2-D convolution. Its fixture
checks 1,728 points across both primaries, HDR/signed/near-black, partial/tiny alpha,
transparent hidden RGB and combined stages. The separate
[quality oracle](../../scripts/research/detail-quality-reference.py) uses prefix
rectangles rather than the production tap loops and retains known clean/noisy truth.
All original numerical and quality tolerances remain unchanged.

The [WGSL kernels](../../src/shared/spatial-detail-wgsl.ts) prepare features once,
share a 16×16 feature neighborhood per 8×8 NLM workgroup and reuse constant spatial
weights instead of evaluating that Gaussian for each candidate/pixel. The original
Gaussian high-pass definition remains unchanged. The combined
[GPU owner](../../src/main/gpu/spatial-detail.ts) keeps the padded denoised intermediate
on-device, reuses fixed buffers, prepares only active programs, freezes source/control
snapshots before awaiting setup and admits one in-flight operation. Neutral work
does not create a GPU device. Close waits for the owned operation and submission
fence before destruction; cancelled/invalid work cannot publish pixels.

The [resource plan](../../src/shared/detail-resources.ts) charges the two feature
planes, source/window copies, intermediate, output, mapped readback and bounded
control packets together with existing reservations. Active CPU work reserves
8,615,808 bytes, active GPU host work 14,530,944 bytes, and GPU buffers 5,843,552
bytes; a neutral tile copy reserves 1,048,576 host bytes and no GPU surfaces. These
are bounded low-level tile-owner allowances, not total-photo/cache acceptance.
Retained GPU buffers stay charged on later jobs, including neutral/CPU recovery.

Alpha products below the GPU precision domain use the same Float64 CPU operator;
source alpha below `2^-20` triggers that recovery before device setup. Alpha is never
rounded to zero and the edit is never skipped. Nonfinite GPU output also requests
equivalent CPU recovery. Diagnostics count successful recovery tiles. Tiny-alpha
recovery does not authorize ignoring already allocated GPU reservations.

The selected CPU equations and real tiny GPU kernels have focused evidence. Owner
tests cover canonical RGB agreement, exact tile seams, buffer reuse, caller
mutation, budgets, cancellation before/after device acquisition and retirement.
These are internal processing foundations.
Settings remain **10/catalog 20**: public edits and catalog preflight reject the
unfinished `noiseReduction`/`detailSharpening` groups. Native helper integration,
cache publication and preview/export adapters, photographic placement acceptance,
UI/MCP/migration and real-source/performance acceptance remain unfinished. Output
sharpening stays in Goal 2. No local editing mask feature is introduced.

## Focused verification: 2026-10-27

The [registered checkpoint](../../artifacts/verification/2026-10-27T17-26-15.076Z-check-i662Ul/summary.md)
passed **766 cases in 47.77 seconds**, with no failures, skips or interruptions.
The selection was `spatial-detail`, `detail-resources`, `detail-quality`,
`spatial-detail-gpu`, `spatial-detail-owner` and `catalog-migration`, plus the
runner's shared static/build and cheap Node checks. This is an overlapping focused
selection, not 766 new detail tests or a comprehensive checkpoint. The Node stage
took 18.74 seconds, above the 15-second fast-check aim; no assertions were removed.

The independent references cover 1,728 numerical points and 27,648 known-truth
quality components. Tiny GPU tests exercise both primaries and compare every
numerical reference point under the original RGB tolerance. The owner checks
combined GPU stages without a CPU intermediate, finite precision recovery, exact
alpha, source/control snapshots, retained-buffer admission, close while busy and
cancellation after device acquisition without image-buffer allocation.

The [local evidence ledger](../../artifacts/detail-research/summary.md) retains the
failed initial candidates and the implementation/setup failures preceding the
passing checkpoint. Source hashes are recorded beside it. No production library,
full-resolution RAW decode, foreground window, presentation benchmark or full-size
GPU workload was part of this selection. No new operator is enabled in public
settings, and the professional-editing goal remains active.

## Streamed prepared-source adapter: 2026-10-27

The internal [band processor](../../src/main/processing/detail-bands.ts) retains at
most three immutable, verified 64-row source strips. That window covers a 64-row
output band and the maximum 13-pixel native halo; horizontal windows stay bounded
by the existing tile plan. Every tile uses global source coordinates. CPU fallback
yields between tiles, and GPU recovery waits for the failed owner's retirement
before allocating the equivalent CPU result. Precision-recovery tiles count as CPU
work, separately from successful GPU tiles.

The [prepared-file adapter](../../src/main/processing/detail-preparation.ts) consumes
the existing verified HDR strip reader, including its final whole-file digest.
It uses exclusive destination creation and removes only its own incomplete output
on corruption, cancellation or failure. The source/master is never overwritten.
Each output strip and the completed file receive hashes. Reference white balance,
source color/provenance and native dimensions remain unchanged. Its source lease
belongs to the caller until reading, GPU retirement and cleanup complete.

The cache key combines the upstream lens/reference-WB preparation identity, exact
source hash, dimensions, source metadata and active versioned filter controls.
Backend choice and bypassed controls do not change pixels or invalidate the key.
Neutral work reuses the previously validated/admitted source without file reads,
new output or GPU setup. This is a preparation adapter, not cache publication or
public-settings adoption. The in-memory adapter is recorded separately below;
application caller/cache adoption remains unfinished.

`PreviewProcess.prepareDetail` freezes the complete request before its first await
and sends it only to the isolated Node worker. Worker shutdown aborts and awaits
the active detail operation before closing, so cooperative cancellation includes
derived-file cleanup and GPU fences. No filesystem renderer bridge is added.
Crash/forced-process termination still relies on the owning staging directory's
recovery contract; publication/recovery integration remains pending.

The stream resource plan adds `width × min(height, 192) × 16` source bytes,
`width × min(height, 64) × 16` output-band bytes, and
`ceil(height/64) × 1024 + 8192` descriptor/control bytes to the existing tile plan
and caller reservations. Neutral strip passthrough charges one source strip and
no output band; prepared-file identity reuse does not enter that iterator. The
5500×3672 arithmetic test reserves less than one eighth of a full float frame for
GPU host processing. This is bounded accounting evidence, not a measured RSS or
full-size performance result. Budgets and tolerances are unchanged.

The [final focused checkpoint](../../artifacts/verification/2026-10-27T17-49-08.282Z-check-ELoSex/summary.md)
passes **754 cases in 45.79 seconds**, selecting `detail-preparation`,
`detail-preparation-gpu` and `detail-resources`, plus shared cheap/static/build
checks. Counts overlap earlier checkpoints. Seven service cases cover the real
Node worker, immutable snapshots, full-height versus band seams, whole-source
digest failure, cancellation after a completed band, cancellation through the
worker, retirement before CPU recovery, budget rejection, reuse/cache identity and
malformed backend pixels. One 19×131 real-GPU file checks all RGB channels against
the canonical CPU, exact alpha/transparent RGB, verified output hashes and buffer
retirement. The Node stage took 20.60 seconds, above the fast-check aim. No RAW
decode, foreground, full-size GPU workload or performance checkpoint ran.

## Predeclared placement comparison 1

Before connecting these operators to the editor, compare prepared-reference-WB
filtering with filtering after manual WB, and native filtering before geometry
with filtering the visible cropped/resampled image. This is a small-chart order
decision, not photographic or sensor-domain acceptance. Preserve every result.

Use the existing 32×24 known-truth flat-luminance, flat-chroma, period-2 and period-4
recipes, sigma 0.012, original manual strengths and hL/hC mapping. Use the four
already declared holdout seeds (1, 12345, 3735928559, 1515870810) in both primary
domains, deriving RGB from the same known feature fields. Record every seed and
aggregate residual RMS, mean bias and projected texture amplitude across all four;
discard none. Keep the existing 0.55/0.45 noise, 0.003 bias and 0.90…1.05 texture
limits. The earlier native per-cohort quality tests remain unchanged.

The manual-WB comparison uses As shot and Custom 2800 K/−25, 6500 K/0 and
12000 K/+35. Its declared synthetic camera profile is the existing WB test family:
as-shot gains `[2,1,1.5]`, XYZ-to-camera
`[0.7,0.2,0.1, 0.1,0.8,0.1, 0.1,0.1,0.8]` and camera-to-working
`[1.4,-0.3,-0.1, -0.1,1.2,-0.1, 0,-0.1,1.1]`. These are stress transforms,
not measured camera calibration. Record the resulting matrices. Pull the output
back through the inverse WB for common native-domain metrics, and separately
record RGB residuals in the edited domain. Never clip or normalize either order.

Geometry cases are a centered integer 24×16 crop, a fitted 7° crop with center
`(0.503,0.487)` and normalized extent `(0.75,2/3)`, and a full clockwise quarter
turn. Use the existing native-spacing Catmull-Rom/alpha policy for clean, noisy and
filtered frames alike, with its independently verified geometry/filter math.
Measure noise/texture against the equally resampled clean truth, reporting the
entering projection too. A quarter turn must agree with relabelled native filtered
pixels under the unchanged RGB tolerance. Record visible-crop boundary differences
against filtering with the actual upstream neighbors; cropping must not redefine
the prepared native filter's context. This comparison does not reject every
possible later implementation that explicitly retains those missing neighbors.

For sharpening, compare both sides of WB and geometry at Amount 50/Radius 1/
Threshold 50 on the flat-noise chart and the existing analytic soft edge. Preserve
the 1.10 flat-noise gain and 1.05 native soft-edge slope gates. Record resampled
edge gain against its clean geometric baseline rather than calling interpolation
ringing a sharpening improvement. Existing native halo/HDR/alpha gates remain
required. Choose placement from quality and native-coordinate behavior; cache
reuse alone is insufficient. A failed required candidate gate blocks its adoption.

## Placement decision for integration

The [placement study](../../scripts/research/detail-placement.ts) runs all declared
seeds and both primaries, retaining **672 per-seed measurements**, 168 aggregate
records and every candidate. Its known-truth source generator matches the existing
independent Python fixture byte-for-byte on the original cohort before generating
the extra cohorts. Production composition uses the already independently referenced
NLM, sharpening, WB and crop kernels. This is an order experiment, not a second
independent implementation of every operator.

Both before/after orders pass the applicable declared noise, bias, texture and
native soft-edge gates. There is no measured overall quality winner in this small
sample. Quarter turns agree exactly in published Float32 RGB. For integer crops,
interior results agree exactly when the full halo is available, while filtering the
visible image with replicated crop edges differs by up to approximately **679 times**
the existing per-channel RGB tolerance at a crop boundary. The report preserves
these differences and both orders' equally resampled clean/noisy references.

Ranges below pool the declared WB/geometry contexts and both primaries after
four-seed aggregation. Each applicable threshold is unchanged.

| Measurement                       | Before WB/geometry | After WB/geometry | Gate      |
| --------------------------------- | ------------------ | ----------------- | --------- |
| Flat luminance residual RMS ratio | 0.415…0.430        | 0.316…0.429       | ≤0.55     |
| Flat chroma residual RMS ratio    | 0.172…0.219        | 0.163…0.217       | ≤0.45     |
| Period-2 amplitude retention      | 1.020…1.040        | 0.972…1.040       | 0.90…1.05 |
| Period-4 amplitude retention      | 0.964…0.983        | 0.911…0.983       | 0.90…1.05 |

Later filtering reduces flat noise more in some contexts while approaching the
lower period-4 texture limit. Earlier filtering retains more of that worst-case
sampled texture while meeting the noise limit. This is evidence for the selected
tradeoff, not a claim of universal dominance on photographs.

Select **native prepared reference WB → denoise → detail sharpening → geometry →
manual WB → later color/output** for application integration. It meets the measured
quality limits and retains the actual native neighborhood and fixed radius rather
than letting visible framing redefine them. The prepared reference also fixes the
declared Luminance/Chroma coordinate semantics across later manual WB gestures.
Prepared-cache reuse is an additional consequence, not the quality justification.
This does not reject another future order that explicitly preserves the required
off-crop context and validates its different parameter semantics.

The shared stage identity is `prepared-native-reference-before-geometry-wb-v1`.
Prepared-file version **2** includes that identity in active cache keys and typed
worker results. Identity still reuses the unfiltered source without new I/O. This
binds internal preparation metadata; it does not by itself prove that every preview,
native helper or export caller consumes the correct source. Those adapters and
transactional public-settings/history/UI/MCP adoption remain unfinished.

The [local placement ledger](../../artifacts/detail-research/placement-1/summary.md)
retains invocation/source evidence and candidate metrics. A null diagnostic ratio
means no relevant entering noise, texture or soft-edge reference energy; required
gates reject an unavailable measurement. No seed, failing candidate, original
quality threshold, native halo/HDR/alpha requirement or photographic/foreground/
performance gate is removed by this decision.

The [final focused checkpoint](../../artifacts/verification/2026-10-27T18-10-57.398Z-check-AF6ker/summary.md)
passes **755 cases in 45.76 seconds**, with no failures/skips/interruptions. Selection:
`detail-placement`, `detail-preparation`, `detail-preparation-gpu`, plus shared cheap
checks/static/build. The new study takes 0.80 seconds in the service group. The Node
stage takes 19.69 seconds, above the fast-check aim; counts overlap prior checkpoints.
All 78 applicable aggregate conditions in each order pass; six geometric soft-edge
records per order remain diagnostics without an added acceptance threshold.
The earlier lint-only attempt and standalone study are retained in the local ledger.

## Authored in-memory adapter: 2026-10-28

The [frame adapter](../../src/main/processing/detail-frame.ts) uses the same band
and CPU/GPU operators for an upstream validated, immutable `WorkingFrame`. Primaries
are explicit; it preserves the authored display transform and snapshots controls,
dimensions, source view and metadata before iteration. It never infers a new color
space or changes reference exposure. Identity returns the original frame and exact
borrowed strip views without a filtering scan, image copy, output or GPU setup.

Active streams borrow source-strip views from that one backing buffer. The
[frame resource plan](../../src/shared/detail-resources.ts) charges its complete
backing allocation once, including bytes outside a subarray view, one output band,
bounded descriptors and the existing tile resources. A retained-frame consumer
separately admits one full output. Source views do not create three additional
float-strip planes. Other live/retiring owners remain in the caller reservation;
policy limits, CPU recovery and retirement obligations are unchanged.

Newly filtered frames discard the upstream native CPU handle and frame identity.
An HDR frame's input strip/full hashes are checked before filtering; retained
output receives new strip/full hashes while preserving source/white-balance
provenance. Its old URL is removed. `sourceHdr` on the reader is labelled upstream
provenance and must never describe filtered bytes. Streaming callers must create
their own completed descriptor before publication. The unfiltered source still
belongs to the original owner and remains the WB picker's reference.

Six service cases cover neutral borrowing, maximum combined halo/tile seams in
both primaries, streamed/retained equality, caller replacement before iteration,
HDR file/frame equality, stale-hash rejection, budgets and source validation,
equivalent CPU routing and early iterator return through GPU retirement. A tiny
19×131 real-GPU case in each primary domain verifies RGB agreement under the
unchanged tolerance and exact alpha/transparent RGB. Its one tiny-alpha source
sample produces one CPU recovery tile and two GPU tiles, accurately reported as
mixed processing; every buffer is retired before completion.

The [registered checkpoint](../../artifacts/verification/2026-10-28T08-05-42.813Z-check-mUiDBJ/summary.md)
passes **762 cases in 41.34 seconds**, with no failures/skips/interruptions. Selection:
`detail-frame`, `detail-frame-gpu`, `detail-preparation`, `detail-preparation-gpu`
and `detail-resources`, plus shared cheap/static/build checks. Counts overlap prior
selections. Node takes 17.75 seconds, above the fast-check aim; service takes 3.48
seconds and the tiny-GPU group 1.37 seconds. No full-size GPU, real RAW decode,
foreground or performance checkpoint ran.

The [frame evidence ledger](../../artifacts/detail-research/frame-2026-10-28/summary.md)
retains source hashes and the earlier interrupted run, whose runner/worker processes
were checked before clearing only its stale lock pointer. The original partial
logs remain intact and are not counted as a completed pass. These adapters do not
yet publish cache variants or connect every preview/export/native caller. Settings
remain **10/catalog 20**, and public NR/detail controls, history/migration/UI/MCP
adoption and real-photo/native/performance acceptance remain unfinished. The full
professional-editing goal stays active.

## Prepared preview path: 2026-10-28

The internal [preview adapter](../../src/main/processing/detail-preview.ts) now
connects native filtering to the existing point/output renderer. Its typed
`PreviewProcess.prepareDetailPreview` request freezes source, controls, point edits
and revision before waiting for the isolated worker. A small actual PNG is decoded
from its original, filtered in linear sRGB, then rendered from the derived float
file; changing only point edits retains the same filter key and float hash.
The original photograph and upstream working file remain unchanged.

This adapter requires active filtering, an upstream source identity and an empty
unpublished directory. Neutral controls reuse the parent cache entry. Nonidentity
committed geometry is rejected here so filtering cannot accidentally follow a crop.
Manual WB/Light/color edits run afterward. The new `renderPreparedFull` entrypoint
uses the supplied float source directly, independently of the original file's
decoder/extension; it cannot fall back to a camera JPEG or re-decode the original.
Existing ordinary preview entrypoints remain in place.

The derived float descriptor retains native dimensions, explicit domain and authored
transform/provenance. HDR working-only requests return that descriptor without an
RGBA proof. Rendered requests use `prepared-detail-proof-v1` plus the filter key and
actual float hash in their render identity. Before returning, the adapter checks
dimensions, byte counts, frozen point parameters/revision, the actual RGBA file
hash and placeholder size. Cancellation or failure removes only this job's known
outputs; a pre-existing output is rejected and preserved.

Prepared HDR rendering follows the source's output domain: RAW/merge scene data
uses the existing ACES renderer; authored HDR data uses the source-aware output
path and does not receive the RAW scene transform again. The existing GPU proof
converter handles scene data; authored-HDR proof uses its equivalent CPU path.
NR itself can still use GPU for that source. GPU proof conversion is closed and
awaited before CPU recovery or operation completion.

The [preview resource plan](../../src/shared/detail-resources.ts) reserves source
filter work and host proof storage together. Raster proof charges its float readback
and two simultaneous RGBA planes plus bounded placeholder overhead. HDR proof is
strip-based. Filter GPU resources retire before proof allocation, so GPU peak uses
the larger phase plus existing reservations rather than adding both freed and live
buffers. If host proof pressure would exclude GPU filtering, Automatic prefers the
expensive filter on GPU and the proof on CPU. `proofBackendRequest` records the
selected route; renderer fallback diagnostics remain separate. These formulas do
not establish measured RSS, full-size speed or presentation cadence.

The cache-safe [identity helper](../../src/main/processing/detail-identity.ts) is
importable without decoder/native modules and retains existing HDR prepared-file
v2 keys. The raster key also binds its authored transform. It ignores backend and
bypassed controls, and does not include later point edits. The application cache
manager still needs to adopt these keys, pin parent/derived entries, publish and
recover variants, and retain the unfiltered WB-sampling reference.

The [CPU/worker selection](../../artifacts/verification/2026-10-28T08-54-09.160Z-check-lVPd76/summary.md)
passes **759 cases in 45.56 seconds**, selecting `detail-preview`,
`detail-resources` and `detail-preparation`, plus shared cheap/static/build checks.
Four new service cases cover actual PNG/worker output, frozen requests, point-only
key reuse, both HDR domains, working-only data, invalid source/geometry/domain,
budgets, pre-existing files, cancellation and wrong rendered revision/hash cleanup.
The Node stage takes 21.56 seconds, above the fast-check aim.

The separate [tiny hardware pipeline selection](../../artifacts/verification/2026-10-28T09-04-01.465Z-check-75GygM/summary.md)
passes **749 cases in 40.47 seconds**, selecting `detail-preview-gpu` plus shared
checks. One GPU case runs raster, scene-HDR and authored-HDR instances. Linear RGB
agrees under the original `2e-6 + 2e-5 abs(reference)` tolerance; rendered RGBA is
within one code value with alpha exact. GPU filtering executes in all three;
scene-HDR proof also uses GPU without fallback. Authored HDR retains its CPU proof
domain. The tiny-GPU group takes 1.49 seconds; Node takes 19.72 seconds. These
selection counts overlap and must not be added.

The [preview evidence ledger](../../artifacts/detail-research/preview-2026-10-28/summary.md)
records scope and source hashes. No real RAW decode, foreground window, full-size
GPU or benchmark ran. Public settings remain **10/catalog 20** and NR/detail tools
remain unavailable. Cache publication/leases, export and native consumer adoption,
transactional public edits/history/UI/MCP and real-photo/native/performance gates
are still unfinished. The complete Goal 1/Goal 2 objective remains active.

## Application cache integration: 2026-10-28

The existing [preview cache](../../src/main/full-previews.ts) now adopts the private
`ProcessingOptions.noiseReduction`/`detailSharpening` controls through its serialized
spatial path. It prepares an unfiltered native source, filters once, then creates
optional crop and point/output variants. Later color changes reuse the filtered
float file; different crop geometry reuses filtering. No second cache or scheduler
is introduced. Existing cache-container and RAM/VRAM limits remain unchanged.

[Path-free lineage](../../src/main/prepared-preview-lineage.ts) binds the upstream
working identity, verified input hash/dimensions/domain, active versioned controls
and selected stage. A cropped source layers the existing geometry identity over
that filtered key. Publication and startup validate the lineage; startup also
hashes filtered raster data, as already required for HDR. Forged extra paths,
inconsistent keys and same-size damaged derived data are rejected. A complete
filtered entry can reopen after its idle upstream entry has been evicted.

The upstream entry stays pinned through filtering/publication/cleanup. Derived
sources retain independent display, protocol-stream and CPU-file leases. CPU source
checks now require the exact current spatial/crop identity and revision, so an old
unfiltered reference cannot satisfy active denoising. Frozen main-only working
leases select uncropped filtered data and retain its lineage, independently of
later current edits; export consumers still need to adopt this identity.

Crop drafts use filtered native dimensions without applying committed geometry.
Authoritative geometry metadata and WB sampling explicitly request the unfiltered
source. The new service WB test captures that source hash and deliberately rejects
the synthetic proposal; it does not establish photographic picker acceptance.
Existing small-fixture crop/context/CPU lease regressions remain selected.

Typed `renderPreparedFull` worker requests rerender supplied float sources directly,
including authored HDR, without reopening the original. Prepared raster requests
can reuse the worker's matching immutable frame. Shutdown retains the existing
cooperative work owner until completion/retirement. `detailProofMemoryPlan` admits
only current point/output storage for a cached source, without reserving retired
filter allocations; exact host/VRAM boundaries and GPU-to-CPU proof selection have
focused Node checks.

`prepared-source-proof-v1` is a separate rendering identity and persisted proof
tag. Every prepared render ID also binds the supplied float SHA, including
point-only rerenders; the semantic filter key remains backend-independent. Old cropped RGBA renditions rebuild from their retained float source; native
crop/filter keys and cache container v9 remain reusable. Authored HDR proof retains
its source-aware output domain. Diagnostics now distinguish source preparation
from actual proof conversion using `proofBackend` and successful CPU/GPU strip
counts. The count describes output conversion, not GPU execution of every earlier
point operation, presentation cadence or GPU timestamps.

The final [registered selection](../../artifacts/verification/2026-10-28T10-09-06.625Z-check-JIGaKy/summary.md)
passes **800 checks in 51.56 seconds**, with no failures, skips or interruptions.
It selects `detail-preview-cache`, `detail-preview-cache-gpu`, `detail-preview`,
`detail-frame`, `crop-preview-cache`, `crop-context` and `full-previews`, plus shared
cheap/static/build checks. Eight new service cases cover reuse/order, unfiltered WB
dispatch, frozen and CPU leases, evicted parents, pressure, removal/cancellation,
corrupt metadata/pixels, failed publication and legacy proof rebuilding. The GPU
case runs tiny raster, scene-HDR and authored-HDR instances. Filtering uses GPU in
all three; scene-HDR proof records successful GPU strips without fallback. Linear
RGB stays within the original `2e-6 + 2e-5 abs(reference)` tolerance; RGBA stays
within one code value and alpha remains exact. Backend changes reuse the same
cache entry. Service work takes 5.64 seconds and the tiny-GPU group 2.13 seconds.
The Node stage takes 21.29 seconds, above the fast-check aim.

The [cache ledger](../../artifacts/detail-research/cache-2026-10-28/summary.md) retains
the initial passing checkpoint, subsequent GPU-diagnostics assertion failure,
exact-case rerun and final checkpoint, with source hashes and unchanged native
manifest. Counts overlap. No real RAW/gain-map/merge decoding, foreground window,
full-size GPU or benchmark ran. Private cache/source/CPU admission now has focused
evidence; public NR/detail controls still remain unavailable at settings 10/catalog 20. Export/native consumer acceptance, transactional public history/UI/MCP adoption
and real-source/native/performance acceptance remain unfinished. Both goals stay
active with their existing acceptance gates.

## Frozen export adapters: 2026-10-28

The isolated [export rendition worker](../../src/main/export/renditions.ts) now runs
the shared native-grid detail stage before crop, point edits, alpha flattening and
output resizing. Scene-HDR/managed working data uses verified strips in Rec.2020;
authored raster and an imported HDR source's separate SDR primary use their own
linear-sRGB frame. Paired renditions receive independent filtering without mixing
their color semantics. This remains detail sharpening before geometry, separate
from Goal 2's output sharpening after final resizing.

The [export policy](../../src/main/export/detail-policy.ts) freezes stage, noise
and sharpening versions in the accepted manifest. Neutral older manifests remain
readable; active controls require the supported policy. Each renderer attempt gets
its own copied source/options/policy, and refreshes live spatial admission after
foreground preemption. Worker-local mutations cannot change accepted settings or
a retry's source. Public settings/history groups remain disabled.

Exact filtered HDR preview leases are authenticated against frozen controls and
upstream lineage before reuse; they are not filtered twice. An unfiltered or newly
decoded working source still receives filtering. Completed [worker variants](../../src/main/export/detail.ts)
live in the existing job preparation directory, independently of disposable JPEG
output. Keys bind native dimensions, domain, stage, active controls and actual
upstream float hash. Retained descriptors and source bytes are checked before
reuse. Corrupt/incompatible derived files rebuild while completed upstream source
preparation remains available. Cancellation before work creates no derived output;
hard interruption leaves owned files for the existing retry/job cleanup paths.

NR preparation admits current reservations, source/retained-frame ownership and
future rendition storage through the existing frame/strip plans. The raster reader
now validates dimensions, limits, transform and size before allocation, and hashes
bytes before accepting retained data. Diagnostics separate working/primary filtering, reuse and
tile backends from final rendering/encoding. The checkpoint below predates the
managed renderer/encoder accounting in the following resource checkpoint;
existing converter limits are retained.

The [focused export checkpoint](../../artifacts/verification/2026-10-28T10-42-17.512Z-check-vWFnee/summary.md)
passes **801 checks in 46.48 seconds**, with no failures, skips or interruptions.
Selection: `detail-export`, `detail-export-gpu`, `export-context`, `crop-export`,
`detail-preview`, `detail-preview-cache`, plus shared cheap/static/build checks.
Six new service cases cover native filtering/crop ordering, the real isolated SDR
JPEG worker, HDR resize/renditions, paired authored domains, frozen cache leases,
retained-file corruption and policy/admission/cancellation refusal. An added job
case checks fresh admission and frozen controls through a foreground retry and
worker mutation. Service work takes 5.90 seconds; Node takes 17.80 seconds, above
the fast-check aim. The tiny-GPU group takes 4.09 seconds.

The GPU case runs 19x17 raster, scene-HDR and paired authored inputs. Filtered RGB
retains `2e-6 + 2e-5 abs(reference)` agreement and exact alpha. Quantized output
uses the existing export limits: at most one SDR code value and 0.004 absolute
decoded-half difference. A later test-only extension verifies retained filtering
through injected final-converter unavailability and complete CPU recovery. Its
[exact-file rerun](../../artifacts/verification/playwright-1793184501348-8bf1741f-3eb7-4ae2-81fc-49bc68709b2f/playwright/summary.json)
passes one case in 1.20 seconds. Type checking and focused lint also pass afterward;
application code is unchanged after the 801-case checkpoint. Counts overlap.

The [export ledger](../../artifacts/detail-research/export-2026-10-28/summary.md)
retains the initial lint failure, fixed rerun, later recovery case and source audit.
HDR fixtures here are prepared synthetic descriptors, not real RAW/gain-map/merge
decodes or HDR JPEG round trips. No foreground window, full-size GPU workload,
benchmark or comprehensive checkpoint ran. At this checkpoint, remaining implementation
included final export renderer/encoder managed admission, authored-raster preview-cache lease
adoption, prepared-source native execution acceptance and transactional public
settings/history/UI/MCP. Real-source/native/performance acceptance, Goal 1's later
enlargement/copy-paste/batch and all Goal 2 work remain in scope.

## Export resource checkpoint: 2026-10-28

The shared [export resource plans](../../src/shared/export-resources.ts) now admit
floating-point input, retained source/output planes, rendering and resizing against
the frozen live-owner snapshot. Separate phases use their maximum work reservation;
retired GPU work is not added to later resize work. Source filtering/cropping admits
its own live inputs before rendition buffers are allocated. The JPEG worker passes
the remaining VRAM allowance into the existing converter.

The converter checks every explicit GPU buffer allocation against that allowance
and the unchanged 1 GiB ceiling. Full-image HDR retention is optional: an admitted
tile can stream combined HDR/SDR when retaining the HDR intermediate would exceed
the allowance. One request runs at a time. Idempotent asynchronous shutdown drains
the active request and queue before releasing buffers/device; CPU recovery waits
for that retirement.

SDR encoding reserves its output and scratch model against either the concurrent
renderer owners or the retired-renderer phase. Early encoding is deferred when
only the latter fits. HDR encoding retains the existing 56-byte/pixel codec model,
primary copies, 128 MiB allowance and 2 GiB codec limit. Native and WASM plans
distinguish sequential output reads from simultaneous WASM/output copies. Actual
encoded lengths are checked before accepting output; the WASM limit is checked
before copying its result, and the native file is checked before reading it.
These are reservation models and explicit-buffer bounds, not measured whole-process
RSS or driver-internal allocation guarantees.

The [focused resource checkpoint](../../artifacts/verification/2026-10-28T11-28-06.528Z-check-rjpDHq/summary.md)
passes **801 checks in 55.09 seconds**, with no failures, skips or interruptions.
Selection: `export-resources`, `export-resources-gpu`, `export-resources-encoder`,
`detail-export`, `detail-export-gpu`, `crop-export`, `export-context`, `export-gpu`,
plus shared cheap/static/build checks. Five new allocation cases use arithmetic
only; one 16-pixel GPU case checks exact budgets, streaming, concurrent-request
rejection and shutdown during work. One 8x8 encoder case checks native/WASM refusal
before output, successful exact-budget reservations, preserved SDR primary and the
WASM output-copy limit. Existing export recovery/reference tests also pass.
Node takes 17.22 seconds, above the fast-check aim; service takes 5.45 seconds and
the small GPU group 13.76 seconds. Counts overlap previous checkpoints.

The [resource ledger](../../artifacts/detail-research/export-resources-2026-10-28/summary.md)
retains source hashes and remaining work. End-to-end injected-budget tests must
still verify retained-filter reuse through constrained renderer selection, early
encoding deferral and refusal before publication. Full-size resource measurements,
real-source/native/performance acceptance, raster cache leases, native consumer
acceptance and transactional public history/UI/MCP remain open. Public NR/detail
controls stay unavailable at settings 10/catalog 20. No foreground window, real RAW
decode, full-size GPU workload, benchmark or comprehensive checkpoint ran here.

## Export reuse and native source checkpoint: 2026-10-28

The frozen-budget export cases now exercise the real rendition path. At the exact
tile VRAM allowance the converter streams HDR/SDR without a retained full-image
HDR intermediate. One byte below that allowance, automatic mode reuses completed
filtering and rerenders the complete source on the CPU; explicit GPU mode refuses
before converter allocation. Pixel limits remain one SDR code value and 0.004
decoded-half difference. A tight RAM case delays early SDR encoding until the GPU
has retired; normal admission still permits concurrent encoding with identical
renditions. The isolated SDR worker checks render/encoder refusal and exact admitted
encoding. A library export case verifies that refusal reaches no publication
boundary, preserves an existing destination file and original, and can succeed
under a later admitted job without changing photo history.

[Working-asset validation](../../src/main/working-assets.ts) now also verifies
bounded raster descriptors, display transforms and complete file hashes through
streaming I/O in main, without loading decoders. The existing preview cache can
lease an exact uncropped SDR variant for frozen export settings. Filtered SDR reuse
loads one verified floating-point frame in the worker and bypasses another decode
and filter; incompatible controls or source domains cannot adopt that variant.
Source-read and rendition reservations include its actual retained backing once.

Authored HDR has independent working-HDR and SDR-primary leases. Their keys bind
their own domains; neither can replace the other. Both leases survive foreground
retries with frozen worker copies and retire after worker cancellation. Raster
cache tests also check byte corruption, malformed descriptors, cancellation without
invalidating healthy data, and independent protocol/export eviction pins. A worker
test deliberately supplies an unavailable decoder path after acquiring verified
leases: SDR and paired HDR export must finish from the leased floats. The latter
also performs actual tiny HDR JPEG packaging; this is not a real gain-map input
decode or import/export/reimport acceptance.

The [shipped native source check](../../tests/detail-native-source.spec.ts) feeds
the actual 19x17 filtered HDR cache FD through the existing main attestation and
native CPU controller. It compares both downstream point-rendering planes to the
application CPU reference within one code value, with exact alpha. Independent
filter references remain those recorded above. Native ownership retains the source
after the active preview and export lease release, rejects changed spatial controls
and releases the FD/pin after reset. No native algorithm, request protocol or
generated math changes are needed to consume an already-filtered float source.
Public Before/After must still select the appropriate spatial baseline; this
low-level pair check does not establish an unfiltered public Before view.

The [focused checkpoint](../../artifacts/verification/2026-10-28T11-40-58.675Z-check-ORfoYV/summary.md)
passes **823 checks in 45.01 seconds**, zero failed/skipped/interrupted. Selection:
`detail-export-cache`, `detail-export`, `detail-export-gpu`, `detail-preview-cache`,
`export-context`, `full-previews`, `export-resources-integration`,
`export-resources-gpu`, plus shared cheap/static/build checks. Node takes 18.12
seconds, above the fast-check aim; service takes 6.45 seconds and the small GPU
group 2.23 seconds. A later [three-case selection](../../artifacts/verification/playwright-1793187901035-9cd317b5-2f2e-4a95-9ea6-754fe38bf28e/playwright/summary.json)
passes in 1.61 seconds, adding native FD consumption, dual-lease retry/cancellation
and actual paired HDR encoding. Application code is unchanged after the 823-case
checkpoint; type checking, focused lint/format and the registered native selection
plan also pass afterward. Counts overlap.

The [cache/native ledger](../../artifacts/detail-research/export-cache-native-2026-10-28/summary.md)
retains source hashes, the initial publication-test expectation failure and exact
repair, GPU completion, the passing checkpoint and later native checks. Public
settings/history, comparison/UI/MCP adoption and real RAW/gain-map/merge,
native desktop, full-size resource/performance and combined acceptance remain
unfinished. Public controls remain unavailable at settings 10/catalog 20. All work
here uses small isolated fixtures without foreground windows or benchmarks.

## Unfiltered comparison source foundation: 2026-10-28

Neutral downstream color parameters cannot undo filtering already baked into a
prepared source. Before therefore needs an independently identified unfiltered
source. The comparison policy retains the current committed crop, lens preparation
and reference white balance, while bypassing denoising, detail sharpening and manual
point edits. This defines the same pixel grid for detail comparison and split views.

The typed [comparison contract](../../src/shared/prepared-comparison.ts) carries
only photo hash, cache UUID, float hash and settings revision. Main verifies the
After lineage against confirmed settings before and after preparing its baseline.
HDR working sources and authored SDR primaries remain separate domains. The
existing worker/cache builds the baseline, reuses upstream preparation and admits
SDR proof work against current reservations. No second processing/cache engine,
original/master mutation or edit-history entry is introduced.

One comparison owner pins After and Before independently of the active preview
and protocol streams. Release, revision changes, removal and shutdown cancel and
drain pending work before owned unpublished output is removed. An explicit native
CPU comparison lease checks both the unfiltered source and its accepted After
lineage. It can retain the Before FD after the corresponding UI/protocol owners
release; changed spatial settings invalidate that relationship. Ordinary CPU
source requests cannot adopt the unfiltered source as the current edited source.

The [renderer comparison loader](../../src/renderer/src/hooks/useComparisonPreview.ts)
validates source, revision, domain, geometry and request identity, then drains its
old owner before requesting a replacement. The existing float hook consumes its
verified linear descriptor directly. It cannot display the prior source's pixels
while a same-size replacement is loading, and releases only requests it issued.
These hooks are not yet connected to the application's Before/Split presenters.

The [service checkpoint](../../artifacts/verification/2026-10-28T12-07-32.882Z-check-H0sDWG/summary.md)
passes **792 checks in 40.33 seconds**, zero failed/skipped/interrupted. Selection:
`prepared-comparison`, `detail-comparison`, `detail-preview-cache`, `full-previews`,
`detail-native-source`, plus shared cheap/static/build checks. Eight new service
cases cover exact raster baseline pixels and neutral proof, HDR/primary domains,
native FD authorization, frozen references, resource refusal, reuse and lifecycle
draining. Node takes 17.39 seconds, above the fast-check aim; ordinary service takes
3.38 seconds and the existing native exclusive group 1.29 seconds.

The [hidden hook checkpoint](../../artifacts/verification/2026-10-28T12-20-39.595Z-check-ZjK03z/summary.md)
passes **762 checks in 40.97 seconds**, zero failed/skipped/interrupted. Selection:
`detail-comparison-ui`, `crop-working-preview-ui`, plus shared cheap/static/build
checks. Three new child-frame cases and four existing crop cases pass in the
5.15-second Electron stage. Node takes 17.38 seconds. Counts overlap the service
checkpoint. The first hook run exposed an unissued release from the float hook;
its removal, exact-case repair and rerun are retained in the
[comparison ledger](../../artifacts/detail-research/comparison-sources-2026-10-28/summary.md).
A later renderer-only refinement derives the Before domain from its linear asset,
including a rendered SDR proof backed by HDR floats, and rejects a mismatched HDR
descriptor before fetching. The [exact hook-file rerun](../../artifacts/verification/playwright-1793190489961-4df95d98-aebe-4b4a-aaf4-ccb655f40984/playwright/summary.json)
passes all three cases in 3.34 seconds; focused renderer type checking and lint also
pass. Main/service code is unchanged after the service checkpoint. The later hook
refinement is covered by this rerun, not retroactively by the preceding checkpoint.

No native math, shader algorithm, numerical tolerance or performance gate changes.
The application still uses settings 10/catalog 20 with public NR/detail unavailable.
Before/Split presenter consumption, native request/sample binding, public
settings/history/UI/MCP and real-source/native desktop/full-size resource/performance
acceptance remain unfinished. No real RAW, foreground, GPU workload, benchmark or
comprehensive checkpoint ran in these selections.

## Raster comparison presenter adapter: 2026-10-28

The existing [raster presenter](../../src/renderer/src/preview/presenter.ts) now
accepts a separately validated unfiltered working frame on the exact After grid.
Before samples it with neutral point settings; Split selects it only on the Before
side. The normal single-source shader stays unchanged until this adapter is used.
The creative-color variant preserves the same distinction, and the existing
presentation worker supports the equivalent paired-source route.

One worker job stays active. Source generations reject stale replies, send only
changed float planes and reuse both resident sources across point edits. Missing
required baselines, incomplete comparison programs and replaced worker inputs stay
hidden until their matching pixels are available. Late transferred bitmaps close
after disposal. Exact source aliases avoid a second upload/clone. Mismatched
dimensions, byte counts, display transforms or HDR domains are rejected before
changing the accepted comparison. The shared loader/main capabilities still own
lineage validation; this presenter method is not a new trusted renderer API.

The existing 512 MiB raster allocation guard is retained for the paired textures,
mipmaps, creative parameters and retiring comparison textures. Resource ownership
charges complete borrowed backing buffers, keeps old worker sources through their
replacement reply and retains deleted GPU textures through their completion fence.
These explicit allocation models do not certify process RSS or full-size admission.

The [focused checkpoint](../../artifacts/verification/2026-10-28T13-04-53.190Z-check-DZms7n/summary.md)
passes **763 checks in 42.79 seconds**, zero failed/skipped/interrupted. Targets:
`raster-spatial-comparison`, `creative-color-presenter`, plus shared cheap/static/build
checks. Six new cases and two existing creative presenter cases take 6.49 seconds
in hidden Electron; Node takes 17.41 seconds, above the fast-check aim. Original
8x6 Float32 patterns exercise actual WebGL and worker pixels at 100%, 200% and Fit,
grading, transparency, source reuse, stale publication, failures and resource
retirement. RGB agreement remains at most one SDR code value with exact alpha;
Fit source routing retains each renderer's existing filtering policy. Counts overlap
earlier checkpoints. The [adapter ledger](../../artifacts/detail-research/raster-comparison-2026-10-28/summary.md)
retains the preceding checkpoint and the two-case cleanup refinement.

This is a private presenter adapter: `PhotoPreview` does not yet connect the new
comparison hook to it. HDR GPU/native CPU pairing and native sample consumers are
still unfinished. Settings remain **10/catalog 20** with public NR/detail controls
unavailable; transactional history/UI/MCP, real RAW/gain-map/merge, native desktop,
full-size resource/performance and combined acceptance remain open. No photograph
decode, foreground window, benchmark or comprehensive checkpoint ran. The tiny
WebGL cases above are functional pixel checks, not presentation measurements.

## HDR comparison presenter adapter: 2026-10-28

The private [HDR presenter](../../src/renderer/src/preview/hdr-presenter.ts) now
accepts the same independently authorized Before frame. Local validation requires
matching dimensions, display transform, HDR provenance and reference WB, and detaches
the capability metadata before waiting. A source hash and its rendering identity
jointly bind comparison tiles, histograms, exact presentations and recovery.
Changing an identity label cannot reuse pixels from a different hash. Exact pixel
aliases retain the ordinary single-source route.

The [shared source preparation](../../src/renderer/src/preview/hdr-source-preparation.ts)
extracts the existing verified upload and mip submissions without changing the
WGSL programs, ordered reduction, three-strip boundary or limits. Before reuses
the existing two-entry source cache. Preparation serializes with source loading
and active rendering, aborts/drains a superseded upload, accounts for uncached
candidates and retains pins until actual queue fences settle. Required comparison
sources stay in admission when optional inactive sources are considered for eviction;
legitimate smaller tile caches remain available within the same frozen budgets.

Neutral Before and After tiles share storage only on the ordinary single-source
route. A separate baseline gets its own source key and bounded source-homogeneous
dispatches; the existing shader continues to bypass point edits for Before.
Point gestures reuse source textures. Before histograms sample the unfiltered
texture, and retained raw-half/CPU-staged recovery cannot expose an old source
while the new comparison is missing or uploading. Optional After first surfaces
cannot stand in for a required Before source. Native Before mask requests against
the filtered source remain unavailable until their own binding is implemented.

The [focused checkpoint](../../artifacts/verification/2026-10-28T13-43-04.325Z-check-TDHMRW/summary.md)
passes **765 checks in 44.65 seconds**, zero failed/skipped/interrupted. Targets:
`hdr-spatial-comparison`, `hdr-comparison-source`, `hdr-render-cache`,
`hdr-presentation-cache`, `hdr-source-cache`, `hdr-readback`, plus shared cheap/static/build
checks. Five actual presenter cases take 8.84 seconds in hidden Electron. Node takes
17.08 seconds, above the fast-check aim. The later CPU-staging guard passes its exact
case and then the [complete six-case presenter file](../../artifacts/verification/playwright-1793195143751-5ee4233b-1d5d-40fc-b22a-f932d77b32df/playwright/summary.json)
in **10.02 seconds**, with subsequent type checking, focused lint and formatting
also passing. Counts overlap. The [HDR adapter ledger](../../artifacts/detail-research/hdr-comparison-2026-10-28/summary.md)
retains the initial fixture-domain failure and subsequent checks.

Original 8x6 Float32 inputs exercise actual capture HDR in SDR/HDR, authored HDR
in HDR, grading, zero alpha, Fit/100%, exact neutral Before histograms, warm source
reuse, identity collisions, cancellation, damage, budget refusal and retirement.
The final half-float presentation stays within one encoded SDR code value of the
CPU reference, with opaque presentation alpha exact. Operator tolerances remain
unchanged. Authored SDR continues through its separate raster primary: no HDR
working rendition is substituted for it. The initial fixture incorrectly requested
that unsupported substitution; correcting its routing changed no processing math
or tolerance. These are component checks, not real camera/gain-map input acceptance.

`PhotoPreview` still does not call either private comparison adapter. Native CPU
pair/sample consumers, public settings/history/UI/MCP and real-source/native desktop/
full-size resource/performance acceptance remain unfinished. Settings remain
**10/catalog 20** and public NR/detail controls stay unavailable. No foreground
window, photograph decode, benchmark or comprehensive checkpoint ran. The full
Goal 1/Goal 2 scope remains active, including enlargement/copy-paste/batch and all
advanced tools in the accepted plan.

## Native CPU comparison source pairs: 2026-10-28

The private native controller and renderer client accept a distinct Before source
with the exact After lineage authorized by the main-owned preview cache. Both
sources must match dimensions, HDR provenance and reference WB. They retain
independent leases through child closure, output streams and receiver digests;
changing either source retires the session. The native binary protocol and all
pixel mathematics remain unchanged.

Distinct sources use sequential native passes under the same admission: edited
After from the filtered FD, neutral Before from the original FD. The sink still
validates every output byte and successful child close while writing only the
needed plane. A per-session cache retains at most the existing draft and normal
Before layouts. It hashes private derived files with a bounded buffer before
hardlink reuse, regenerates damaged output and avoids repeated original FD reads
on point edits. Both source sample domains are reserved; limits stay unchanged.

The client validates both capabilities, dimensions, sample bytes and digests before
publishing. Source aliases use the ordinary single pass. Optional Before samples
are available to later consumers; publishing them into application analysis and
forwarding the pair through the native presenter remain unfinished.

The [focused checkpoint](../../artifacts/verification/2026-10-28T14-44-27.462Z-check-b6vn0G/summary.md)
passes **791 checks in 47.54 seconds**, zero failed/skipped/interrupted. Targets:
`native-cpu-comparison`, `native-cpu-comparison-ui`, `native-cpu-pure`,
`native-cpu-controller`, `detail-native-source`, `detail-comparison`, plus shared
cheap/static/build checks. Node takes 16.91 seconds, above the fast-check aim.
Tiny synthetic Float32 sources exercise the checked shipping helper, actual
prepared-cache authorization and real client decoding through a test transport.
Native bytes retain independent CPU agreement; bitmap pixels match independently
normalized browser canvas output exactly. This does not verify production IPC,
photographic quality or native input. The [ledger](../../artifacts/detail-research/native-comparison-2026-10-28/summary.md)
preserves the two repaired test failures and unchanged native input/binary hashes.

Native presenter/sample/mask consumers, actual `PhotoPreview` wiring, public
settings/history/UI/MCP and real-source/full-size/performance acceptance remain
open. Settings remain **10/catalog 20** and public NR/detail tools unavailable.
No photograph decode, foreground window, benchmark or comprehensive checkpoint ran.
The remaining Goal 1 and Goal 2 scope stays active.

## CPU presenters and paired analysis samples: 2026-10-28

The private CPU presenter now forwards independently authorized Before/After
sources to the native client. A changed pair retires old bitmaps and generations;
a required missing Before cannot expose the filtered neutral plane. Identical
source hashes retain the ordinary single-source path. The unsupported-platform
JavaScript worker also reads distinct sources in sequential bounded strip streams,
validates their geometry/domain and releases superseded bitmap construction.
Existing rendering mathematics and native binary protocols stay unchanged.

The active analysis registry retains at most After/Before, each with normal/draft
samples, without copying verified planes. Publication notifies only that source's
observers; identical retained planes do not trigger another worker copy. New
selections discard obsolete planes and reject late publication. Retained histogram
bins are bounded independently per source. GPU comparison preparation publishes
its original samples through the same registry. Memory inventory deduplicates
shared sample/draft backing buffers and cache-owned planes, including retired
entries until their real fences settle. Samples retained after GPU eviction remain
charged to renderer and first-surface admission. No resource limit is increased.

The [focused checkpoint](../../artifacts/verification/2026-10-28T15-05-49.559Z-check-UXdoJl/summary.md)
passes **780 checks in 47.94 seconds**, zero failed/skipped/interrupted. Targets:
`hdr-cpu-comparison-ui`, `hdr-spatial-comparison`, `native-cpu-comparison-ui`,
`hdr-cpu-presenter`, `hdr-sample`, `hdr-source-cache`, `image-resource-owners`,
`image-resource-query-ui`, plus shared cheap/static/build checks. Node takes
17.07 seconds, above the fast-check aim. Counts overlap prior checkpoints.
Actual tiny CPU/GPU presenter cases cover Before/Split, point edits, range overlays,
aliases and independent source samples. Native bytes retain the existing CPU
agreement gate; canvas-normalized pixels match exactly. An initial test waited on
the previous paint during alias replacement; its exact repair and all later cases
pass without production math or tolerance changes. The
[ledger](../../artifacts/detail-research/paired-analysis-2026-10-28/summary.md)
retains the evidence and hidden-window cleanup audit.

Native Before clipping-mask authorization, actual `PhotoPreview` comparison and
analysis-source selection, public settings/history/UI/MCP and real-source/native/
full-size/performance acceptance remain unfinished. Settings remain **10/catalog 20**
with public NR/detail unavailable. Verification used tiny synthetic arrays and an
existing 128x96 generated PNG inventory case; no real photograph decode, foreground
window, benchmark or comprehensive checkpoint ran. Goal 1 and Goal 2 stay active.

## Native Before clipping masks: 2026-10-28

Private native mask requests may now include an exact edited-source capability
authorizing the original Before source. Main rejects another photo, mismatched
cache/hash, stale revision and use of Before lineage on an After request. It pins
and checks both cache entries independently, supplies neutral Before parameters
and closes both leases only after native processing drains. The result echoes its
After lineage; receiver validation rejects a mismatched receipt before fetching.
The native binary protocol, arithmetic and resource limits remain unchanged.

Acknowledged CPU source-pair ownership now recognizes Before only with the matching
After capability. GPU and CPU presenters reserve mask resources against the
selected original frame, rejecting the filtered frame in Before mode. CPU mask
publication hints include both sources. The analysis hook can carry the new
lineage, but actual `PhotoPreview` selection/wiring remains unfinished.

The [focused checkpoint](../../artifacts/verification/2026-10-28T15-23-34.672Z-check-6tiVXJ/summary.md)
passes **809 checks in 64.81 seconds**, zero failed/skipped/interrupted. Targets:
`detail-comparison-mask`, `detail-comparison`, `native-hdr-mask-controller`,
`native-cpu-comparison`, `hdr-cpu-comparison-ui`, `hdr-spatial-comparison`, plus
shared cheap/static/build checks. The new service cases use a 19x17 prepared HDR
fixture and the actual shipping helper, comparing every mask byte with independent
CPU analysis. Existing tiny native lifecycle cases and hidden 8x6 CPU/GPU cases
verify request compatibility, source selection and admission. Counts overlap.
The run exceeds the 60-second routine aim; its slowest source-pair case takes
5.96 seconds and Node takes 19.24 seconds. No assertions were removed or shortened.
The [ledger](../../artifacts/detail-research/before-mask-2026-10-28/summary.md)
retains this evidence, unchanged compiled native inputs and hidden-profile cleanup.

Application wiring, public settings/history/UI/MCP and real-source/native/full-size/
performance acceptance remain open. Settings remain **10/catalog 20** with public
NR/detail unavailable. No real photograph decode, foreground window, benchmark or
comprehensive checkpoint ran. All remaining Goal 1 and Goal 2 work stays in scope.

## Public detail controls and application adoption: 2026-10-28

Settings **11/catalog 21** now persist complete noise-reduction and detail groups.
Sparse public edit patches merge through the same validated main-owned edit API,
transactional writer and photo-wide Undo/Redo as other adjustments. Legacy catalog
17…20 histories gain neutral groups without dropping crop or creative settings;
current histories retain nonneutral detail settings. Inactive radius/threshold
edits remain authored history, while duplicate edits preserve the redo branch.
Point-only processing requests continue rejecting source-stage spatial groups.
MCP exposes the same bounded patch fields and capability ranges.

The Detail disclosure uses shared numeric/slider inputs for Luminance noise, Color
noise, Sharpening, Radius and Threshold. Gestures commit once on release/Enter,
Escape cancels and source preparation updates on commit. The library emits source
invalidation independently from ordinary point-color changes. Preview/export bind
saved controls to the existing source-stage filtering and cache identities; no
operator arithmetic, quality tolerance or resource limit changes in this step.

Actual `PhotoPreview` wiring requests an original source only while needed for a
filtered Before/Split comparison, verifies exact frame identity, and waits for both
float domains before presentation. Aliases reuse the existing source. Pending or
failed comparison has an independent **Show After** action; cancelled and late
replies cannot replace the active photo. Original Before analysis uses its own
sample and mask lineage. Retained canvases and overlays match the source pair,
mode, point settings and output target before reuse.

The [focused checkpoint](../../artifacts/verification/2026-10-28T16-24-16.529Z-check-9E7NL4/summary.md)
passes **805 checks in 71.60 seconds**, zero failed/skipped/interrupted. Targets:
`detail-edits`, `detail-history`, `catalog-migration`, `detail-edit-export`,
`detail-application-ui`, `detail-comparison-ui`, `crop-working-preview-ui`,
`hdr-spatial-comparison`, `hdr-cpu-comparison-ui`, plus shared cheap/static/build
checks. Node takes 20.86 seconds, Electron 22.17 seconds and the longest actual
application case 5.00 seconds. The routine run exceeds its 60-second aim; no
assertions were removed or shortened. Counts overlap earlier checkpoints.

The application fixture is an original opaque 19x17 PNG. Real UI/MCP operations,
production comparison IPC and actual canvas reads verify original Before/Split
pixels, a held-reply cancellation, foreign partial patches, Undo/Redo and restart.
Keyboard checks cover repeated-key single commits, Escape, invalid radius and
independent inspector scrolling with pinned histogram at native 1100 × 700 and
Console open. The export case uses real persisted settings, a built production
worker and actual 17x11 JPEG, freezing the old edit through foreground preemption,
retry and later live reset. Original bytes remain unchanged. Existing 8x6 actual
HDR GPU/CPU presenter cases verify paired-source compatibility; they do not
establish public HDR application acceptance.

The [ledger](../../artifacts/detail-research/public-detail-2026-10-28/summary.md)
retains the preceding failed attempts and exact repairs: an obsolete public-API
rejection assertion, hidden-window animation-frame stability in a keyboard scroll,
a held export that initially ignored cancellation, direct-TS worker-path setup,
and an invalid verification-scope registration. All relevant assertions remain.
All **18** checkpoint launches stayed background/nonfocusable, with zero show or
focus events/violations, closed windows and removed temporary profiles. No real
RAW, heavy full-size GPU workload, foreground input, benchmark or comprehensive
checkpoint ran. Compiled native inputs/binary stay unchanged; the previously
recorded JavaScript fallback-worker validation-reference hash mismatch remains
explicit rather than rewriting the old build manifest.

Real RAW/HDR/gain-map/merge application, native photographic/input, full-size
resources and source-matched performance acceptance remain pending. Standard
Lanczos3 enlargement, selective copy/paste/batch and combined acceptance remain
in Goal 1; all Goal 2 phases remain in scope. This checkpoint enables implemented
controls and does not accept either goal.
