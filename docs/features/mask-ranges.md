# Color and luminance range masks

[Issue #63](https://github.com/VaclavKlima/Irodori/issues/63) owns this extension.
The implementation has focused Bazzite acceptance and the local macOS qualification
below. Issue #63 records verified default-branch delivery separately from local acceptance.
Other-device and integrated-browser acceptance is tracked in
[#105](https://github.com/VaclavKlima/Irodori/issues/105).

## Selection contract

Color range and Luminance range are starting-coverage sources in the existing mask
tree. Each node has at most one generated base, gradient or range. Brush corrections,
ordered Add/Subtract/Intersect operands, result corrections, inversion and Mask edges
retain their existing order. Only the root applies Light and Color adjustments.
Changing a source explicitly preserves those corrections and operands.

Ranges evaluate an oriented canonical source before creative edits. Source
characterization and camera As Shot balance remain; global/local edits, crop, lens
corrections, noise reduction and sharpening do not change the selected source.
The existing geometry mapping carries coverage through crop, lens and flips.
Display mode and headroom do not redefine the selection. Sampling and coverage
use the same verified canonical source identity.

Raster preparation already provides Float32 linear sRGB; it is not decoded a
second time. RAW/merge and authored HDR use Float32 linear Rec.2020 with fixed
reference white already incorporated. An authored HDR photograph keeps that source
when its independently authored SDR primary is presented.

Merged HDR photographs retain the permanent verified Float32 master descriptor
when preparing the canonical source; the existing HDR owner copies that master
unchanged instead of attempting camera-RAW decoding. Ordinary edited preview
assets remain excluded. This routing correction is included in
[issue #110](https://github.com/VaclavKlima/Irodori/issues/110).

Color range uses one to five samples with shared Range and Softness. Magnitude-normalized
RGB is converted through the existing signed D65 Oklab coefficients. The relative
chroma pair `(a/L, b/L)` ignores positive brightness scaling. This versioned Irodori
metric is not a calibrated color difference. The nearest sample's distance `d` is
compressed to `d/(1+d)`. Range/100 is the fully selected radius; the outer smoothstep
radius is `min(1, radius + max(radius, 0.01) * Softness/100)`. Zero Softness is an
inclusive hard boundary, and Range 100 selects every valid color. Color is undefined
at nonpositive luminance or normalized Oklab L at or below 0.000001. A black sample
therefore directs the user to Luminance range instead.

Luminance range measures `100 * Y`: 100% is source white and HDR may exceed 100%.
Lower and Upper are inclusive nonnegative bounds; an unbounded Upper includes all
brighter values. Softness fades outward by `Softness/100 * max(Upper-Lower, 1)`
percentage points. With an unbounded Upper, Lower replaces the band width in that
formula. Negative luminance is excluded, zero is selectable, and nonfinite source
data is an explicit failure. Transparent pixels are excluded; fractional alpha is
not multiplied into coverage again.

## UI, history and Console

Both methods join Create mask and compound Add/Subtract/Intersect/starting-source
replacement. Coverage contains the selected range controls; Adjustments, overlay
choice, Paint/Erase and Mask edges keep their existing owners. Color offers sample
swatches, explicit add/replace/remove, Range, Softness and hexadecimal entry.
Luminance offers numeric Lower/Upper percentages, All brighter values and Softness.
Defaults are Range 20, Softness 25 and manual luminance bounds 25–75%.

Click sampling averages one clipped 7 × 7 native-pixel neighborhood in linear RGB,
weighted by alpha. Main maps normalized current-output coordinates to the canonical
grid using the confirmed geometry. Keyboard X/Y entry uses the same operation.
Brightness sampling starts a band of ±10% of the sampled value, with a minimum
half-width of one percentage point.

New masks and parts remain temporary until Create/Add/Replace. Acceptance is one
photo-wide Undo step; cancellation publishes nothing. Existing controls keep normal
continuous draft feedback and gesture/Enter/blur commits. Each sample edit is one
Undo step. Navigation, geometry/revision changes and native window blur cancel
unfinished sampling; pointer ownership remains shared with the existing tools.

`MaskRange` is a versioned discriminated source record, replaced as a whole in mask
operations. `replacePrimary: true` explicitly changes source kinds. Settings 19 and
catalog 29 preserve older masks and every history snapshot; older presets/frozen
jobs remain readable. Derived range pixels never enter durable settings.

The typed `sampleMaskRange` application operation and `irodori_sample_mask_range`
Console tool return relative-chroma samples and source-white brightness. Requests
bind photo, expected revision, rendering identity and a current-output point. The
Console's frozen request targets and revision conflict policy remain in force.

## Processing and verification

The existing isolated Dawn preparation owner derives native R8 range bases in
bounded strips. A separate resolved-only `preparedRangeBase` supplies the primitive
before brush/composition; `preparedCoverage` still replaces a completed subtree.
The existing WGSL/GLSL mask programs, native exact clipping classifier and frozen
SDR/HDR export consume the same prepared bases. There is no full-image TypeScript
classifier or equivalent CPU retry.

Source/algorithm/parameter identities allow reuse across unrelated edits. Current
revision and source checks still gate publication. Admission includes neutral
source preparation, strip buffers, derived coverage, encoded transfer and downstream
atlas/edge lifetimes. Existing limits and actual GPU/worker drainage remain in force.

### Preview storage admission — issue #110

[Issue #110](https://github.com/VaclavKlima/Irodori/issues/110) corrects false
storage refusals when the shared 2 GiB preview disk cache contains unused entries.
Range preparation reclaims eligible LRU previews before refusing its existing
reservation. Pinned streams, active previews and the photograph currently being
prepared remain protected. RAM/VRAM admission, GPU algorithms and storage limits
are unchanged.

Range and output-proof admission share a separate serialized storage owner; it
never waits on preview processing, which can itself request range coverage.
Pruning and reservation grants share that owner so concurrent callers cannot
claim the same capacity. After temporary decode files are removed, reservations
shrink atomically to the retained canonical source or PNG without a release and
reacquisition gap. Removal, failure and shutdown retain idempotent release.

A genuine storage refusal reports requested capacity, the disk budget, protected
previews, other range/proof assets and remaining cached previews. It recommends
closing unused comparisons/output previews or waiting for processing before
retrying; increasing the RAM/VRAM setting is not presented as a disk-cache fix.

Focused Bazzite acceptance has **1,080 distinct passing cases**, including **42
cases** across `mask-ranges-service`, `full-previews` and `export-proof-service`.
The final source-routing/static/build/range-service run passes 11 cases in
35.62 seconds; the preceding three-service continuation passes 41 in 2.80 seconds.
Applicable Node evidence is reused with the failed subprocess cases recovered
outside the sandbox; original failed reports remain failed. The consolidated
receipt records deduplicated cases and all constituent reports:
`artifacts/verification/2026-11-12-range-mask-resource-acceptance/summary.md`.

The reported 5438 × 3621 HDR master passes the actual application sampler and
temporary luminance coverage (Lower 35, unbounded Upper, Softness 35) after a fresh
development launch. Revision 0, settings and original Float32 SHA-256 remain
unchanged; diagnostic coverage is not published as a mask or history entry.
The application is left open with its previous Console conversation resumable.
This records Bazzite acceptance for #110; other-device qualification remains
in #105. No authenticated model retry or physical HDR
presentation claim is added.

Focused targets are `mask-ranges-model`, `mask-ranges-service`, `mask-ranges-gpu`,
`mask-ranges-ui` and `mask-ranges-output`, plus affected model/migration,
composition/edge, MCP, clipping and Sunflower regressions. Existing photographic
inputs are reused; no new photographic asset is adopted by this extension.

### Focused Bazzite acceptance — November 12, 2026

**1,142 distinct cases have passing evidence**, including 19 range-specific cases.
The 22-target runner passes type/lint/format/build and 1,037 Node cases; one legacy
migration expectation required current version 19 instead of 18. Its exact
corrected case passes 1/1. The original failed receipt remains failed. The same
selection continues through the unrun groups: **104 passed, zero failures/skips
or incomplete cases, 126.19 seconds**, foreground. Passed evidence is reused;
assertions, scope and quality gates are unchanged. The routine timing warning and
ten slowest cases remain in the receipt; the longest is existing RAW clipping at
26.30 seconds. No comprehensive checkpoint or benchmark ran.

Consolidated local receipt:
`artifacts/verification/2026-11-12-mask-ranges-acceptance/summary.md`, with linked
details, structured source receipts and accepted source/input hashes. These
ignored paths are local evidence, not downloadable GitHub proof. The passing
functional continuation is
`artifacts/verification/2026-11-12T13-14-54.082Z-check-cbX3mF/summary.md`.

Actual Dawn witnesses are RX 7900 XTX/RADV Navi31 and integrated Radeon 610M/RADV
Raphael/Mendocino with Mesa 26.2.6. Integrated numerical and photographic sampling
passes separately: **2/2, 3.71 seconds**. This does not qualify integrated browser
presentation. Runtime: Node 26.13.1, Electron 44.3.0 and Playwright 1.63.0.

Five actual forest leaf neighborhoods verify retained green coverage and rejected
neutral light at Range 10 without weakening photographic gates. Real Sony RAW
native pixels verify changes, outside identity, Before/After, Undo/Redo, source
registration through crop/rotation/straighten and restart. Temporary range previews
suspend confirmed HDR clipping and restore it after cancellation; cancellation
also preserves the previous workspace selection. Native screenshots, including
1100 × 700 with Console open, were visually reviewed and Sunflower fidelity passes.
Frozen raster/RAW SDR/HDR proof/export retains the existing two-code SDR and 0.02
HDR reconstruction gates through later edits and restart.

Current photographic captures use SDR presentation; physical HDR luminance,
calibration and authenticated model HDR vision are not certified. At that checkpoint,
macOS, Windows and integrated browser work remained incomplete in #105.

### macOS qualification — November 16, 2026

[#105](https://github.com/VaclavKlima/Irodori/issues/105) owns this bounded Mac slice.
It starts from clean published main
`4392a12b4766acd185e6ccb8d6d86b50993e5697`. The additions are qualification tests
and this evidence record; production processing and UI code are unchanged. The
new exclusive `raw-gpu` target `mask-ranges-merged` uses the committed three-frame
Sony ZV-1A forest bracket and the actual review/publication owners. Existing range
UI coverage now also checks sample replacement/removal, numeric Color Range and
Softness, and real RAW source sampling across a distortion change.

The device is macOS 26.7 (25G229), Apple M4 Pro, 24 GiB unified memory, bundled
Node 24.20.0, Electron 44.3.0 and Playwright 1.63.0. Dawn identifies
`apple apple-m4-pro`, Metal driver 26.7. The active browser WebGPU canvas records
vendor `apple`, architecture `metal-3`, an `rgba16float` Display-P3 surface and
standard tone mapping; Chromium redacts its device and description strings.
Electron independently reports ANGLE Metal on Apple M4 Pro. This is software GPU
presentation evidence, separate from physical display luminance. The accepted
checked native mask and C++ codec distributions from #122/#117 are reused and
validated by the application builds; no replacement runtime is adopted.

**1,161 distinct cases have passing evidence: 157 selected feature/regression
cases and 1,004 other cheap Node cases.** The 19-target foreground batch passes
1,139 cases, zero failures, in 171.39 seconds. It includes all five range targets,
the three #110 services, compound GPU/WebGL/UI/photographic checks, edges,
clipping, geometry and MCP. The subsequent migration/merged selection passes
all static/build stages, the cheap Node cases and 21 catalog migrations, then
fails its new adapter-description assertion after the functional assertions pass.
The corrected exact merged case passes separately. The two extended native range
cases also pass their exact reruns. Thirty-four actual-Linux-only Node cases
remain unavailable, so the runner receipts retain incomplete/failed statuses;
they are not relabelled clean invocations. Routine timing warnings remain.

The range checks retain one-to-five samples, brightness-independent color,
neutral/black/transparent behavior, numeric source-white bounds and unbounded
Upper. Create/Add/Replace/Cancel, nested corrections/edges, previous-selection
recovery and transient clipping ownership pass. Actual RAW pixels retain
Before/After, crop/straighten/quarter rotation, Undo/Redo and restart. Mapping the
same canonical point before/after disabling real Sony distortion gives identical
source identity, color and luminance; the chromatic-correction border remains.
The real bracket separately witnesses nonzero decoder orientation and lens
geometry; all eight decoder flips retain independent numerical/MCP mapping
coverage. The native 1100 × 700 Console-open range capture and cropped RAW capture
were visually reviewed. Sunflower reference/layout and warmed navigation evidence
from [#117](masked-navigation-performance.md#macos-qualification--november-16-2026)
and its #122 prerequisite are reused without repeating their accepted checks.

The genuine published v4 master is **3645 × 5465**, 318,718,800 Float32 bytes.
An independently read alpha-weighted 7 × 7 neighborhood measures **293.018732%**
source white. Sampling and temporary Lower 100/unbounded Upper coverage agree,
select the above-white location and preserve the complete initial history and
durable bundle hashes. Creative edits and SDR/HDR preference changes retain the
same source/sample/coverage identities. A 145 × 97 real crop bounds output work
while range preparation still uses the whole master. The local edit changes SDR
pixels by up to **67 codes**. Frozen SDR and HDR exports match their proofs at
**0 codes**, and independent HDR reconstruction differs by **0.004469**, below
the unchanged 0.02 gate. Undo/Redo, cache-clearing restart and restored proofs
preserve the accepted settings, source originals and durable merge bundle.

#110 cache tests verify reclamation, active/stream/lookup protection, in-preview-queue
admission, concurrent range/proof accounting, atomic shrink and idempotent release.
Genuine refusals retain their demand/budget/blocker diagnostics. Stale source,
revision and hash checks pass. Injected range-service cancellation is distinguished
from actual bundled-worker cancellation/timeout/retry and proof-decoder process
drainage in the affected worker/service checks. No full-size adversarial Mac
resource-pressure or mid-Dawn cancellation claim is added.

Local receipt, exact attempts, source/input hashes, adapters and launch/profile
cleanup: `artifacts/mask-ranges/2026-11-16-macos-qualification/summary.md`,
with linked `details.md` and `result.json`. These ignored artifacts remain local.
The new assertions initially needed floating-point and retained-border expectation
corrections. One native attempt failed to activate the Light tab after restart;
the unchanged exact case passes. The merged adapter-description failure is retained
alongside its corrected rerun. No production defect or processing-policy change
was required.

The accepted qualification tests and this record are included in this revision.
#105 maintains the verified publication receipt and stays open for Windows and
the separately named integrated-GPU browser qualification. Physical HDR/calibration,
authenticated model HDR vision, sustained performance and broader photographic
quality remain outside this slice. No comprehensive checkpoint or new photograph
was required for publication.
