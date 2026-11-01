# Professional editing checkpoint — 2026-10-30

This checkpoint commits the current implementation for continued work from another
machine. It is not a completed milestone or a release acceptance claim. The
[current task index](features/professional-editing.md) is authoritative; the dated entries below retain historical scope.

The app is **Irodori — Personal photo editing**. Source, native helpers, vendor
paths, debugging tools and tests use the renamed identity. Settings 11/catalog 21
currently persist inspector state, global Light and color controls, supported
Sony white balance, crop/straighten, eight-range mixer, three-way grading,
version 1 noise reduction, detail sharpening, selective copy/paste and bounded
batch edits. Standard Lanczos3 enlargement is explicit. The console is read-only.

Focused combined RAW/raster/ISO gain-map/genuine v4-merge edit-export-restart,
native keyboard/minimum-size, source/resource checks and selected SDR/HDR
responsiveness checks have retained local evidence. The pre-push reviewed-input
combined run passed 787 checks in 101.2 seconds; the selected HDR responsiveness
retry passed 48 trials in 191.27 seconds. These scopes overlap and are not a full
checkpoint. Detailed limits and dated evidence are recorded in
[the processing ledger](features/professional-editing-processing.md).

The later idle-desktop continuation passes the functional RAW picker, opened
dropdown lifetime and full-size SDR/HDR enlargement with reviewed inputs; see the
[dated records](features/professional-editing-processing.md#idle-desktop-native-and-full-size-acceptance--2026-10-30).
The three missing representative creative HDR configurations also pass: compact
Console 60/120 Hz and wide 60 Hz, 144 trials in total. The wide focus-loss attempt
is retained separately from its unchanged passing retry. Actual cadence,
missing individual presentations and scope are in the
[new performance record](features/professional-editing-processing.md#remaining-creative-cadence-configurations--2026-10-30).
Goal 1 remains open for stronger photographic noise removal, measured-neutral
accuracy and remaining sustained acceptance. Goal 2 curves, named presets, output-size proof/output
sharpening and optional FSR evaluation remain pending. Keep masking and separately
scoped backlog work outside this checkpoint's acceptance claims.

The current stronger-NR work is **research only**. The portable equations,
synthetic cases, frozen gates and independently checked Decimal80 reference are in
[scripts/research/strong-noise](../scripts/research/strong-noise/README.md).
Both remaining fixed-width C7 candidates subsequently failed the reserved sigma
.10 colored edge. The two C8 noise-scaled candidates passed the first screen and
old nominal/regression cohorts, then failed the mandatory fresh texture cohort.
**All executed candidates remain rejected under their declared quality protocols.**
Failures and original thresholds are preserved; passing numerical references do
not establish photographic quality. No candidate GPU port, public NR version 2,
settings/catalog migration or method selector is integrated. Existing v1 edits
must keep their original meaning and pixels.

The CPU source-wide noise-estimator foundation is committed with admission,
cancellation and independent Python agreement tests, but no production processing
path selects it. Its source identity/hash are supplied by a caller-owned verified
source lease; the estimator does not authenticate source bytes. Keep the complete
source estimate frozen across tiles, crops and zoom levels when integrating later.

The initial next research direction was a separately declared larger texture population:
the failed small C8 chart's entering noise already exceeds its clean-relative
amplitude ceiling. The optional population geometry helper in `cases.py` is an
unfinished foundation at that checkpoint. Later C9 through C14 protocols,
qualification, arithmetic and rejected quality screens are recorded below.
Before any new filtering, freeze a separate
protocol and qualify every fresh input without importing candidate code; retain
all accepted original small-chart regressions and every C8 failure. Do not change
noise, amplitudes or acceptance limits to obtain a pass.

Four privacy-reviewed fixture sets are committed unchanged: fog/dogs, a genuine
Sony exposure bracket, ISO 400/6400/12800 carpet captures, and the ISO125 functional
white-balance original published in commit `3067fd8796408b5bd970e884a2c798ac32b6037e`.
Their manifests retain
hashes, privacy review and limited project-repository permission. Automatic lens
correction prepares the carpet sources at 5422 × 3622; the earlier 5496 × 3672 privacy
decode grid is before that correction. ISO 400 is a lower-noise companion, not
registered/calibrated clean truth. Regenerate working assets from the committed
originals on another machine; generated assets and local evidence are excluded.

Use Node 24 LTS and npm, preserving the lockfile:

```sh
npm ci
npm run setup:electron
npm run dev
```

`npm run dev` opens the normal app and enables development MCP only on
`127.0.0.1:9222`. Production debugging stays disabled. For verification choose
explicit registered targets through `npm run verify -- --target TARGET`, use
isolated hidden profiles by default, and coordinate foreground desktop checks.
Do not run automated imports against a personal library. Comprehensive checks
still require a separately agreed checkpoint.

Screenshots, benchmark outputs, working-image caches, private/excluded historical
photos and local diagnostics remain outside Git. Source-only research is
committed so an offsite feature does not depend on this workstation's artifacts.

The pre-push invocation on 2026-10-30 selected
`professional-editing-acceptance` in background mode: 787 passed, 0 failed, 0 skipped
in 101.2 seconds, including type checking, lint, formatting, build, fast Node
checks and the combined real-source cases. The portable research runner also
reproduced one prior synthetic source/output SHA exactly. No comprehensive
checkpoint was executed.

Subsequent focused verification selected `strong-noise-reference` plus
`strong-noise-scaled-reference`: 790 checks passed in 100.84 seconds, including
all 15 independent numeric recipes for fixed C .040 and both C8 factors. The
separate `strong-noise-estimate` selection passed 793 checks in 41.61 seconds,
including eight estimator cases. These selections overlap in their cheap checks.
They use CPU-only synthetic data and do not certify candidate GPU processing,
photographic quality, full-source estimator throughput or other platforms.

The final publication check combined all three targets in background mode:
**798 passed, 0 failed, 0 skipped in 100.20 seconds**, including type checking,
lint, formatting, build and fast Node checks. A separate source-only comparison
also preserved all 352 existing nominal/regression/fresh recipes exactly against
the earlier published checkpoint. No comprehensive, GPU or foreground check was
added to this publication scope.

## Resumed editing work after camera verification — 2026-10-30

Camera fixes are published on main at `5cafbdd`. The pinned Linux runtime and
actual seven-tool Codex connection support the focused Sony single-RAW workflow
documented in [camera control](camera-control.md); broader Linux camera acceptance
remains explicitly scoped there. The fourteen saved research paths were restored
on `codex/professional-editing-precision`, preserving the independent archive and
stash. The verification-plan merge retains the new camera targets.

The restored C9 work adds prospective input qualification and an unenabled GPU
research owner/child. Its qualified fresh population passed on CPU, and all 64
GPU outputs matched those frozen CPU results. However, the later interrupted
high-noise matrix already contains four mandatory edge failures. Exact archived
CPU replay now reproduces all four, including a passing input that worsens from
2.56% to 4.17% leakage against the fixed 3% limit. The k .55 policy is rejected;
do not restart that matrix or adopt it from its earlier fresh-population pass.

Continue from the [rejection record and next-policy rationale](features/professional-editing-processing.md#strong-noise-c9-high-noise-rejection--2026-10-30).
Preserve the actual failed source/output bytes and old declarations; source-pin
changes require a new frozen epoch. Stronger NR, equivalent recovery, legacy edit
meaning, photographic quality and sustained/resource acceptance still gate
Goal 1. Goal 2 and masking remain in their accepted later order.

Subsequent work rejected the separate C10 patch-mean guard: its independent
Decimal80/rational helper passed 844 statistics configurations and 45 guard
checks, but all four known edge cases still exceeded the unchanged 3% limit.
The newly frozen C9 k .40 eight-case GPU screen also failed four required edges;
archived CPU replay reproduces those failures with all channels inside the fixed
GPU agreement bound. Both C9 noise-scaled policies and C10 are rejected. Stop
their matrices rather than select favorable subsets or relax thresholds.

The focused `strong-noise-mean-guard` target plus shared checks passed **875 tests,
zero failures/skips, in 54.2 seconds**. This verifies the helper and existing
regressions, not denoising quality. See the later rejection sections in the
processing ledger. The subsequent C11 chroma-only uniform spatial policy passed
the independent full-operator target (875 checks including shared checks in
69.92 seconds), but its separately frozen eight-edge CPU stage failed four
unchanged leakage gates in 69.832 seconds. C11 is rejected; do not run its later
stages or unexecuted GPU tests as adoption evidence. The separate
[C12 wider-chroma policy](../assets/tests/references/detail/strong-noise/chroma-wide-search.md)
tests radius10 chroma support while retaining luminance's radius3 Gaussian
behavior. It requires independent arithmetic and a new freeze before filtering.

At this earlier checkpoint, independent Goal 1 acceptance work remained:
real-RAW native picker interaction, actually opened Linux dropdown lifetime,
compact/Console 60/120-Hz and wide 60-Hz creative cadence, and full-size HDR
enlargement. Prior general native keyboard/scrolling and full-size SDR receipts
remain valid for their exact scopes. Do not rerun the old native/full-size tests
against their historical excluded Sony fixture. Both test sources now refer to
reviewed committed `DSC03280.ARW`, with Git HEAD/tracking and original-hash
checks. At that point neither migrated suite had a new receipt; the later
full-size selection now passes, while `professional-editor-native` has not been
rerun on its replacement source. Two measured-illuminant neutral photographs
also remain a distinct picker criterion; synthetic D50/D65 and native functional
use cannot stand in for that physical evidence.

The new explicit-only `professional-picker-native` target initially used reviewed,
committed `DSC03280.ARW`, then tried reviewed ISO400 carpet/blank-paper
`DSC03483.ARW` after bounded fixture-suitability checks. Its native functional
acceptance was incomplete at that point; neither scene supplies a measured neutral target.
The foreground registered selection finished **871 passed, 1 failed, 0 skipped
in 64.70 seconds**, stopping at strict native focus loss after isolated import
before picker sampling:
`artifacts/verification/2026-10-30T13-28-04.519Z-check-zbxEe0/summary.md`.
That first focus-loss cause remains unproved. An unchanged exact-case retry
failed at the same guard (**0 passed, 1 failed, 5.69 seconds**):
`artifacts/verification/playwright-1793367023170-5eddfb75-9d38-4b46-8efd-db184342ceb2/playwright/summary.json`.
It recorded unsolicited trusted `d` events and a `w` release during import.

Startup and restart now follow the existing native suite's order: assert profile
isolation, settle minimum-size native/renderer bounds, establish native focus
once, then require one second of stable geometry/focus before Console/import.
The exact-case setup-order retry failed earlier, during that precondition and
before any test input/import (**0 passed, 1 failed, 2.50 seconds**):
`artifacts/verification/playwright-1793367273915-2efc5975-e965-4f0d-ab59-55c22775151a/playwright/summary.json`.
Unsolicited trusted `a` events and `s`/`a` releases establish external desktop
input in this retry too. Keep all failed evidence; do not infer a product focus
defect or a picker pass from these runs. Processes closed and isolated profiles
were removed. The test-only cleanup improvement preserves the original failure and
attempts evidence writing even after an early precondition/observer failure;
successful completion still checks trusted input in both sessions. No production
or shared helper behavior, native focus guard, validity threshold or history
assertion changed. Valid proposal, pointer, Apply/history and restart remain unverified
by this target; the separate two-measured-illuminant physical criterion also
remains open.

The subsequent explicitly idle desktop window produced three further exact-case
failures, each **0 passed, 1 failed, 0 skipped**, with all recorded native focus
guards passing and no unsolicited keys. The original eight fog positions took
**5.64 seconds**, all `uneven-sample`:
`artifacts/verification/playwright-1793368093806-f4ccce27-2f59-4dda-ae8e-9d6343e99294/playwright/summary.json`.
A frozen row-major 12x8 integer-percentage grid at diameter 31 then took
**6.97 seconds** on the fog original (95 `uneven-sample`, one `dark`):
`artifacts/verification/playwright-1793368296633-5a6e4ab3-057c-4f7a-b677-25a62a09540b/playwright/summary.json`.
The same grid on `DSC03483.ARW`, SHA-256
`7e6e048962eacf890ef8bfb04fcadb5ac42e578bc5b67aa7912f08281975569f`,
took **7.08 seconds**, all 96 `uneven-sample`:
`artifacts/verification/playwright-1793368363618-a6155748-17e0-4d9b-b960-f71c4302bfa5/playwright/summary.json`.
The two grids' minimum scatter values were 0.047389 and 0.065338 against the
unchanged 0.04 limit. Exact sample-area agreement and unchanged history pass for
these invalid read-only proposals. All processes/windows closed and profiles
were removed. Preserve the invalid receipts; source selection was functional
fixture suitability, not photographic-quality selection. The desktop was handed
back; do not launch further foreground cases without a coordinated idle window.

Static inspection finds consistent strip strides, source-space/unfiltered
sampling and matching Rec.2020 camera-matrix composition. The scatter gate tests
per-pixel 90th-percentile log-ratio deviation rather than noise of the patch mean;
larger patches do not average that metric down. These proposals fail before the
Kelvin/Tint solver. Genuine noise or scene variation is plausible, but a
preparation/CFA defect has not been ruled out. The retained ISO400 preparation in
`artifacts/professional-editing/patchwise-integration-prep-20261030/carpet-source-preparation-v2/declaration-j9LFiu/run-5rxsYf/DSC03483/linear.f32`
matches the picker source SHA-256
`2e31c59ed18d3415e309fb68df61299e8b56f8f03690762569fddbef857d9aa9`.
The authorized bounded CPU replay of all 96 ROIs verifies the source/strip hashes,
direct/strip row bytes, geometry and all rejected/inlier counts; scatter agrees
within 4.44e-16. Independent matrix inversion/composition errors are at most
2.22e-16/5.55e-17. Three visually selected paper patches retain scatter
0.08541/0.10387/0.11470 after excluding dark/clipped/invalid sites; linear trends
and parity-mean offsets do not explain that variation. Raw observations,
coefficients and hashes are retained at
`artifacts/professional-editing/picker-uniformity-20261030/run-s8a4kguj/report.json`
(1.61 seconds). The earlier diagnostic-script NameError and partial observations
are preserved separately.

The already decoded, hash-verified LibRaw 0.22.1 linear camera-RGB16 frame shows
similar paper scatter, 0.07128/0.09655/0.10477:
`artifacts/professional-editing/picker-uniformity-20261030/cpu-companion-0ta542ux/report.json`
(0.10 seconds). Its native geometry differs from the corrected app source, so
these are normalized scene regions, not registered pixel pairs. This supports
real RAW/demosaiced chroma variation under the current per-pixel uniformity rule,
not a picker-only stride/matrix defect. It neither identifies all variation as
sensor noise nor validates physical neutrality. No fresh RAW decode, GPU work,
8-bit camera-JPEG validity comparison, threshold or production change ran. Valid
proposal/native Apply/history/restart acceptance remains open.

## Latest continuation — 2026-10-30

The registered `strong-noise-chroma-wide`, `jpeg-ycbcr-fullsize-reference` and
unchanged `jpeg-ycbcr-reference` selection passes **880 checks, zero failures/
skips/interruptions, in 90.53 seconds**. The routine duration warning remains
explicit. Summary:
`artifacts/verification/2026-10-30T14-26-46.807Z-check-yqmwiH/summary.md`.
C12's 120/84/12/180 independent numerical configurations and wrong-operator
checks pass as mathematical proofs; the later quality rejection is below. Its separate
candidate-free freeze binds 178 pins/39 archived copies and 44 examined inputs:
`artifacts/detail-research/strong-noise/c12-chroma-wide-screen-zmxaqv83/freeze-cowbzvrh/declaration.json`,
SHA-256 `27f7538061c6a0af8d46ba48f16912c94855e6581912afa5078b8acf783cc663`.
Root reviewed the driver and independently rehashed all pins/copies before
authorizing only the complete first eight-edge stage at nice15. That stage
completed8/8 in700.397 seconds with two required leakage failures (3.95% versus
the unchanged3% limit), rejecting C12. Other six cases/edge gates pass. All
outputs/pins/copies are verified, the worker has exited and the owned lock is
released. No later stages or GPU work ran. Summary:
`artifacts/detail-research/strong-noise/c12-chroma-wide-screen-zmxaqv83/run-edge-regression-nn9o_0u7/summary.md`.
Do not continue C12's rejected matrix or infer production cost from this Python
research run under game contention.

The migrated full-size suite now includes a separate HDR case with explicit
3 GiB managed RAM, unchanged fixed caps, and streamed independent reconstruction.
The full-size case was unexecuted at that checkpoint; its later passing receipt
is recorded below. The small CPU/WASM-only
`professional-enlargement-hdr-reference` target now passes all four service
cases: **875 checks including shared checks, zero failures/skips, 53.08 seconds**.
Summary: `artifacts/verification/2026-10-30T15-13-01.261Z-check-D6Vhld/summary.md`.
The positive 13x129 chart checks every one of 10,062 RGB components at two
headrooms against the unchanged `<0.02` bound, including stripe boundaries.
Earlier failures are retained: typed assertion, missing container subsampling
metadata, and unsupported Sharp raw-to-file calls. The final helper inspects
the actual primary's metadata and independent sampling headers, then uses a
bounded isolated RGB8 writer; compatibility/gain checks remain intact.
The five JPEG transport cases, including real wrapper-descendant retirement,
also pass in `2026-10-30T14-43-03.749Z-check-hxtJky`; that combined run's one
failure was the earlier HDR helper metadata assertion. These small proofs do
not establish full-size export, admission, photographic or GPU acceptance.

The user prepared a new light surface through the connected camera. Two actual
ISO125 captures and shutter-free failed preflights were retained privately under
`artifacts/professional-editing/picker-paper-capture-20261030/` and the referenced
camera operation directories. The first preview shows printing through paper.
The adjusted second preview fills the frame with a light textured surface and
was selected for complete review; it is not a calibrated neutral.
Second original: operation `f0a9346f-17ad-47b8-9b19-8a05af6af5e3`,
`capt_DSC07247.ARW`, SHA-256
`8a2e09a6798e303ea2a991139dbc50245aedc218bffe11d614f307b93d7b1cfb`.
Both embedded images and all 2,139 exposed metadata fields now have an
independent light privacy receipt:
`artifacts/professional-editing/picker-paper-capture-20261030/scene-2-independent-light-privacy-review.json`.
Hashes/embedded byte intervals match; no recognized personal fields or visible
printing were found. Complete native overview and six contiguous full-resolution
tiles subsequently passed root and independent review. The second exact original
and its notices/manifest are now committed and published on
`codex/white-balance-functional-fixture-20261030`; the first capture stays excluded.
The native RAW picker selection passed 872 checks in 53.45 seconds, including
Apply, history, restart and As Shot at minimum size. Summary:
`artifacts/verification/2026-10-30T17-56-47.992Z-check-Pgdcs1/summary.md`.
The 31-pixel/96-position policy and all validity limits remain unchanged;
two measured illuminants and physical neutral accuracy remain open.
An ISO restoration readback timed out; explicit same-serial recovery then
verified original ISO12800, exposure compensation0, Automatic focus and ProgramP.
All sessions are closed and final discovery reports zero pending recoveries.

Earlier on 2026-10-30, the user returned to **Witcher**, restricting work to source
changes and light hidden CPU checks at that checkpoint. The user has since
explicitly made the desktop and GPU idle and available again; that hold is no
longer current. Native, full-size and performance checks retain their separately
selected scopes and guards.

The `professional-dropdown-native` test is now published and registered
(`raw-gpu`, exclusive, explicit-only). Three isolated cases require an actually
open Aspect ratio popup through 3.3 seconds, genuine option/Escape/outside-click
routes and resumed native refresh. All three cases now pass: 874 total checks,
66.35 seconds, no failures/skips, in
`artifacts/verification/2026-10-30T17-49-37.769Z-check-plMJxa/summary.md`.
The first run's interaction bodies passed but teardown retained a crop draft;
test-only guarded cancellation fixes cleanup. Setup also requires stable actual
native/renderer geometry before input. Prior failed artifacts remain preserved.
Production Wayland refresh code stays unchanged; retain an actual red foreground
production reproduction before changing that workaround.

The reviewed-input full-size enlargement selection also passes: 873 total checks,
119.55 seconds, both SDR and HDR cases, in
`artifacts/verification/2026-10-30T17-54-34.524Z-check-REYTHL/summary.md`.
It checks 1.25x 6870x4590 export, frozen settings and restart, the fixed-cap 2x
refusal, and independent full-image HDR reconstruction at two headrooms.
This does not establish sustained throughput, contention or physical HDR.

The cheap retained C11/C12 diagnosis reproduces final leakage and locates the
failure in the recovered chroma target before luminance-scale coupling, with
publication uncertainty far below the failed margin:
`artifacts/detail-research/strong-noise/c12-retained-inverse-diagnosis-vvur2nm4/summary.md`.
The new [C13 matching-context declaration](../assets/tests/references/detail/strong-noise/chroma-matching-context.md)
therefore tests 5x5 chroma matching with the same 3x3 target stage, original
luminance arithmetic, fixed coefficients and all 44 inputs. Its declared order
is 2 known failing edges, 6 other edges, 24 flats and 12 textures, with every
later stage conditional on complete passing earlier receipts. The CPU and
independent Decimal80 source/tests are now published. Root and independent
source review passed before the explicit `strong-noise-chroma-context` run:
**875 checks, zero failures/skips, 179.78 seconds**, summary
`artifacts/verification/2026-10-30T15-45-08.741Z-check-hXdh0Y/summary.md`.
All four math groups and five numerical counterfeits pass. Exact whole-grid L
coverage counts also match the declared dimensions/controls. The separate input
audit verifies the same 44 records/estimators/metrics and every original input
hash; receipt `artifacts/detail-research/strong-noise/c13-independent-selection-0WsAFQ/receipt.json`.
The new driver and candidate-free freeze have now passed root and independent
review: 196 pins, 58 archived copies, exact original 44 records. Declaration
`artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/freeze-g0ztad7n/declaration.json`,
SHA-256 `9c6266be05f86f406cc089efaf1d86142f4ee33bb4148b6f16db4ba646b5a52d`.
The first hard-edge stage completed **2/2 in 182.882 seconds**, zero required
failures, leakage `0.029942189484229685` / `0.029942153910216943` against `0.03`.
Output `artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/run-hard-edge-regression-k_cwlgz3/`;
summary SHA `4decac0cbff4e789c592b5552b80ce2faaa721463dd9b4de240dbecafd0c836e`.
Root and independent terminal audits verify all pins/copies, outputs and cleanup;
independent metric replay matches exactly without filtering. Session25620 and
PID275312 have exited, and that stage's owned lock retired.

The remaining six edge anchors have now completed, output
`artifacts/detail-research/strong-noise/c13-screen-draft-6l17zm95/run-edge-regression-anchors-4zdu9350/`.
**6/6 in 563.382 seconds, four required leakage failures** (rows 0/1/2/3).
Rows 4/6 and all non-leakage edge gates pass. Summary SHA
`fd86f2e27d62de98c99f51291545c7544d00cc4848a5af5e53334c6b83ae0361`;
exact passing prior hard receipt above is intact. Root and independent terminal
audits rehash 196 pins/58 copies, all eight output frames and exact source/
estimator identities; independent metric replay agrees exactly. Session20103
exited 1 for expected quality rejection, PID276988 is gone and the shared lock
is absent. **C13 is rejected**; do not run later flat/texture stages or GPU as
adoption evidence. No owned quality/verification process from these runs remains
active. The two hard passes stay valid only for their exact scope.

The retained C12/C13 inverse diagnosis is complete:
`artifacts/detail-research/strong-noise/c13-retained-context-diagnosis-d1cevr9s/diagnosis.json`,
SHA `0675315c8c25aa323fee5d65e0c35800264e35b4c166e06dfd2a17ca864e2059`.
It locates row 0's failure in a chroma target that retains almost all the entering
column bias; inverse coupling is small. L, inputs and estimates remain intact.
The clean geometry of matching5/target3 removes a flat-side center family from
both first edge columns, unlike matching3/target3. Actual weight mass is now
measured by the reviewed diagnostic, source SHA
`c27608fa79ce675efeeae96a3ab1853d89debaf6f923a5d70bdfb372ea2599db`.
Report `artifacts/detail-research/strong-noise/c13-boundary-effective-weights-draft-20261030/run-1024-owners-v1/diagnosis.json`,
SHA `5a053128643fd85bc760ee727aa9d9673526f4d90fc036966c38864f6728c48d`.
It passes 1,024 owners/2,048 components in about 16 seconds at nice15, no filter
imports or alternate RGB. Root and independent audit verify all 322 pins,
reconstruction/decomposition bounds and signed class partitions. Row 0 right
same-column mass rises 66.13% to 98.23%, other same-side columns fall 32.00% to
0.86%, Neff 29.01 to 14.11; cross-edge mass also falls. This supports lost
horizontal averaging plus conditional noise, not increased clean cross-edge
transport. Neff is descriptive and the envelope is not a formal libm certificate.
Exec session49304 exited 0; no owned test/quality/diagnostic process remains
active, and the shared lock is absent.

The C14 declaration is `comparison14.json` and
`assets/tests/references/detail/strong-noise/chroma-full-patch.md`: change only
chroma estimated target/gather 3 to 5 while retaining C13 matching5/search10/k.4/
frozen estimate/inverse, original L3 and every gate. Active stage59=L9+C50,
source halo14 / combined sharpening23; proposal bounds stillL3/C10. C0 literal
old C9/27-word bypass remains, including the neutral no-stage case. First stage
rows0/2, then other6[1,3,4,5,6,7], 24 flats and12 textures retain all44 records.
New numerical groups144/84/12/180 add31x9 owner12,4 context marker26,4 (halo14).
Root and independent policy/input/evidence review preceded generation. The
terminal quality screen below rejects C14.

At the source-only checkpoint on 2026-10-30, denoise_integration_prep drafted CPU+TS in
`artifacts/detail-research/strong-noise/c14-full-patch-owned-draft-bGyLwrPj/`;
patchwise_prototype drafted independent `reference/chroma-full.py`. Publication,
generation and filtering were still unapproved then, and the earlier Witcher
restrictions applied. The subsequent approvals and terminal results follow;
public NR v1 is unchanged.

The initial C14 CPU and TS drafts received root/independent review after only
AST parsing and TS formatting. CPU SHA
`23249002978a720f5b0230761610c2350732547ee227ddec8e021af96be766ad`;
TS SHA `6e579d9625f30938a39db7293852a92d8625b16e4afc7c85b43f82240d9ca626`.
CPU keeps the direct C13 pad2-to-pad1 L prefix path, separate L9/C25 targets and
gathers, physical59 active stage and exact C0 old route. The reference draft was
pending at that source checkpoint. Canonical scene is `full-target-context-halo14`, `stageScalars:59`,
`stageLayout:l9-row-major-c25-ab-row-major-v1`; target1/halo13 counterfeits require
strict pre-final or final RGB failure at that scene. Updated policy clarifies
those metadata names and neutral C0's absent physical stage. All three sources
required review before publication and numerical generation; the isolated
drafts were not executable against missing shared modules.

The independent CPU review found a pre-publication diagnostic defect in the
above CPU hash: bandwidth variable `base` is shadowed by stage offsets, reporting
baseMaximum9 instead of .024. Pixel hC is computed before that shadowing, but
the provenance field must be fixed. The author has corrected only that naming
issue and prospectively raised service hang ceilings to900s/test and600s/command
for larger references, with every assertion/count/gate retained. Revised CPU SHA
`780e2bf713f43da251bc046fbbe59eccb44686bde7b02bc4a4808d0021e15b5c`;
TS SHA `162df74fb2513392e126c9a26db9c21978d1de8f5567bc9c7ac83f2d9f0910ba`.
Static parsing passed before numerical execution was approved. Earlier draft
hashes are superseded. The reference author also sized its bounded
direct-patch cache to64: C14's new target support needs33/35 centers in existing
wide/noise scenes and would thrash the inherited32-entry cache. Per-primary cache
clearing remains required. No runtime result or performance claim follows from
these source changes alone. The subsequent source review and results follow.

C14 CPU/test source review now passes at the revised hashes above. The separate
Decimal80 reference also passes root/independent source review, SHA
`8e2ad85757fa7964f27bcdf046d09949778ae07c0110eb32c608483b1e4743c2`.
All three exact files are published; `strong-noise-chroma-full` is registered
as an explicit-only exclusive service target. Artifact-free selection and
four reference plans pass (144/84/12/180), without candidate import. Root approves
only small mathematical generation/comparison and six numeric counterfeits:
`artifacts/detail-research/strong-noise/c14-root-math-approval-ou_2nw29/approval.json`.

That target now passes **875 checks, zero failures/skips/interruptions,410.57s**;
read summary `artifacts/verification/2026-10-30T16-56-39.996Z-check-yH2Yor/summary.md`.
All four service cases/six negative checks pass; routine duration warning stays.
Counts: 2,088 pre-final/final RGB,226,678 exact semantic stage words,87,750 raw
C0 old words; whole-grid L15,156 proposals/114,300 stage words including active
C9,450/85,050. Exact plan-derived count audit passes. Session10506 exited0 and
its invocation lock retired. No C14 quality acceptance follows from this math.

C14 independent input selection audit passes with all 44 exact C12 records,
88 input/44 old-output hashes, three streams and six evidence files unchanged.
Receipt `artifacts/detail-research/strong-noise/c14-independent-selection-urVLkr/receipt.json`,
SHA `9c719a2d53d1adbc0550e4976926ab0f6c828a6bfe7b2a96044fa34ecb4c8a39`.
The C14 driver passes root/independent review at SHA
`9aa3e1fb46e797676c76274d0e233ab438b9f11f792147ed9f88b7ae10623c46`.
Its plan and candidate-free freeze pass. Declaration
`artifacts/detail-research/strong-noise/c14-full-patch-screen-draft-kzUT9uyq/freeze-7qi1e42r/declaration.json`,
SHA `28ed367db91614ab5052687859db095c3ace95759f11a1efda0dc7fab80edc24`:
202 pins/64 archived copies independently rehashed; all44 records and math proofs
match, six rejection/diagnosis files included.

**C14 is rejected.** Its first quality stage completed **2/2 cases in
264.406 seconds**, on one CPU worker at nice15. Output:
`artifacts/detail-research/strong-noise/c14-full-patch-screen-draft-kzUT9uyq/run-context-edge-regression-h8gqmt_m/`.
Rows 0/2 fail the unchanged `edgeLeakage <= 0.03` gate at
`0.031373091629910886` / `0.03137312234449121`. Both output hashes, all 202 pins
and 64 archived copies verify unchanged. Cleanup confirms the owned lock
retired, zero child processes and no execution error. No later 6/24/12 stage or
C14 GPU port follows. The 875-check/410.57-second mathematical pass remains
valid for arithmetic only; public NR v1 and every earlier failure remain
unchanged. All 44 examined records remain required for any full screen pass.
The user has explicitly made the desktop/GPU available again; the earlier
Witcher hold no longer applies to separately selected checks.

Source-only resource note:
`artifacts/detail-research/strong-noise/c14-gpu-resource-forecast-20261030.md`
SHA `b7d4c986aea3c26d3a091578713779d1f9e240c4e5143f91cc769001efeccbba`.
Uniform59 stage at256tile forecasts20,631,872 GPUbuffer bytes /22,971,072 working
bytes; input/features284² and centers260². Existing halo13/source-edge282 guards
block halo14/284; future geometry/admission work is needed, not a silent cap
bypass. Forecast only, no implementation, GPU execution or speed claim.

## Next stronger-noise experiment after the native checks

The desktop/GPU batch is closed. The three missing creative configurations pass
with 144 trials / 34,560 inputs; 32 inputs lack an individual visible output.
Compact selection: 873 checks, 519.25 seconds. Wide exact retry: one case,
286.71 seconds. Keep the original 35/48-trial wide focus-loss attempt as failed;
its cause is unproved. The compact/wide receipts, actual latency/cadence and
remaining cold spatial/contention scope are linked above. All 13 recorded
test launches have released their owned profiles/app identities.

The next source-only proposal separates a preliminary feature guide from the
original values being averaged. Root prospectively selected one pilot-guided
pointwise chroma design, preserving original L feature proposals, exact C0
behavior, all 44 inputs and every existing gate. C14 remains rejected as an
output operator. Reviewed ignored package:
`artifacts/detail-research/strong-noise/pilot-pointwise-policy-draft-hcvmUn/`.
`POLICY-v2.md` SHA
`9ac3341f60bd9f3fd14b072046cc15a4e373b9f11ee5bdc78702fda44d6c49ee`;
mirrored `scripts/research/strong-noise/comparison15.json` SHA
`7b9bd8bee91363d4b83b2a74da03b9769e8b629f47884fc241ee8593ca5221e5`.
At that checkpoint these were review drafts, not published repository research
sources or executable approval. No C15 implementation or numerical/quality
output existed; the dated continuation below records subsequent source and math.

Before numerical work, independently resolve exact guide-word rounding for
the declared Float64 operands/ordered gather/addition; directly rounding an
ideal Decimal80 sum is insufficient near binary32 ties. Then review the new
numeric plan, halo-24 dependency witness, publication counterfeits, exact counts
and source hashes. Pilot59/guide3/final11 publications are distinct; prospective
NR halo 24 and combined sharpening halo 33 require separate resource/GPU design.
Do not reuse old halo admission or treat a larger Neff as a quality pass.
Public NR v1, older failures and all compatibility/adoption gates remain intact.

## C15 implementation preparation — 2026-10-31

The user initially reserved the desktop and compute for Witcher, limiting work
to source preparation and lightweight checks. The user subsequently authorized
CPU research while playing; GPU, foreground, RAW/full-size and presentation
work remain held. Do not reopen the completed native/creative batch merely
because a new goal turn starts.

The design drafts above remain preserved. Their prospective repository policy
is now `assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md`,
with `scripts/research/strong-noise/comparison15.json`. The CPU research source
is now `scripts/research/strong-noise/chroma-pilot-pointwise.py`, SHA
`3378dd0a5fc40022ff50078b42fb3de484bb39ea763e26fa519a7d906541a9f3`.
Root and independent source review found no algorithmic blocker. AST, symbol and
literal manifest checks pass; this is not numerical correctness or quality
acceptance. The implementation never enters the app's current processing path.

The exact-word oracle design is independently authored host-Float64 arithmetic
for source features, ordered pilot gather/addition and final owner estimates,
using only independent Decimal80 pilot publications. The independent Decimal80
RGB/bound gates remain separate. Every diagnostic guide/E scalar must already
be Float32-representable before its bits are checked; only E zeros are canonical.
The host/runtime/libm boundary must be recorded, not presented as portable
correctly-rounded transcendental proof. All transitive checker, primary and old
C0 helper sources must be frozen, not just the new module.

Independent reference and five-group test sources are now published in the
working tree: `scripts/research/strong-noise/reference/chroma-pilot.py`,
`pilot-host-f64.py` and `tests/strong-noise-chroma-pilot.spec.ts`. The unique
explicit-only target is `strong-noise-chroma-pilot`, service/exclusive. Root and
independent source review pass; metadata-only plans confirm 156 core, 84 alpha,
12 asymmetric, 180 identity and 15 scalar publication cases. All 13 checker,
candidate, primary and legacy source bindings are frozen in those plans.

The lightweight publication case passes: **one test, 0.85 seconds total**, with
15 guide RN32, 15 canonical delta and 15 normalization seam checks, plus six
independently solved coefficient words. Report:
`artifacts/verification/playwright-1793434261210-17a4669b-030d-4209-98ab-8097df5c004c/playwright/summary.json`.
The external review freeze is
`artifacts/detail-research/strong-noise/c15-publication-only-20261031081011/approval.json`;
it approves only `publication`. A bounded negative CLI check confirms that core
generation under it exits 2 before creating output. Type checking, focused lint,
syntax/metadata checks and artifact-free target selection pass. The lint-only
removal of an unused type-list constant changes no numerical behavior.

At that earlier checkpoint, full core, alpha, asymmetric and identity vectors
still needed their reviewed source/plan freeze and compute authorization. Never
use the publication-only freeze to claim those groups. The later complete
arithmetic run below supplies separate evidence. Public NR v1 and the C14
rejection stay unchanged.

The candidate-free quality runner prepared at that checkpoint is
`scripts/research/strong-noise/pilot-screen.py`, SHA
`3bf920db0b2554cc77bc0f3e93e01dd0a6bf8bdd9d0b76c295ca38c039a02482`.
Source review, AST/symbol checks and its artifact-free 44-case plan pass.
Publication-only proof is explicitly refused before archive, lock or candidate
creation. A full freeze needs all five actual proof results, eight meaningful
counterfeits, the independently audited selection, exact runtime/model/source
bindings and the complete target result receipt. Stage ancestry uses full
receipt paths/hashes, not merely matching stage names. Canonical computation and
archived metrics are separate. Unknown acquisition ownership is preserved and
reported incomplete; no universal filesystem-failure cleanup claim is made.
Its later full-freeze destination failure and exact recovery are recorded below;
these source/guard receipts do not establish correct archive destinations.

Independent selection receipt:
`artifacts/detail-research/strong-noise/c15-independent-selection-8lz5v5ro/receipt.json`,
SHA `3086d21610092856caceece57f918a798e3ecd0a73d554a49497723a53e04e2a`.
It verifies 44 complete records, 88 inputs, 44 comparator files and 14 evidence
pins; no Float32 decode or filter ran. Keep the failed first metadata-digest
attempt as evidence of legacy JavaScript number-format differences. New explicit
Python digests accompany the unchanged legacy hashes.

Source-only GPU forecast:
`artifacts/detail-research/strong-noise/c15-gpu-resource-forecast-20261031.md`,
SHA `d15fbd8171253b9f26d8108c55364c4678c23c0fe886a6bc463bd94d5e23d542`.
Packed illustrative NR buffers total 25,936,320 bytes at output edge 256 and
29,402,688 at edge 274, with separate original-L center support through N+2.
Do not treat this as measured memory or a chosen shader layout. GPU precision,
tiny alpha, source-strip retention and old halo admission still require design
and verification after quality passes.

The new `strong-noise-pilot-screen` service/exclusive target passes five isolated
guard cases in **1.54 seconds**, zero failures/skips. Report:
`artifacts/verification/playwright-1793436317880-c8bd0246-e47a-4348-9f46-24252a23f175/playwright/summary.json`.
It uses only actual driver guard/save functions, stdlib and a private fake lock
runtime: normal retirement, owner write failures before/after publication,
foreign-fixture preservation and an injected cancellation after temporary
identity capture. There is no real verification-lock, processing, GPU or full
filter-cancellation coverage. Unknown identity failures remain preserved and
incomplete. Latest Node type checking, focused lint and formatting pass.

The user subsequently authorized CPU use while playing. The GPU and desktop
remain reserved for Witcher. The complete `strong-noise-chroma-pilot` target
finished at low priority in background/service-exclusive mode: **876 passed,
zero failures/skips/interruptions, 849.71 seconds**. Read
`artifacts/verification/2026-10-31T08-49-21.018Z-check-FBppKa/summary.md`.
All five actual cases passed: 156 core, 84 alpha, 12 asymmetric, 180 identity
and 15 publication configurations, including the declared numerical
counterfeits. The routine-duration warning remains; this duration is not
application performance. No live arithmetic process remains from that run.

The complete mathematical source/plan approval is
`artifacts/detail-research/strong-noise/c15-complete-math-20261031084920/approval.json`.
It grants all five numerical groups only. The earlier publication-only freeze
still grants no image computation, and neither approval accepts quality or GPU
processing. Do not rerun completed native/GPU tests. Arithmetic is now supported
by the complete target, not the earlier scalar-only receipt. At that mathematical
checkpoint retained-quality filtering had not begun; its later progress follows.

The first complete candidate-free quality freeze failed its destination
contract: `freeze_unlocked` reused its `directory` output parameter for a
retained-input directory. It wrote the C15 declaration and source archive into
the old C9 `comparison9/run-jtxn_2oh` directory. The bad freeze is rejected.
No candidate filtering started. Root preserved the misdirected declaration and
81 new files, then restored the original C9 declaration byte-for-byte from its
verified archived copy. Incident evidence and the exact recovery receipt are in
`artifacts/detail-research/strong-noise/c15-freeze-recovery-et2u8g1x/`.
`recovery-verification.json` records the original declaration SHA
`fda6afcce721ebbfbbe4c9a5718b94d6a5f3337a43566a13c570b08de4e909b0`,
unchanged original archive SHA
`8e45c5a9ddc151cea40c4d9697e50cd3e2a08c11a25b29c64501ea482c217195`,
221 rechecked freeze pins, 158 selection-evidence items and 192 original C9
files. The extra source directory is absent and the misdirected new files are
quarantined. The record is a recovery check, not successful quality execution.

The independently reviewed fresh-destination fix is now published in the working
tree at driver SHA
`d27c0f57b23a842d016eabbfd6030f9da347c7cf6f9b985881f387a8ff3386fc`.
It separates read-only source directories from an immutable fresh destination,
guards every archive/metadata path and checks the returned declaration location.
One actual archive-assembly regression passes **1/1 in 0.812 seconds**:
`artifacts/verification/playwright-1793438308691-525247d0-d0d6-4a5a-bf65-ff1b664fd966/playwright/summary.json`.
The original driver/tests are preserved in
`artifacts/detail-research/strong-noise/c15-destination-fix-publication-7xmxrdjr/`.
The full registered `strong-noise-pilot-screen` target now passes **877 checks
in 47.80 seconds**, including all six isolated guard/assembly cases, with zero
failures/skips/interruptions:
`artifacts/verification/2026-10-31T09-18-36.205Z-check-lBMG5B/summary.md`.
The corrected candidate-free freeze is
`artifacts/detail-research/strong-noise/comparison15-retained/freeze-k7yqo6oi/declaration.json`,
SHA `9709b26a1f0132278a66de13235d27b6620dd9f5eff119fdfbfbfe935aa3843b`.
It contains all 44 records, 221 pins and 81 archived source copies, and its own
invocation lock retired. Independent read/hash review confirms every pin/copy,
all 13 mathematical bindings and five proof groups, full record/stage order,
fresh directory identity and unchanged original C9 evidence. The first two
retained edge cases pass **2/2 in 328.111 seconds**, with no required failures, in
`artifacts/detail-research/strong-noise/comparison15-retained/run-context-edge-regression-egtqw4ge/`
(execution session 33879 completed with exit 0). Leakage is
`0.021970112987365398` / `0.021970128139770333`, below the unchanged `0.03`
limit in sRGB / Rec.2020. This stage's `summary.json` SHA is
`2ed460d890326ae08a8c33fae4d0395519b68e79ecf25a11923c49250e86cb1d`;
pins, copies, outputs and cleanup are verified. The six remaining edge anchors
completed CPU-only **6/6 in 951.620 seconds**, exit 1, in
`artifacts/detail-research/strong-noise/comparison15-retained/run-edge-regression-anchors-eiirs64x/`
(session 53933 is terminal), consuming that exact predecessor receipt. Rows 4/6
(alternate seed, sRGB/Rec.2020, strength 75) fail leakage:
`0.04573674205118607` / `0.04573668328419722 > 0.03`. Rows 5/7 at strength 100
pass with `0.01970787692101685` / `0.01970781306363343`. **C15 is rejected for
adoption: six of eight examined edges pass, two fail.** The complete second-stage
summary SHA is `cb7b6ea77199dad33cb8a7639c9c3930522a27db850e30cefdbbe001c5889ae8`.
All pins/copies and six outputs verify; the owned lock retired, no children or
live invocation lock remain. Flat-stress and texture stages are blocked and will
not run. No new GPU port or application integration follows these results.

The retained-word diagnosis is
`artifacts/detail-research/strong-noise/c15-retained-row4-diagnosis-e1x8sm17/corrected-comparator-labels/diagnosis.json`,
SHA `27149ef82429bc0f7761ba4ca0ddc992d3e375a502d35b26b888cff7e301ee30`.
The failing right column x=68/y=4..131 already has additional bias in the
reconstructed pre-inverse opponent target (`-0.01831195`, versus entering
`-0.01024669`); inverse/scale coupling contributes only about `+0.00001726`.
This retained-output analysis cannot identify cross-side mass versus
guide-conditioned noise without actual weights. It also does not observe guide
bytes or constitute an exact proposal certificate. Actual C12/C13 comparison
outputs are kept separate from `oldMetrics`/`oldOutput` retained-baseline labels;
the initial diagnostic mislabel is preserved and explicitly superseded. A
bounded unchanged-operator guide/weight replay is being prepared, not a parameter
sweep or new candidate.

The reviewed replay helper completed CPU-only (session 94221, exit 0), with rows
4/5 as its only permitted replays:
`artifacts/detail-research/strong-noise/c15-boundary-ledger-source-151GPG/replay.py`,
SHA `7f57157b485fc4472f52c65f813bf72c8a2c0c847a22f49f904bb7171bd02625`.
Fresh output is
`artifacts/detail-research/strong-noise/c15-boundary-ledger/freeze-cvewf6vh/`.
Its complete diagnostic summary SHA is
`1c7fc7235ab444026c2a5061cdf8ae68dfb1c31fbb7ac3b793345ba2fc287749`.
Both full RGB32 outputs match the retained bytes. The observed guide hash is
identical for both strengths:
`9dca378f546f8b248bb3a5bec2fca1565ebd441bd7721ad9c20b73bc01ea24b3`.
For this sRGB boundary, opposite-side weight mass is only `7.9215e-30` at 75 and
`3.6709e-12` at 100. Mean clean transport is negligible; mean weighted original A
noise is `-0.01831195369793477` / `-0.007946561705252826`, accounting for the
observed target error with closure below `6.84e-16`. Guide-residual/noise
correlations are descriptive, not an independent-noise or unbiasedness theorem.
This resolves the earlier identifiability limit for these two observed sRGB
replays: the failing mean is same-side weighted noise, not cross-side transport.
It does not establish a diagnosis for all scenes or a replacement operator.
All source pins/copies stay unchanged, the owned lock retired and no children
remain. The helper uses the same guarded invocation namespace, checks the complete
retained RGB32 bytes before interpretation, verifies actual Float32 publication
and final E words, preserves clamped duplicates, and reports clean transport,
weighted source noise, publication error and closure residual. This diagnostic
does not reopen later quality stages or adopt C15.

C15's exact L/C0 compatibility is with **C9 research**, not shipped public NR v1,
whose compiled bandwidth maxima remain `.048/.16`. All public v1 edits still use
their existing operator. Integration remains design-only: preserve old settings
11/catalog 21 NR and sharpening values in every history snapshot; histories
through settings 10 receive explicit legacy defaults, never future new-photo
defaults. A later operator needs version-aware patch merging, cache identities,
frozen export/batch policies and capabilities. No v2 settings migration, UI or
application processing path is integrated.

A source-only performance review identifies later implementation opportunities,
without changing the frozen experiment: reuse the fixed L=C=100 pilot guide
across user-strength changes with exact upstream/primaries/estimator/operator
identity and bounded ownership; reuse target-neighbor feature differences while
preserving each accumulation order; remove unused chroma tables from L-only
work; and use packed publication storage with independent-center parallelism.
For an opaque 136x136 case, the pilot executes 200,335,716 valid C25 target
updates versus 8,156,736 distinct target/offset combinations. The separate L-only
helper at user L 1–99 builds 245 unused chroma prefix planes and 4,531,520 unused
chroma box queries. These are source-derived work counts, not measured speedups.
No reassociated sums, reciprocal substitutions, FMA, clamped-neighbor
deduplication or earlier rounding are implied. Any implementation must retain
the publication/alpha/halo contracts, pass independent references and establish
actual bounded resources and latency after quality eligibility.

Future experiments may reuse C15's independently generated, immutable pilot59,
Float64 gathered pilot proposals, guide3 and unchanged L9 expectations when the
original RGBA bytes (including alpha/zero signs), dimensions, full variance
descriptor, primaries/coefficient words, component graph and host-runtime
fingerprint match exactly. Bind all old references/approvals, successful group
receipts and 13 source hashes. Independently derive the changed final E2 and RGB;
C15's suffix cannot certify another operator. Retain all 447 old configurations
and add any new halo/final-rule witnesses. Actual composed entrypoints and eight
meaningful counterfeits remain required. In-memory prefix reuse could reduce
210 active-control pilot computations to 42 unique contexts (26 core, 14 alpha,
2 asymmetric), with every use still compared; that is a source work count, not
a measured speedup. Cache actual received inputs, keep canonical/mutant caches
isolated and never bypass public `denoise`, which would mask the existing halo
mutant. C0 must still bypass pilot construction. No such cache/verifier or new
candidate is implemented yet.

## C16 prospective patch-guidance design — 2026-10-31

Root selected and independently reviewed one next CPU research design. Its
working-tree policy is
`assets/tests/references/detail/strong-noise/chroma-pilot-patch.md`, SHA
`e67a012639890a0f1be13d5875ce22d597009711b31f8d6e70a5edb5e7e2e6a7`;
the companion `scripts/research/strong-noise/comparison16.json` SHA is
`0ed72371e6137271e7ebbbec9eaaeed2421cdedcb5aa6092735384b6d593ceea`.
The original ignored drafts remain in
`artifacts/detail-research/strong-noise/pilot-patch-policy-draft-to1xfdxp/`.
All 44 retained rows/stages/input declarations match C15; 56 nested path/hash
records were checked. The old 13 mathematical source bindings stay unchanged.

The single change is final **5x5 guide-patch matching**, with radius10 search
and owner-only original A/B values. Keep the C14 fixed pilot, source variance,
bandwidth/strength rules, original L/C0 paths and once-after-C32 blend. Clamp the
neighbor center first, then each patch sample. Matching confidence is the
product of the two original alphas, normalized by actual positive coverage;
zero-alpha neighbors/pairs are skipped before reads. Self and duplicate offsets
remain uncapped. Direct Float64 order is specified; no prefix reassociation is
approved. Source halo becomes26, guide-L dependency17 and maximum sharpening
composition35; original-value proposal bounds remain L3/C10.

This is a scoped hypothesis about spatial context after the observed same-side
noise error. BM3D supports matching patches in a basic estimate while filtering
original noisy values; its Gaussian-noise results do not establish our signed
HDR/alpha behavior or unbiasedness. The policy preserves all old counterfeits
and 447 baseline configurations, requires independently regenerated changed
E2/RGB expectations, and adds numerically observable halo26, center-first,
matching-alpha and wrong-point-metric witnesses. Existing halo24 geometry alone
cannot prove the new support.

**Implementation update — 2026-10-31:** the CPU prototype, separately authored
reference/host graph and registered `strong-noise-chroma-pilot-patch` service
suite now exist. The reviewed plan retains all 447 old configurations and adds
12 support cases, for 459 total. Generation approval is
`artifacts/detail-research/strong-noise/c16-complete-math-vxp7y5_8/approval.json`;
all 19 mathematical source bindings were checked again before execution.
Publication (15), asymmetric controls (12) and alpha (84) checks pass: 111 of
459 configurations. Core (168) is running in the isolated service case; identity
(180) follows only after it passes. Do not claim complete numerical proof,
photographic qualification or application adoption from these partial results.
Canonical generation/check still covers the full selected group; the explicitly
labelled counterfeit witness checks cannot qualify as full positive proof.

No C16 quality freeze, GPU port, migration or application integration exists yet.
Keep every C15 rejection/recovery artifact and all 19 current mathematical
bindings unchanged during proof. The user has since made both GPU and foreground
desktop available. This authorization does not require more performance runs.
All work remains uncommitted; no Git push occurred in this continuation.

Current feature summaries in `docs/features/lightroom-comparison.md`,
`README.md`, `upscaling.md` and `white-balance-picker.md` now distinguish the
completed scoped native/real-source/full-size passes from remaining measured-
neutral, photographic and sustained-performance acceptance. Their acceptance
criteria and backlog checkboxes were not relaxed. No application behavior was
changed by those documentation corrections.

## Performance effort decision — 2026-10-31

The user accepts loading time for expensive denoising and requests performance
expectations informed by comparable commercial applications. Apply
[performance decisions](performance-decisions.md), now linked from `AGENTS.md`
and the professional-editing plan. A reusable `performance-tradeoffs` skill is
installed in the local Codex skills directory. Quality/correctness, responsive
interface use, cancellation and resource bounds remain required. Existing
numerical gates are unchanged; commercial timings have not been measured.

Stop further speculative timer/pacer changes and foreground cadence experiments.
The 8 creative controls passed the native-maximized 120 Hz input selection in
`artifacts/verification/2026-10-31T10-27-23.312Z-benchmark-cMThWD/summary.md`:
48 trials, useful updates 58.66–74.71/s and first-visible p95 27.0–29.8 ms.
The remaining 10 controls are incomplete in
`artifacts/verification/2026-10-31T10-40-20.100Z-benchmark-5LX6wi/summary.md`:
59 of 60 trials missed the unchanged input-cadence prerequisite. Do not report
complete 18-control acceptance. The harness injects DOM events in a native window;
it does not measure physical input or scanout.

The bounded diagnostic in
`artifacts/verification/2026-10-31T11-15-09.804Z-benchmark-aUmblp/summary.md`
is incomplete. Its original buffer-percentage flag was incorrect: the actual
trace retains 130/240 inputs, lacks the end mark and reports 4,871 discarded
chunks. The independent audit is
`artifacts/professional-editing/editor-pacing-diagnostic-gz2tmv3v/audit-v1/receipt.json`.
It supports timer clamping and renderer contention only in the retained
instrumented prefix, not a full explanation of ordinary untraced performance.
The corrected completeness assessment and its nine pure Node tests pass the
focused `editor-pacing-trace` selection: 881 passes including existing cheap
checks, no failures/skips, 39.54 s, in
`artifacts/verification/2026-10-31T11-41-21.094Z-check-6VLdg6/summary.md`.
The earlier formatting-blocked receipt is preserved. The read-only audit using
the actual retained report and current helper is
`artifacts/verification/editor-pacing-trace-audit-8h0gP3/audit.json`; it marks the
recording incomplete with 129 aligned input events, a missing end mark and the
same discarded chunks. The earlier manual count of 130 used a different input
boundary; neither count establishes complete 240-input coverage. Originals are
unchanged. This diagnostic workstream is closed; do not rerun timing experiments
merely to obtain a complete trace.

Continue the selected C16 correctness and frozen quality evaluation. Research
CPU runtime is not production denoising latency. Before another substantial
algorithm search or optimization cycle, present its likely user benefit,
effort and uncertainty; do not automatically start another candidate. Goal 1
quality and remaining acceptance, followed by all of Goal 2, remain in scope.

## GPU-only clarification and next work — 2026-10-31

The user confirmed backlog #32: Irodori runs on their own PCs, and avoiding
duplicate CPU/GPU implementations and agent-credit costs takes priority over
speculative compatibility. Apply [GPU-only processing](gpu-processing.md) and
the updated `AGENTS.md`/professional-editing plan. New or rewritten editing and
rendering stages have a production GPU path without CPU fallback or precision
repair. Necessary CPU decoding/codecs/control work and useful test-only reference
vectors remain. Existing CPU fallbacks are still present; do not claim #32 done.
Local skills `performance-tradeoffs` and `irodori-gpu-development` record this
direction. Do not restart the proposed CPU-only C16 quality-driver extension.

C16's remaining mathematical cases finished before this clarification: core
168 configurations plus all nine numeric counterfeits pass in 482.27 s,
identity 180 passes in 6.41 s, and scalar publication 15 under the complete
approval passes in 4.59 s. Their respective direct service summaries are:

- `artifacts/verification/playwright-1793446687314-5ebad49a-0e57-4fe4-837b-109a709c6fe8/playwright/summary.json`
- `artifacts/verification/playwright-1793447204189-d120ff5d-24d2-4754-bc70-4f96ab748273/playwright/summary.json`
- `artifacts/verification/playwright-1793447254421-96b22ce0-a5e0-4546-9654-0038386e3960/playwright/summary.json`

Together with the earlier alpha 84 and asymmetric 12 passes, all 459 canonical
configurations have passed their separate selected cases. No aggregate full-target
run was performed or claimed; do not repeat filtering merely to aggregate a report.
The 19 approved mathematical source hashes remain unchanged. This evidence is
offline research, not GPU arithmetic, photographic quality or product adoption.
All three latest test handles are terminal with exit 0.

The independent metadata-only selection-audit attempts remain failed; no passed
C16 selection receipt exists. The final attempt's script and publication failure
are preserved in
`artifacts/detail-research/strong-noise/c16-selection-audit-5ajn6k71/`.
No candidate filter ran and no original evidence changed. Do not build another
audit framework; reuse the existing frozen inputs and quality harness as far as
possible for actual GPU work.

**Next:** a bounded GPU feasibility/implementation step for the selected denoiser,
including global noise estimation, pilot/final passes, supported precision and
halo/resource accounting. Reuse the existing isolated Dawn owner and shared
preview/export preparation. Check against independent reference vectors and the
retained photographic quality limits. The existing GPU wrapper has internal CPU
recovery even in GPU mode, so merely choosing `backend: 'gpu'` is insufficient.
No new GPU implementation, quality acceptance or hardware run follows from this
source inspection. Keep saved v1 edits reproducible and explicit capability/error
handling in scope. GPU-only preview/raster-export/Lanczos migration remains visible
as bounded legacy work rather than an automatic full-pipeline rewrite.

## Bounded C16 GPU prototype and quality rejection — 2026-10-31

Implemented `scripts/research/strong-noise/pilot-patch-gpu.ts` and
`pilot-patch-wgsl.ts`: six Dawn/WGSL passes, whole images up to 256 pixels per
edge, caller-supplied frozen source variance, per-row fences/abort checks and
explicit refusal instead of CPU repair. Fixed allocations are 23,593,088 GPU
bytes and 25,690,368 working bytes. This is an unenabled prototype; full-size
tiling, sharpening composition, app settings/history and export integration are
not implemented. Tiny positive alpha below 2^-20 is unsupported explicitly.
Reuse the existing sampled estimator once per immutable source for parameter
derivation when integration proceeds; do not implement two estimators merely to
label every part GPU-only. The GPU filter remains the sole denoising backend.

Compact independently generated source/RGB vectors are now portable in
`assets/tests/references/detail/strong-noise/chroma-pilot-patch-gpu.json`.
The explicit `strong-noise-pilot-patch-gpu` target has six cases, covering 18
active frames, 62 RGB owners, 506 exact alpha words, hidden copies, neutral
identity and pre-device admission/cancellation. Original final RGB tolerance
is unchanged. The initial registered invocation passed static/build and 881
cheap checks but failed test collection on an invalid rounding-word argument:
`artifacts/verification/2026-10-31T18-05-30.807Z-check-VFlBxm/summary.md`.
Subsequent failures found WGSL constant-NaN rejection. Both are corrected;
shader diagnostics now include compilation messages and nonfinite feature
results are refused rather than silently becoming a neutral result.

The three hardware cases pass after those fixes: sRGB in
`artifacts/verification/playwright-1793470170875-3f9a28c1-4130-4871-b0d4-485828437c94/playwright/summary.json`
(1 passed, 1.38 s), Rec.2020 and alpha in
`artifacts/verification/playwright-1793470216496-0b3548ca-dc43-4381-9653-b311e4ea173c/playwright/summary.json`
(2 passed, 1.66 s). The three fixture/neutral/refusal cases passed in the earlier
direct selection; no complete registered-target pass is claimed on the final
source. Final type checking, focused lint and diff checks pass. Preserve all
failed receipts. No CPU filter or new reference generation ran.

Four unchanged 136 × 136 synthetic entering/clean inputs and their frozen
descriptors now live in
`assets/tests/references/detail/strong-noise/pilot-patch-quality/`; current metric
sources match the old frozen originals. The explicit
`strong-noise-pilot-patch-quality` target reuses those metrics and limits.
It **fails both first-stage cases** in 8.10 s:
`artifacts/verification/2026-10-31T18-11-11.582Z-check-REGG4e/summary.md`.
Normalized chroma-edge leakage is 0.04315065266055561 (sRGB) and
0.04315070729314076 (Rec.2020), against 0.03. Edge width, finite values and exact
alpha pass. Chroma RMS ratio is about 0.10791; this noise reduction does not
override the failed edge criterion. C16 GPU is rejected for adoption under the
current gates; later quality stages and photographic checks were not run.

The actual tested adapter is AMD Radeon RX 7900 XTX / RADV Navi31, Mesa 26.2.4.
The approximately 3.21/3.26 s measurements are whole small-prototype job times,
not full-resolution app latency or presentation acceptance. The integrated GPU
was not tested for this rejected candidate. No CPU fallback exists in the new
prototype; old application fallback routes remain.

A read-only clean/noisy/GPU comparison and source hashes are saved in
`artifacts/professional-editing/gpu-denoise-quality-1z_1tbiz/comparison.html`.
It displays the sRGB numerical pattern with the same transfer/display clipping
for every panel; quality metrics use unclipped floating-point pixels. The user
chose to review this quality tradeoff first, to limit credit cost. Do not start
another algorithm search. Native visual inspection shows much less colored
speckle and a sharp boundary, with residual uneven flat-area texture; normalized
boundary color bias still exceeds the frozen limit. This one synthetic pattern
cannot establish photographic quality. A bounded diagnostic crop review using
an existing committed high-ISO photograph/prepared source is the next useful
check if those data are readily available. Keep the full goal active and all
quality gates unchanged; no production tool or milestone is accepted here.

### Real ISO 6400 visual tradeoff review

The chosen review used the existing committed `DSC03489.ARW` and already prepared
5422 × 3622 scene-linear Rec.2020 source. The original and prepared SHA-256 values
were checked; no new decode or CPU filter ran. One complete-source streamed
estimate took 1.38 s using 2,359,296 statistics bytes and two source rows.
Two 180 × 180 contexts were extracted around fixed central 128-pixel crops from
the predeclared paper and fine-fiber regions, retaining 26 source pixels of
context on each side. These diagnostic crops do not replace the frozen 512-pixel
photographic protocol or establish tiling/full-source processing acceptance.

The strength-75 review, source/bundle, full-source estimate, hashes and cleanup are
in `artifacts/professional-editing/gpu-photo-review-xh3hT9/` (9.81 s total).
The fair maximum-strength comparison reuses those exact contexts and variance,
with no new estimate or full-source read:
`artifacts/professional-editing/gpu-photo-review-100-VX90zY/comparison.html`
(8.22 s total). Both show native and 4× before/75/100 views, with the same existing
ACES 2 SDR rendering and one sRGB encoding. GPU allocations retired to zero;
source files, parent evidence and the new kernel remained unchanged.

Root and the author visually inspected the paper and carpet crops. Pronounced
colored grain remains at both 75 and 100; visible improvement is small. Fiber
structure is broadly retained in these small views, but that does not establish
useful strong-noise cleanup or comprehensive texture acceptance. Keep C16
unavailable; neither the synthetic failure nor this photographic limitation is
a speed-optimization problem. Do not loosen a quality limit based on this review.

The user's review-first request is fulfilled. An optional effort preference was requested:
one alternative investigation plus quality screen, bounded to about an hour
before reassessment (recommended), or a discussion of denoising priority before
more work. The bounded-trial continuation below records the later working
assumption under the existing goal; no explicit effort answer was received.
Keep the full goal active; do not start another open-ended
candidate search. The GPU development skill now emphasizes early representative
photographic review before expanding a research operator's proof matrix.

### Literature and functional-status audit

The user then asked about professional denoising papers. Primary sources were
checked and [the method review](features/denoising-method-review.md) now distinguishes
complete BM3D collaborative filtering, signal-dependent RAW noise modelling and
SCUNet learned denoising. It records relevant reuse/domain limits without choosing
or implementing a replacement. The next selection should start with a complete
established method and a practical existing GPU implementation, using the user's
RAWs early. No additional algorithm cycle ran during the literature inspection;
the later bounded trial is recorded below.

A read-only audit also verified existing transfer and combined-source receipts
against their actual assertions. The Goal 1 checklist now marks those two exact
functional criteria complete: selective transfer/history/conflicts/cancellation,
and recorded real RAW/raster/genuine-v4/encoded-synthetic-ISO edit-export-restart.
The latest combined reviewed-input receipt is
`artifacts/verification/2026-10-29T12-07-25.420Z-check-2b7KF1/summary.md`
(787 passed, no failures/skips, 98.77 s). These historical passes cover specified
sources/settings and small export crops; they do not close photographic quality,
full-size/performance/GPU migration, physical color or Goal 2. Relevant production
editing/export paths remain unchanged; no new current-revision run was claimed.

The follow-up bounded GPU implementation review identified
`HolyWu/VapourSynth-bm3dvk2` as the most practical first classical reuse candidate
to evaluate, with a real float32 Vulkan basic/Wiener route and a published Linux
wheel. At the source-review stage this was a proposal only. The older myrsloik fork is archived and redirects
to that successor. A HIP BM3D implementation targeting gfx1100 and SCUNet routes
were also source-checked but not selected. See the method review for exact links,
licenses, HDR/alpha/reproducibility limitations and snapshot hashes. Three pinned
successor source documents were read and saved; that inspection ran no runtime,
dependency installation, model or GPU job.

### Bounded published-method trial

The existing goal authorizes denoising work. After finding a 6.62 MB binary-only
Vulkan route, root explicitly stated a bounded working assumption for one small
isolated trial, with no integration, substantial repair or large runtime setup.
The optional effort preference remains unanswered; this is not explicit user
approval for a larger rewrite. The trial started around 18:48 UTC with a one-hour
reassessment bound and an early setup stop if a source build/large install was
needed. The user permits hidden GPU work while playing Witcher; timings under
possible contention do not close any performance gate.

`artifacts/professional-editing/bm3d-vulkan-evaluation-kING07/` contains the
isolated pinned `vapoursynth-bm3dvk2==3.0`/`VapourSynth==81` virtual environment,
exact wheels, licenses, hashes, scripts, output floats/PNGs, logs and cleanup.
No app source, package dependency, global environment or original photograph was
changed. GPU selection explicitly used the RX 7900 XTX/RADV Vulkan device;
llvmpipe was excluded. The integrated Radeon was enumerated only. Basic and
Wiener filtering remained GPU-resident until the explicit output download.

The same ISO 6400 source supplied two 224-pixel contexts with central 128-pixel
paper/fiber views, signed unclipped scene-linear Rec.2020 input and the existing
ACES 2 SDR display. `comparison.html` shows baseline `np`, radius 0,
sigma `[10,10,10]`, with one fresh-graph repeat each. Colored grain is much lower
than C16, but fine fibers soften substantially. Repeats differ: observed maximum
absolute RGB differences are 0.000209018588 (paper) and 0.000045597533 (fiber).
These measurements do not bound general nondeterminism. Audit SHA:
`e13c16cd6cd12312d9184596c3385f15c92673088ed6051f929b8595f82c3789`.

One targeted split point, `split-opp4-10-10-QLASD2/comparison.html`, holds basic/
final matching thresholds at 1200/300 and uses sigma `[4,10,10]`. Exactly two
outputs ran, without a sweep/repeat. It retains more texture/grain than baseline
while reducing colored noise, with residual noise and smoothing. The first
opponent axis is a brightness proxy, not guaranteed Rec.2020 Y preservation.
Audit SHA: `0afb2696a80d7dbb2fea5b1d90ce5222dc5887502e3eac01a6b018761696fe4e`.
Both processes exited; no foreground checks ran.

The export-freezing audit found immutable result reuse, but existing job caches
expire and cold-master acceptance clears preview caches before a new export.
Separate-job and cold-restart byte-equality assertions therefore remain an
unresolved integration requirement; the trial's float variation alone does not
prove a formal JPEG assertion fails. No cache or test was changed.

The bounded screen now **fails both existing synthetic edges** at unchanged
limits: sRGB leakage 0.2042834373 / width growth 1.3719490206 pixels;
Rec.2020 0.2106181300 / 1.4838039893, against maxima 0.03 / 0.5.
Finite/exact-alpha pass both. It used two outputs only and the exact existing
independent metric adapter, with all input/source hashes unchanged. Evidence:
`edge-eligibility-dV6MXW/audit.json`, SHA
`f700d40ad78eae36c1b82f7e581bd56206e6e13a13786e6fd1b49898295e9b91`.
Low chroma residual noise (about 14.2%) does not offset excess edge smoothing.
No old strength-percentage equivalence is claimed. The process exited; the
1.61-second wrapper observation is not performance acceptance.

**The bounded trial is complete and stopped; this configuration is not eligible
for integration.** That does not establish all BM3D settings fail. Further
denoising work needs a concrete noise/domain/control and reproducibility decision
before another filter cycle. Existing ISO 6400/12800 photographs are sufficient;
no new dark-scene capture is requested. See the
[method review](features/denoising-method-review.md) for the exact setup and
remaining full-source, HDR/alpha, support, resources/cancellation, control,
reproducibility and licensing requirements. No production replacement is
integrated or accepted, and no old gate is weakened.

A follow-up source audit confirms the synthetic noise is injected in nonlinear
asinh L/A/B features before RGB decoding, whereas the plugin sigma is an OPP
strength in an 8-bit scale. This fixed setting/unchanged-RGB adapter is not a
calibrated mapping between those noise domains. It still fails the required
gates; neither general BM3D failure nor a proven cause of the failure follows.
The user selected GPU-only cleanup and remaining Goal 1 checks over another
denoising investigation or joint review. Keep the full feature scope and
strong-noise acceptance open; no more parameter points are selected.

A single review page, `bm3d-vulkan-evaluation-kING07/review-summary.html`, places
the unchanged native Before/C16-75/C16-100/BM3D-10/BM3D-split crops together with
optional CSS magnification. Its manifest pins ten PNGs and verifies matching
Before bytes/dimensions; no processing or pixel mutation was performed to build
the page. Existing per-run manifests remain unchanged.

## Strict GPU detail preparation — 2026-10-31

The user selected GPU-only cleanup and remaining Goal 1 checks. Default and
automatic preview/export detail requests now select strict GPU processing via
`src/main/processing/detail-backend.ts`. Existing explicit `cpu` environment
selection remains a legacy diagnostic/reference route; generic automatic/CPU
executors, proof/rendition, crop and resize are not migrated by this slice.

`src/main/gpu/spatial-detail.ts` no longer imports or calls a CPU editing kernel.
Neutral jobs copy source words exactly. Active sources containing positive alpha
below `2^-20` are refused before device initialization. Non-finite GPU readback
is refused after unmapping. The existing band/file owners retire resources and
remove owned incomplete output; there is no silent CPU repair. Supported shader
math, edit/operator versions, cache identities, original/master bytes and numeric
tolerances are unchanged. Existing cached results retain their actual provenance.

Focused verification selects `detail-gpu-policy` (new service target),
`spatial-detail-owner`, `detail-frame-gpu`, `detail-preview-cache-gpu` and
`detail-export-gpu`. Final receipt:
`artifacts/verification/2026-10-31T19-32-44.621Z-check-VASoz0/summary.md`:
**898 passed, zero failed/skipped/interrupted, 52.49 seconds**. Counts are 881
cheap Node checks, eight default/automatic preview/export admission-refusal
cases, and nine GPU owner/frame/cache/export cases. Typecheck, lint, formatting
and build pass. Actual GPU: RX 7900 XTX/RADV Mesa 26.2.4. Cases include late-band
precision refusal after GPU allocation, non-finite mock readback, exact neutral/
alpha/hidden words, input preservation and cleanup. Small raster/scene-HDR/
authored-primary preview outputs have zero display-code difference and retain
the original floating tolerance; this is not full-source or performance acceptance.

Earlier attempts remain failed evidence. The first service attempt used the
wrong existing refusal-message strings, corrected in tests only. The later
cache failure compared an authored HDR photo's SDR primary (PNG source hash
`b47e9e6d…`) to a different synthetic HDR working source (`5e8baf12…`), producing
129 code values of difference. Diagnostic inputs/outputs and metadata remain in
`artifacts/verification/playwright-1793475041265-079f8216-0526-4df7-adbc-8ed526bed395/`.
The fixture now exposes an independently CPU-decoded SDR `primaryJob`, retaining
the HDR working job; the test verifies matching source hashes and uses the
correct rendition identity. No tolerance or production color policy changed.
The corrected isolated case passed before the final registered checkpoint.

No foreground, sustained-performance, new real RAW/full-size, integrated-GPU or
other-platform acceptance ran. Tests stayed hidden while gameplay was allowed.
Strong-noise quality, the rest of #32 and the full professional-editing goal
remain open. No comprehensive checkpoint or additional denoising cycle is implied.

## Crop GPU cleanup and integrated-GPU coverage — 2026-10-31

The former detail backend selector is now shared as
`src/main/processing/spatial-backend.ts`. Detail and crop preview/export callsites
map unset/automatic selection to strict GPU execution; the existing explicit CPU
diagnostic override remains. Supported equations, versions and cache identities
are unchanged. Generic legacy automatic/CPU executors remain separate work.

The crop GPU owner no longer invokes the CPU resampler. Its original coverage
guard is retained, with explicit refusal instead of repair. In particular, some
fully transparent fractional outputs from partial-alpha source windows are now
unsupported. Identity/integer crops remain exact copies; no threshold was relaxed
and the six near-cutoff vectors remain unchanged. The focused discrete-GPU
checkpoint (`crop-gpu-policy`, `detail-gpu-policy`, `crop-filter-gpu`,
`crop-preparation-gpu`, `crop-frame-gpu`) passes **902 checks, zero failures/skips,
47.09 s**:
`artifacts/verification/2026-10-31T19-44-13.118Z-check-r40rSN/summary.md`.
It includes sixteen preview/export default/automatic admission-refusal cases,
five GPU cases, source preservation and unpublished-output cleanup.

A verified process-local Mesa selection (`DRI_PRIME='pci-0000_18_00_0!'`) exposes
only the integrated PCI `1002:164e` Vulkan device, without system configuration
changes. The isolated Dawn probe at
`artifacts/professional-editing/integrated-detail-probe-bg9c13ko/` reports the
Ryzen/RADV RAPHAEL_MENDOCINO adapter and passed device limits. A missing local
`tsx` launcher failed before GPU initialization; the existing esbuild bundler
produced the successful probe without installing anything. Actual test metadata
independently records that integrated adapter, Mesa 26.2.4.

Integrated checkpoints:

- Detail owner/frame/cache/export: **890 passed, zero failures/skips, 54.41 s**,
  `artifacts/verification/2026-10-31T19-40-17.634Z-check-QKTT7p/summary.md`.
- Crop filter/preparation/frame: **886 passed, zero failures/skips, 44.51 s**,
  `artifacts/verification/2026-10-31T19-45-47.093Z-check-6minHB/summary.md`.

Counts overlap the same 881 fast checks. Both discrete and integrated GPUs now
have focused detail/crop evidence, not full-source or performance acceptance.
The user subsequently declared the computer idle. The foreground
`professional-editor-native` selection passes **883 checks, zero failures/skips,
78.23 s**:
`artifacts/verification/2026-10-31T19-47-16.142Z-check-WoHjVX/summary.md`.
Its two native cases take 31.43/4.04 s; shared prerequisites account for the rest
and triggered the routine budget warning without removing assertions. Actual
committed `DSC03280.ARW` is imported into an isolated library, edited through
native keys at 1100 × 700 with the Console open, and checked against current
decoded photo pixels. Root inspected the crop-applied, final-detail-focus and
8000 K/Tint 25 captures: central photo priority, histogram, scrolling and controls
remain usable. Original bytes and history checks pass; test windows close.
This refreshes native functional evidence after the GPU detail/crop policy
changes, not sustained cadence, physical-neutral WB or strong-noise quality.

## Strict scene-linear export failures — 2026-10-31

The existing scene-linear RAW/merge GPU rendition branch now propagates GPU
initialization, admission, tile and deferred-HDR failures in default/automatic
mode as it already did in explicit GPU mode. Pending early JPEG work drains
before converter closure and propagation of the original error. No CPU rerender
or headroom reset follows. Explicit CPU diagnostics, distinct raster/authored-HDR
rendition semantics and the Lanczos3 row resizer remain unchanged legacy routes.
All successful shader, numerical, resize, frozen-source and retained-detail
contracts remain unchanged; a later GPU attempt reuses validated preparation.

The focused discrete-GPU selection (`export-gpu-policy`, `export-gpu`,
`export-enlargement-gpu`, `detail-export-gpu`, `export-resources-gpu`,
`creative-color-export`) passes **900 checks, zero failures/skips, 53.32 s**:
`artifacts/verification/2026-10-31T19-55-53.111Z-check-dsXfqa/summary.md`.
It includes six policy cases, thirteen GPU cases and 881 fast checks. Existing
failure-recovery expectations now require explicit failure/cleanup, original
source preservation and successful GPU retry; all successful references and
tolerances remain unchanged.

The five GPU targets also pass on the integrated Radeon: **894 checks, zero
failures/skips, 73.05 s**:
`artifacts/verification/2026-10-31T19-57-04.350Z-check-NGK30N/summary.md`.
The recorded adapter annotation confirms RAPHAEL_MENDOCINO/Mesa 26.2.4. The run
exceeds the routine budget, with the two creative-color cases taking 10.79/8.20 s;
no assertion was removed and no performance acceptance is inferred. Counts
overlap the same fast suite.

The focused `professional-editing-acceptance` run also passes **883 checks,
zero failures/skips, 99.92 s**:
`artifacts/verification/2026-10-31T19-59-26.702Z-check-9x6X1C/summary.md`.
The two real-source cases take 19.67/37.54 s, plus shared prerequisites; the
routine budget warning retains all assertions. Actual Sony RAW, licensed raster,
explicitly synthetic encoded ISO input and a genuinely published Sony v4 master
retain combined edits, selective transfer/history, frozen enlarged HDR/SDR
exports and restart. Original/master bytes remain unchanged. This refreshes
functional acceptance after the backend changes; its small native export crops
do not establish full-size/performance or strong-noise photographic quality.

## GPU export resize continuation — 2026-11-01

Standard reductions and enlargements now use bounded GPU Lanczos3 by default;
CPU work constructs normalized taps and reads rows. The existing CPU convolution
remains available only through explicit diagnostic selection. The converter
retires before resize, with separate phase reservations for retained source/output
RAM, tap tables, row uploads/readback and the bounded GPU cache. No CPU pixel repair
or automatic fallback was added. Cancellation still stops the isolated export
worker; the GPU owner also has cooperative row-boundary cancellation tests.

New jobs freeze `linear-lanczos3-pixel-centers-replicate-gpu-v2` and
`jpeg-linear-lanczos3-v6-gpu-resize`; incompatible old resize policies fail explicitly
while saved preferences/results remain readable. All non-original-size requests
acquire main-owned admission, including reductions. Diagnostics distinguish resize
from rendition and report the larger sequential GPU allocation as the export peak.

The six focused resize/resource/rendering targets pass **918 checks, zero
failures/skips, 140.33 s**:
`artifacts/verification/2026-11-01T08-58-48.682Z-check-l6C4qD/summary.md`.
They cover independent references, exact signed/HDR constants, identity,
cancellation, budget refusal, default/automatic raster resizing, frozen queued
jobs, actual JPEG reconstruction and committed Sony RAW → 97 × 65 HDR output.
That real RAW case takes 79.37 s and explains the routine-budget warning.
Failed TypeScript/expected-diagnostics attempts remain preserved; no pixel
thresholds or reference samples changed.

The two small GPU suites also pass **14 cases, zero failures/skips, 2.24 s** with
the existing build on the integrated Radeon:
`artifacts/verification/playwright-1793523689550-f74a04bf-fa96-4058-b230-888bb7e12a0b/playwright/summary.json`.
Actual annotations identify NAVI31 and RAPHAEL_MENDOCINO respectively, Mesa 26.2.4.
All checks stayed hidden while the user played. These receipts establish
correctness only; no GPU speedup is claimed. At that point full-size GPU enlargement,
foreground and idle performance were unverified. The following full-size checkpoint
refreshes enlargement correctness separately. Strong-noise quality and the remaining
Goal 1 gates stay open; no further denoising experiment was started.

### Full-size resize refresh

`professional-enlargement-fullsize` now passes **885 checks, zero failures/skips,
217.78 s** (883 shared fast checks plus the two actual full-size cases):
`artifacts/verification/2026-11-01T09-05-41.962Z-check-p9Pkvf/summary.md`.
Committed unchanged DSC03280.ARW exports to 6870 × 4590 SDR and HDR, with v2 GPU
resize/actual RX 7900 XTX asserted, frozen edits, main-owned sequential memory
admission, source preservation and restart. A 10992 × 7344 request remains a
retained failed job with no file under the unchanged 33,554,432-pixel cap.
Resize allocates 1,916,984 / 2,642,456 bytes SDR/HDR and peaks at six rows against
the conservative eight-row bound. The HDR file passes 189,199,800 independent
channel comparisons at two headrooms. The SDR review image shows intact
composition; that reduced review is not native texture/strong-noise acceptance.

The user made the desktop/GPU idle during this background run. SDR/HDR case
durations (108.54/62.77 s) and stage timings therefore span different contention
states and establish no speed ratio or sustained-performance acceptance. No
codec, pixel, numerical, reconstruction or memory gate was changed. The complete
processing/source hashes are retained by each case, including the new GPU owner,
tap/WGSL/plan sources and compiled workers. The following continuation records
the bounded HDR preview failure/retry cleanup separately.

### Strict HDR preview failure and GPU retry

`hdr-jpeg-ui`, `hdr-content-ui` and `interactive-preview-lifecycle` pass
**895 checks, zero failures/skips, 92.20 s** in explicit foreground mode:
`artifacts/verification/2026-11-01T09-55-19.640Z-check-ZgxqoU/summary.md`.
`PhotoPreview` no longer creates `HdrCpuPresenter`; it reports GPU failure with
an actual reason and **Retry GPU**, hides stale surfaces, drains its owner and
restores keyboard focus only when the new canvas is ready. App flushes the active
valid edit before disabling inputs, preserving exactly one history entry.
Healthy display changes retain the canvas/GPU owner and source upload.

Real device loss also invalidates display capabilities. Already-active authored
HDR source demand now survives that failure on the same HDR monitor, even while
the truthful effective output target is SDR/unavailable. Explicit SDR and real
monitor/headroom changes keep their ordinary source policy. Retry reuses the
existing capability probe; no second probe engine, CPU editing repair or shader
change was introduced. The new authored-HDR case demonstrably fails against the
prior build and passes with this fix.

All three native retry proofs preserve source/history/view and compare nine
actual composited samples against the current-target pixel API. Their maxima
are 1/1/1 code values, within the unchanged one-code gate; zero CPU rendering
requests and GPU drainage are asserted. The previous test proof used a
discardable drawing buffer and mismatched sRGB/P3 output domains. Failed
receipts remain intact; correcting capture/target semantics changed no numeric
gate. Earlier source-reuse, pending-commit and focus regressions were fixed and
rerun before the complete selected checkpoint. One early attempt failed before
GPU setup with a native RAW decoder close error; no decoder change was made,
and later focused/registered passes do not certify broader decoder reliability.

Native error UI was visually checked at 1100 × 700. Two monitor-dependent HDR
JPEG cases are now tagged `@foreground` with the hidden-Wayland headroom reason.
The longest functional case is 6.61 s; the routine warning keeps all assertions.
This refreshes bounded HDR failure/recovery correctness on Bazzite. It does not
accept sustained cadence, physical HDR luminance, integrated-browser rendering,
other operating systems, monitor relocation during a fault or strong-noise
photographic quality. Raster preview fallback and remaining legacy CPU routes
stay separate backlog #32 work; Goal 1 remains open.

### Remaining-gate continuation

Fourteen prospective feature briefs, the Lightroom-inspired delivery table and
root/shared usage guidance now agree with the confirmed GPU-only direction.
They require independent references, explicit unsupported-capability/device-loss
handling and GPU retry. Historical CPU results, necessary host/decoder/codec
work, feature scope and every numerical/performance threshold remain intact.
This is documentation alignment, not a claim that all legacy routes migrated.
Formatting and whitespace checks pass; no new test suite was added for prose.

One bounded post-refactor Exposure benchmark was run with existing selectors:
native-maximized 120 Hz, three Fit/100% trials each. It is **incomplete**,
883 shared passes / zero failed assertions / one skipped benchmark case,
70.08 s:
`artifacts/verification/2026-11-01T10-07-57.127Z-benchmark-Qw2IJb/summary.md`.
All display prerequisites agreed. All six input rates missed 118.8 Hz
(range 106.816–117.249); timing acceptance therefore did not run. Do not infer
product latency failure or performance acceptance from it. The bounded stop
condition was reached: no further pacer change, trace or grid was started.
See [the effort decision](performance-decisions.md#bounded-post-preview-check--2026-11-01).

The existing BM3D comparison is still available at
`artifacts/professional-editing/bm3d-vulkan-evaluation-kING07/review-summary.html`.
The user was asked whether to review it first or authorize one bounded
noise-model study followed by reassessment. That choice is pending; no further
denoising candidate, parameter search or integration was started. Strong-noise
quality, remaining sustained acceptance and all of Goal 2 stay open.

### Inspector coverage and remaining-evidence audit

`inspector-ui` passes **888 checks, zero failures/skips, 77.97 s**, hidden:
`artifacts/verification/2026-11-01T10-24-01.288Z-check-FQRn4r/summary.md`.
Five inspector cases include Detail in keyboard/retained-DOM coverage and Detail
plus Crop in photo-change, crash and restart persistence. The new Detail case
keeps Amount 0 and authors Radius 1.2; collapse commits once, an external revision
changes Radius to 1.4 while hidden, and reopening shows the current value without
extra history or altered originals. No new filter or production code was added.
The 60-second routine warning retains all assertions; the longest case is 9.47 s.

The exact requirements of backlog #26–28 were audited against current source,
those five inspector cases, the real-Sony native checkpoint
`artifacts/verification/2026-10-31T19-47-16.142Z-check-WoHjVX/summary.md`
(883 checks, zero failures/skips, 78.23 s) and retained native captures. Those
three items are now checked complete for the current Bazzite inspector. Native
wheel bounds and reviewed 1100 × 700 Console-open views establish the pinned
histogram, independent scrolling, compact readable controls and visible focus;
green test counts alone were not the basis. General dropdown #10, navigation
#33, future tools, other platforms and aggregate Goal 1 acceptance remain open.

The [remaining Goal 1 evidence map](features/professional-editing.md#remaining-goal-1-evidence--2026-11-01)
distinguishes completed functional work from measured-neutral picker inputs,
photographic appearance/detail/enlargement, cold spatial/contention observations,
strong-noise quality and sustained cadence. The picker still lacks two measured
physical illuminants; its synthetic D50/D65 and one unmeasured paper capture
cannot supply that ground truth. No new captures or calibration claim were made.

Eight existing public-v1 forest/starfield sharpening proofs now have a safe,
credited [native gallery](../artifacts/professional-editing/public-v1-sharpen-gallery-_7_gvg3d/gallery.html)
and [bounded visual review](../artifacts/professional-editing/public-v1-sharpen-gallery-_7_gvg3d/review.md).
Original/HEAD identities, saved proof and available parent hashes were checked;
36 bindings remained unchanged. Five current shared math/shader/packing/resource
files match historical producer pins. Active historical filtering used GPU with
zero CPU tiles/repair; the owner was not rerun and display conversion was legacy
CPU. No image was decoded, filtered, copied or resampled to build the gallery.
Native inspection finds restrained edge definition, busier fine/background
texture and no obvious broad halo/seam in those views. This does not establish
clean-truth texture, combined/high-ISO, human skin/hair, star photometry or
current GPU-canvas acceptance. The strong-noise decision remains pending.

### Native SDR enlargement inspection — 2026-11-01

The retained full-size GPU SDR JPEG now has six lossless 512 × 512 extracts and
a [native gallery](../artifacts/professional-editing/gpu-enlargement-native-review-TXaOWb/index.html).
Each PNG retains the embedded sRGB profile and decodes byte-identically to its
JPEG crop. JPEG and checkpoint-receipt hashes remain unchanged; no application,
RAW/detail filter or export was rerun. The frozen edit is NR 20/25 and detail
25/1.2/50, with the recorded tone/creative controls, identity crop and lens off.

The [visual review](../artifacts/professional-editing/gpu-enlargement-native-review-TXaOWb/review.md)
finds continuous silhouettes and no conspicuous broad ring, straight tile seam
or coarse fog band in these views. Dark fur/tree detail remains soft and grainy;
the muzzle ROI does not establish individual whisker retention. This extends the
earlier reduced composition review to actual output pixels for one combined SDR
result. No matching 1× baseline exists, so it cannot isolate resize effects or
pass quantitative texture/ringing gates. HDR appearance, strong-noise quality,
other photographic subjects/scales and performance retain their open scopes.

### Full-RAW sharpening reply supersession — 2026-11-01

`professional-spatial-commit` is now registered as one exclusive RAW/GPU case.
The hidden selection passes **884 checks, zero failures/skips, 58.20 s** at
`artifacts/verification/2026-11-01T10-51-26.279Z-check-FXILHX/summary.md`.
An additional guard rejects unrelated preparation errors/empty assets; its focused
rerun passes **one case in 14.74 s** at
`artifacts/verification/playwright-1793530446303-b06b9cc4-09e8-4083-bdbe-e70b21a77e07/playwright/summary.json`.
No application code or filter math changed. See the
[scope and remaining gates](features/professional-editing-processing.md#full-raw-sharpening-supersession--2026-11-01).
The observed cancelled reply cannot replace the neutral source; retry uses GPU
filtering with zero CPU repair and preserves exact history/view/originals.
Both isolated windows closed and profiles/processes retired. No speed, peak-memory,
in-flight shader cancellation, contention or overall quality pass is inferred.

The user subsequently confirmed that no calibrated neutral target or
color-temperature meter is available. Do not request a purchase or treat the
existing paper RAW as measured-light accuracy evidence. Functional picker checks
remain passed; the separate two-measured-illuminant requirement remains open.

### Real crop/sharpen contention — 2026-11-01

The new `professional-spatial-contention` exclusive RAW/GPU target passes its
focused hidden case, **one passed, zero failures/skips, 26.71 s**:
`artifacts/verification/playwright-1793532018790-95c86a18-ae8a-4191-b21e-88c68d1ba08a/playwright/summary.json`.
Current types, affected-file lint, format and whitespace checks pass. Its earlier
registered run retained 883 shared passes and one failed case; no broader rerun
was needed after the test-only corrections. The
[processing record](features/professional-editing-processing.md#real-cropsharpen-import-and-export-contention--2026-11-01)
describes the exact assertions, retained failures and unchanged performance scope.

Cold fractional crop/sharpen preparation uses GPU with no detail CPU repair.
Actual import byte/copied/prepared counters advance between warm point edits;
an admitted export worker advances during one uncommitted Exposure gesture and
retires before its final commit/publication. Frozen 512 × 342 JPEG bytes match
their restored-settings reference exactly. Six expected history snapshots,
source/view/device/upload identities and all four original/managed RAW hashes
remain correct. Three memory snapshots are observational. The window had no
show/focus events or violations and its process/profile retired.

Repeated committed edits intentionally made export yield; this limitation is
retained rather than converted into a concurrent-rendering pass. A subsequent
test-ordering mistake awaited publication while holding a gesture open and was
interrupted; the final ordering verifies worker retirement, commits once and
then awaits publication. No production scheduler change was made. Denoising and
measured-light scope decisions are pending, and Goal 1 remains open.

### Licensed skin fixture and native color review — 2026-11-01

Zephyris's archived 2010 `ArmHair.jpg` is published with CC BY-SA 3.0 provenance,
exact bytes/hash and full privacy review in asset-only branch
`codex/skin-hair-fixture-20261101`, commit `ba7984e`; local cherry-pick is `3bc8cb9`.
All 149 pre-existing dirty files were byte-identical after integration; the
preservation receipt is `artifacts/professional-editing/skin-fixture-admission-8dha89p2/`.
The clean temporary worktree was removed. Serial-bearing intake remains private.

The new exclusive GPU target `professional-color-photo-proof` passes its exact
foreground case: **one passed, zero failures/skips, 22.52 s** at
`artifacts/verification/playwright-1793534598062-4faabf0a-c465-4ed6-8f62-58ede239d101/playwright/summary.json`.
Four credited 512 × 512 baseline/mixer/grading/combined crops and the bounded
visual review are linked in the [color record](features/color-mixer-grading-processing.md#native-sdr-skin-appearance--2026-11-01).
They use actual Radeon hardware WebGL2 and preserve exact source/history/view
ownership. The mapped window closed, its profile/process retired, and policy
violations are zero. Types, affected-file lint, formatting and whitespace pass.

Hidden capture stalls on this Wayland surface, so the complete capture case now
has a reasoned foreground tag rather than a visible fallback. Earlier failed
receipts remain failed, including the registered 883-shared-pass/one-case-failure
run and later harness corrections. No processing math or numeric gate changed.
The image is assumed sRGB, not measured color; legacy raster preparation/export,
broader photographic/performance acceptance and both pending user decisions
remain explicit. Feature changes and the new proof case remain uncommitted.

### Awaiting effort and acceptance decisions — 2026-11-01

The same denoising effort decision has remained unanswered across at least three
consecutive goal turns. The useful bounded independent work is now recorded:
inspector #26–28, strict GPU resize/HDR recovery, real spatial contention and the
licensed native skin review. No test process or capture is still running.

Next decisions, already presented to the user:

- Review the existing BM3D comparison first (recommended), or authorize one bounded
  noise-model study followed by reassessment. The current method and failed
  candidates do not satisfy strong-noise quality; no further study is selected.
- Defer the two-measured-illuminant picker accuracy criterion to later research
  (recommended), or keep it required for Goal 1. The user has no calibrated
  target/meter, and no qualifying measured-light cohort is available. Functional
  picker evidence remains passed; the criterion has not been waived.

The native-120 pacing investigation retains its explicit effort stop. Spatial
speed limits and broader photographic acceptance remain open; another proof suite
does not resolve those dependencies. Goal 2 integration still waits for Goal 1.
Preserve the full scope, all numerical gates, source/evidence and unfinished edits.
Resume substantive work from the user's decisions rather than restarting passed
verification or launching another speculative research stream.

### Split into individual TODO tasks — 2026-11-01

The user requested simplifying the long-running goal into individual backlog
items. This supersedes the preceding instruction to wait for all Goal 1 decisions
before any later integration. The [canonical backlog](features/README.md#professional-editing-follow-up-tasks)
now assigns existing unfinished work to #38–49; the
[current overview](features/professional-editing.md) maps each task and its scope.
The [former plan](features/professional-editing-history.md) is preserved verbatim
beneath an archival notice, including all passes, failures and unverified gates.

Recommended next goal: #38, consolidate the working editor changes into a
reviewable integration with explicit limitations. No new implementation or
acceptance workload is selected by this documentation change. Strong-noise
research (#39), measured white balance (#43), performance (#44), advanced tools
(#45–48) and optional FSR (#49) are independent. Existing #10/#32–34 retain their
own dropdown/GPU/navigation/design scopes. The native-120 effort stop still
applies; no repeated research or benchmark grid is authorized by the split.

Preserve all current uncommitted code, original assets and retained evidence.
The old goal is incomplete; moving tasks does not mark it achieved. Select one
concrete TODO for subsequent goal work instead of automatically continuing the
old objective. Only documentation formatting, local link and whitespace checks
are appropriate for this reorganization; no app, camera or GPU work is needed.

### Main consolidation checkpoint — 2026-11-01

The owner explicitly requested committing all current work, publishing to `main`
and removing the remaining local/remote branches before continuing individual
TODOs. The current implementation, focused verification cases, independent
reference data, stopped research and task split are retained in one buildable
checkpoint. Rejected denoisers remain research-only, with no production dispatch.
#38 closes consolidation; #39–49 and the existing unrelated backlog stay open.
The old professional-editing goal has not passed its full acceptance criteria.

`npm run check` passed 883 checks, zero failures/skips, in 43.20 s:
`artifacts/verification/2026-11-01T12-26-04.371Z-check-aAwSwD/summary.md`.
Types, lint, formatting and fast Node cases pass; the 15-second routine budget
was exceeded. Earlier focused GPU/native/RAW evidence retains its recorded scope;
no new GPU, foreground, full-suite or performance checkpoint was run for this
publication. Scoped production and repository-hygiene reviews accompany it.

Before integration/branch cleanup, all changed/untracked files, their hashes and
all Git refs were preserved under ignored
`artifacts/integration/20261101T122559Z-main-consolidation/`, including a verified
Git bundle and a separate working-file archive. The obsolete portrait-fixture
branch is not merged: its usable starfield bytes already match the current
tracked, reviewed fixture; superseded portraits stay out of the current tree.
Old stash entries and retained local evidence are preserved. Camera runtime
release tags/assets are retained independently of deleting its merged branch.

The publication audit found that the sixteen unadopted strong-noise study targets
were still selected by broad functional checkpoints. They now require explicit
`--target` selection, matching the stopped-research direction. Production
`detail-quality`/`spatial-detail-gpu` and the fast study-audit guard remain in their
normal selections. Candidate assertions and failed gates are unchanged; this
separation is not denoiser acceptance. A focused registry regression checks both
exclusion from broad runs and continued explicit selection.

The focused post-audit `verification` target passed 884 checks, zero
failures/skips, in 43.28 s:
`artifacts/verification/2026-11-01T12-28-52.832Z-check-FqxFyK/summary.md`.
Type checking and affected-file lint/format checks also pass after the registry
change. The file-preservation audit confirms all 152 original changed paths are
retained; only six files received intentional publication/registry updates.

The staged whitespace scan reports one existing extra blank line at EOF in
`scripts/research/strong-noise/pilot-screen.py`. Its exact source hash is pinned
in the research record, so its original bytes are preserved rather than silently
changing that evidence for a whitespace-only cleanup.
