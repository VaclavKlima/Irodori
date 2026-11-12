# Color and luminance range masks

[Issue #63](https://github.com/VaclavKlima/Irodori/issues/63) owns this extension.
The implementation has focused Bazzite acceptance. Issue #63 records verified
default-branch delivery separately from local acceptance.
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
calibration and authenticated model HDR vision are not certified. macOS, Windows
and integrated browser work remain incomplete in #105.
