# Whole-photo clipping with local masks

## Status and scope

[Issue #93](https://github.com/VaclavKlima/Irodori/issues/93) implements whole-photo
masked clipping with focused Bazzite acceptance and records default-branch delivery.
[Other-device qualification #104](https://github.com/VaclavKlima/Irodori/issues/104)
records the Mac receipt below; Windows and integrated Radeon browser
qualification remain incomplete.

The ordinary histogram already includes ordered local edits. This change concerns
clipping classification of the complete edited photograph, including enabled
brush, generated, gradient and compound masks and their edge modifiers. Selecting
a mask does not restrict analysis to its coverage. Regional or mask-ID analysis
remains [#59](https://github.com/VaclavKlima/Irodori/issues/59).

## Selected processing owners

The November 2 [processing policy](../gpu-processing.md) permits suitable existing
native arithmetic for a stage and treats execution hardware separately from
implementation language. The existing exact HDR clipping stage remains the
bounded Rust host with its C++ Float64 arithmetic. Its masked extension reuses
that stage's Light and color arithmetic before the existing content transform
and clipping predicates. It does not introduce a CPU mask-coverage renderer or
a second photograph-presentation backend.

Coverage remains GPU-owned. An isolated bundled-Node Dawn worker uses the shared
WGSL mask program, generated atlas and canonical crop/lens/flip geometry. Existing
whole-mask edge preparation supplies its qualified R8 coverage. Final analytic
and compound coverage is sampled as Float32 without another R8 quantization.
The sampler and exact classifier share the same active-root filter and top-first
ordering; the classifier consumes those roots in reverse order so the top mask
applies last. Neutral, disabled and zero-coverage operations retain their exact
bypass.

The earlier Float32 GPU clipping-classifier candidate failed exact white/headroom
boundary gates and remains rejected. Its retained receipts in the
[stage inventory](../processing-stages.md#qualification-and-stopping-decisions)
do not qualify a new classifier. This change preserves the existing predicates,
tolerances, above-white/headroom distinction and output-gamut meanings. Previously
unqualified active-curve combinations retain an explicit unavailable reason.

Authored SDR scans the existing raster GPU presentation program in bounded native
strips and classifies its encoded SDR endpoints. A source/pixel-key fingerprint
and actual R8 mask hash identify publication; hashing and the OR pyramid stay
inside the admitted renderer lifetime. HDR and raster receipts describe their
actual domains separately.

## Ownership, resources and invalidation

Main obtains confirmed history, resolved masks and authoritative geometry through
the existing prepared-source lease. Renderer-prepared coverage cannot authorize
different pixels or reduce admission: the shared memory plan strips it and plans
from authored coverage. The source, edit revision, Before/After lineage and display
target retain their existing checks before work and before publication.

The GPU worker streams final coverage in 64-row Float32 strips, interleaved by
pixel and active root, to one owned temporary file. Each strip and the complete
file carry SHA-256; main verifies coverage alongside the pinned source feed. The
native request binds the coverage identity and bounded local parameters. Native
classification consumes one source/coverage strip at a time. There is no retained
full-image Float32 coverage plane in RAM.

The shared admission includes coverage strips, mask descriptors/atlases, encoded
coverage and edge scratch in addition to existing source, native and receiver
owners. GPU work drains before its resources disappear; process cancellation
waits for actual child close. Native input, output and child close settle before
source leases or receiver reservations release. Temporary coverage files remain
inside the owned job directory and are removed on retirement.

New edits, mask enable/order/coverage changes, Undo/Redo, Before/After, photo
navigation and target changes invalidate their matching analysis generation.
Cancelled or stale work cannot publish a result for another source, revision or
target. Histogram availability remains independent of clipping failure.

The OR-reduced clipping pyramid preserves isolated events at Fit, including odd
source dimensions; 100% uses the corresponding native grid. A shared viewport
projection chooses CSS pixel centres and writes warning pixels directly instead
of fractionally rescaling a Canvas2D bitmap. This makes warning placement stable
through history and avoids backend-dependent edge rasterization. Its inexpensive
work is bounded to visible viewport decoration, not photographic processing.
Crop/lens geometry, pan, zoom and split comparison share the same projection.
Mask-coverage visualization and clipping visualization keep separate owners and
controls.

## Limits and verification record

Clipping describes the edited output under the selected target. It adds no claim
of sensor saturation, measured display luminance or true HDR model vision. Existing
source-saturation provenance stays independent, including unavailable values.
Broader analysis consolidation remains
[#69](https://github.com/VaclavKlima/Irodori/issues/69).

Focused Bazzite acceptance is complete for this local scope: **1,073 distinct
passing cases** across retained receipts, counting duplicate cheap/exact runs once.
The final runner passed **1,034 cases, zero failures/skips, 88.36 s**, foreground;
a final confirmed-snapshot memoization additionally passed typecheck, focused
ESLint, build and the exact RAW case (1/1, 26.71 s). No threshold or assertion was
cut to meet the routine timing budget; its warning and slow-case evidence remain.

Local consolidated receipt: `artifacts/verification/2026-11-12-masked-clipping-acceptance/summary.md`.
Its details retain initial failures and exact reruns; ignored local paths are not
downloadable GitHub proof. The `clipping-overlay`, `masks-clipping-coverage` and
`masks-clipping-ui` targets cover the new projection, coverage and photographic
cases. Existing native clipping, GLSL/histogram and source/receiver lifecycle
checks retain their original gates. Controller checks explicitly pin
`IRODORI_NATIVE_CPU_RENDER_TEST_EXECUTABLE` and
`IRODORI_NATIVE_HDR_MASK_TEST_ARITHMETIC_SHA256` to the verified built host; the
November 12 arithmetic receipt is
`d68759f2b7dacf76687e03c0a71260ea8c7c6e7ef09ebfa08497bdcb28f5700a`.

On Bazzite 45/Linux x64, Node 24.20.0 and Electron 44.3.0, actual Dawn witnesses
record RX 7900 XTX and integrated Radeon 610M/RADV Raphael/Mendocino with Mesa
26.2.6. The integrated pass covers sampling/reference/geometry/cancellation, not
browser ANGLE presentation. Native screenshots were visually reviewed, including
1100 × 700 with Console open and saved rotated/straightened raster masks through
restart. Current photographic cases use SDR presentation of HDR RAW and authored
raster; synthetic native targets independently cover HDR thresholds. This is not
physical HDR-display or model-vision certification.

Other-device verification remains incomplete in [#104](https://github.com/VaclavKlima/Irodori/issues/104),
which records macOS arm64, Windows x64 and integrated-GPU browser targets. No
comprehensive checkpoint or benchmark was run. Issue #93 records the published
revision and delivery verification separately from this local acceptance evidence.

## macOS qualification — November 16, 2026

[#104](https://github.com/VaclavKlima/Irodori/issues/104) records the available-device
slice on published baseline `7f06e7a9520415b1ddb3eaac4db7f8e43891a971`:
macOS 26.7 (25G229), Apple M4 Pro, 24 GiB unified memory, bundled Node 24.20.0,
Electron 44.3.0 and Playwright 1.63.0. Dawn and Electron ANGLE witness Apple M4
Pro/Metal. The checksummed accepted native mask host and C++ codec are reused;
compiled mask arithmetic is pinned to
`4b06d3580d9fcb9474e132c23ebe4b58d0633204d7b797c34252e9f0541ef473`.
Production processing, predicates, common backends and numerical/resource gates
are unchanged.

**65 distinct selected feature/regression cases and 1,045 other cheap checks
pass**, with no unresolved Mac failure. Thirty-four Linux-only native RAW cases
remain unavailable. Reconciliation retains the original failed/incomplete
invocations and exact recovery instead of relabelling them as clean passes.

| Accepted scope                                                        | Distinct passes |
| --------------------------------------------------------------------- | --------------: |
| Native predicate model, clipping projection and histogram lifecycle   |              23 |
| GPU Float32 coverage, geometry and cancellation                       |               2 |
| Existing HDR mask/histogram browser cases                             |               2 |
| Current #95 GLSL, overflow and stale histogram cases                  |               6 |
| Compiled native controller, capability and controlled child lifecycle |              25 |
| Genuine analysis-worker/receiver cancellation and digest drainage     |               4 |
| Real RAW, raster and actual foreground HDR clipping UI                |               3 |

The first 29 cases already had applicable Mac receipts, with relevant source,
test/helper, fixture and native executable hashes audited. Six browser cases reuse
the newly accepted #95 bytes. The
[new native/foreground selection](../../artifacts/verification/2026-11-16T19-40-07.993Z-check-VJDNx2/summary.md)
passes 1,099 cases but fails the new HDR test, with 34 unavailable, 176.55 s and
original exit 1. All 25 native service, four receiver and two existing clipping UI
cases pass; the repeated existing UI cases count once. Its ten slowest cases were
reviewed, retaining the duration warning and unchanged assertions.

The new HDR test initially waited for a target generation captured before
activation and retained an actual native target-change rejection. The observer
now records bounded real request/main-target/error diagnostics and requires a
reply matching the live display target and presented frame. All seven pixel
target fields, photo, revision and comparison remain exact. The failed case's
foreground rerun passes in 5.05 s, with no main/renderer errors; the earlier failed
attempt remains intact. No production recovery behavior or target fence was
changed. The successful diagnostic records 34 genuine requests: 30 cancelled,
four masks and no errors/omissions, through real generation 7→24 and headroom
1.715→14.644× changes. Each request matched the main target at admission. The
first attempt lacked those field snapshots, so its precise mismatch is not known.
This does not qualify sustained headroom changes or physical HDR output.

The formerly Linux-only controller/capability test guards now admit the already
supported macOS arm64 host. Compiled-controller cases still require the verified
absolute executable and actual arithmetic identity. Capability fixtures use the
current platform bundle path and Mac `-U__ARM_FEATURE_FMA` declaration. They remain
explicitly synthetic contract children, distinct from compiled arithmetic proof.
An independent owned-child `lsof` witness checks closed stdout/stderr while the
child stays alive; Linux retains `/proc`. Missing tools, permissions, timeout or
other witness failures cannot pass. Lifecycle tests retain real process/FD/read
drainage, error, cancellation, revision/target/budget and unpublished-scratch gates.

Real Sony RAW and rotated/straightened raster cases retain local Light/Color,
edges, Before/Undo/Redo, crop, Fit/100%, restart and scoped J coverage. The new
synthetic ISO gain-map chart separately requires an actual extended hardware HDR
target, a nonfallback `rgba16float` Display-P3 canvas and extended tone mapping.
The final Built-in Retina target reports 1800 × 1169 logical pixels/DPR 2,
14.6438296704× headroom, revision 1 and generation 24. Baseline and edited native
replies have different headroom, so their changed SHA does not isolate the local
Light/Color/edge effect. Isolated numerical/local-edit evidence comes from the
compiled and real-photo cases. View changes/toggles preserve source/history and
the independent histogram stays usable. The small
chart is not enlarged by Fit, so distinct Fit/100% geometry is established by the
real-photo cases rather than inferred from this chart. Captures establish layout
and warning placement, not calibrated physical thresholds or photographic HDR.
Active Texture and unsupported curve combinations retain their explicit exact
analysis/clipping refusals; no missing operator was silently implemented.

Local bounded evidence:
`artifacts/masked-clipping/2026-11-16-macos-qualification/{summary.md,details.md,result.json,reuse-audit.json,environment.json,visual-review.json,photographic-review.json,hdr-presentation.json}`.
Verified default-branch delivery of the qualification tests and this brief is
recorded in [#104](https://github.com/VaclavKlima/Irodori/issues/104), which stays
open for Windows x64 and actual integrated Radeon browser qualification. Live
signed-in Console/model HDR vision and physical calibration remain unverified.
No new photograph, benchmark or comprehensive checkpoint ran.
