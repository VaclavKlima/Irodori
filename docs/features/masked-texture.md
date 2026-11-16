# Masked Texture

## Status and scope

[Masked Texture #80](https://github.com/VaclavKlima/Irodori/issues/80) now has
an application implementation in **Masks → Adjustments → Texture**. The
user selected completing the feature after the fixed-method photo study and
shared-consumer proofs. Production GPU preparation, root settings, history,
UI/API/MCP and preview/export integration are implemented.
**Bazzite background functional verification and macOS qualification are
complete.** The Mac record below includes approved native Texture and Sunflower
visual checks. Bazzite foreground checks, Windows and physical HDR acceptance
remain pending. Raster WebGL2
retains its original source with a private Float32 candidate/union overlay after
the legacy pass, with exact native protection outside the union and Fit
compatibility outside the affected sampler footprint. This status supersedes
earlier research-only stops;
the dated evidence and original proposals below remain preserved history.

The original review preferred Texture +25 on feathers and reflected legs, with
inconclusive ripple benefit and a better overall combined image. The later
ordered active-Light/Color review preferred **Active Light/Color + ordered
Texture** for feathers, ripples, reflected legs and Fit on the tested photograph.
Skin preferred **Neutral / Fit**. Foliage had no clear Fit difference; native
views preferred global sharpening 50/1/50 or Texture +25 without one winner.
These are bounded preferences, not a universal quality or strength default.
The earlier sharpening review found Neutral less grainy, Standard crisper for
stars and Wide unprotected preferable in the soft foliage example. That context
motivated selective treatment; it did not establish Texture quality.
No method, source, strength, manual mask or numerical gate was retuned.
Refine Edge #78 remains separately blocked; automatic selection is not a new
prerequisite. Clarity #81, Dehaze #79 and stronger denoising #41 remain separate.

## Full application integration — 2026-11-15

Each top-level mask owns one integer **Texture amount −100…+100**, default **0**.
Positive values emphasize fine/mid detail; negative values soften it. The compact
control follows Light and Color and uses the existing numeric/slider, independent
Texture reset, draft/commit/cancel, keyboard, photo-wide Undo/Redo and restart
owners. Typed API/MCP creation starts at zero; root updates accept the same
amount, including an update paired with creation in one atomic mutation.
Duplication retains it. Settings **20** / catalog **30** migrate neutral zero into
current settings and every history snapshot while preserving prior edits,
revisions, cursor, branches and timestamps. Global presets/copy-paste continue
preserving the destination's spatial masks.

The frozen `masked-texture-llf-residual-v1` operator runs through the common
isolated Dawn owner, with no production import from research tooling. Global
Detail precedes committed native crop; global point edits precede bottom-to-top
mask roots. Each root reads the complete preceding signed Float32 result and
applies **Texture → relative Balance → six Light operations → Saturation → one
final coverage blend**. The crop-local native grid determines scale, independently
of zoom or display sampling. Linear sRGB and Rec.2020 retain their actual domains,
alpha and signed/above-white values. Zero amount bypasses spatial work exactly.
Existing brush, gradient, generated, compound, range and prepared-edge coverage
feed the shared canonical mask program; operands do not acquire Texture controls.

The main-owned prepared-stack receipt and source leases keep creative prefixes
distinct from ordinary working sources. Its source/grid/frozen point/ordered
mask identity and candidate/Float32-union hashes prevent stale publication or
double application. Actual legacy native output is retained outside the Texture
union and at alpha zero before downstream resize/encoding; final resampling and
JPEG blocks may affect neighboring output pixels. Browser presenters retain the
original source and apply private prepared candidate/union resources after the
legacy pass. Raster WebGL2 preserves exact legacy native pixels outside the
Texture union and at alpha zero. Fit preserves legacy presentation outside the
affected sampler footprint; reduced pixels can include neighboring Texture
through filtering and mips. Fit computes UV gradients before divergent coverage
branches and samples with explicit gradients, keeping source-edge sampling
defined without changing the filter modes or native fetch path. Encoded proof
bitmaps are not its presentation source. Native HDR exports keep independent
prepared HDR content and authored SDR primary pixels. HDR headroom follows the
selected **unrounded** content under the existing policy, not decoded half values.
Interactive HDR histograms consume the same prepared context.

All extra parents/prefixes, coverage, readback, renderer and concurrent crop/edge
owners count against the unchanged frozen resource policy and device limits.
The **24 MP ceiling is not an admission promise**; larger live reservations or
unsupported domains can refuse a smaller photo. GPU/domain/resource failures
report the actual reason and preserve authored edits; no equivalent CPU feature
fallback, clipping/normalization, lower-resolution retry or relaxed quality gate
is introduced. Prepared sources and caches keep their existing cancellation,
publication and cleanup owners.

During transient crop framing, Texture is omitted on the uncropped working view
while existing Light/Color edits remain. The crop panel states **Texture preview
resumes after applying crop**; applying the committed grid prepares Texture again.
Before retains its original unfiltered source. Curve targeting and source-stable
range classification keep their existing source taps.

Exact HDR service statistics, exact HDR pixel queries and native clipping with
active Texture are **explicitly unavailable**: the old point-only exact protocol
cannot classify the prepared spatial result. This does not disable normal
preview, interactive histogram or frozen output. Physical HDR appearance,
full-source transformed/tiled quality, cold activation/responsiveness and broad
photographic acceptance are not inferred from focused technical cases.

The reconciled background evidence records **1,169 distinct passing cases** on
RX 7900 XTX: 1,114 Node/service cases
plus static/build checks, 51 RAW/GPU cases in 46.92 s, three actual application
UI cases and the expanded raster WebGL2 case. This is acceptance reconciled
across the selected invocation and exact corrective reruns, not a relabelled
clean invocation. The original registered run remains failed on the new raster
case's 45-second watchdog. The unchanged pixel gates subsequently pass with its
120-second watchdog, and batched observation of the same every-pixel comparisons
completes in 6.49 s. Retained failures and corrective runs remain linked.

Eleven additional native producer/HDR cases pass in 44.82 s on the actual
integrated RADV Raphael-Mendocino adapter. Browser adapter selectors continued
to choose ANGLE RX 7900 XTX, so browser iGPU execution is **unverified** and the
current application evidence is for RX 7900 XTX only. Two required native
foreground visual cases await explicit approval and execution. Physical HDR
appearance, broad photographic/performance qualification and the limits above
remain separate. The [integration contract](masked-texture-integration.md)
records ownership and retained earlier failures.
[Other-device #122](https://github.com/VaclavKlima/Irodori/issues/122) tracks
macOS/Windows qualification after publication of an identified common source
commit. #80 remains open for the pending native foreground checks. Local ignored
reports are retained under `artifacts/masked-texture/2026-11-15-full-delivery/`
(`summary.md`, `details.md`, `result.json`); they are not published GitHub assets.

## macOS qualification — 2026-11-16

[Issue #122](https://github.com/VaclavKlima/Irodori/issues/122) resumes on macOS
26.7 (25G229), Apple M4 Pro with 24 GiB unified memory and its 16-core GPU,
bundled Node 24.20.0 and Electron 44.3.0. The isolated GPU reports
`apple apple-m4-pro (Metal driver on macOS Version 26.7 (Build 25G229))`.
The native mask host is rebuilt from current sources with the retained Rust
1.90.0 toolchain. The accepted C++ HDR codec distribution remains unchanged.

The background qualification found a reproducible raster comparison defect:
with active local Light at a fractional letterboxed scale, the creative shader's
Before branch differed from full Before near source edges. It affected both
legacy and prepared Texture presentation. Split now redraws its Before half
through the same ordinary/spatial Before program and source, using a scissor
that follows the exact fragment-center split boundary. The After and prepared
Texture passes retain their existing shader math and sampling. Scissor, program
and active texture state are restored before validation and analysis. The
regression checks every legacy and prepared split byte at DPR 1 and 2, in
addition to the existing native/union/alpha, Fit, histogram and clipping gates.
This corrects transient comparison composition; frozen output and cache pixel
policies are unchanged.

The Mac launcher also misidentified repo-local Node descendants because its
process inventory matched the full path. Executable-name classification fixes
the existing shutdown regression without weakening confirmed-exit ownership.
The functional Texture layout test now uses the actual native window resize
helper instead of viewport emulation; its hidden Mac pass does not establish
Wayland presentation after that harness change.

Reconciled background acceptance covers **54 distinct selected feature and
comparison cases**, plus **1,034 cheap Node cases**. The 21 isolated processing,
worker, HDR-consumer and frozen-output cases pass in **31.72 s**; the final
Texture application/raster batch passes four cases in **22.14 s**, with its
native case deferred. The distinct-source raster comparison passes three cases;
the comparison UI's retired automatic-Canvas2D assertion is corrected to verify
explicit GPU error/retry and exact edit/view preservation. Its exact rerun
passes in **4.82 s**. The accepted unchanged codec's encoded Texture round trip
also passes in **4.53 s**. The 34 Linux-only native RAW checks remain unavailable
on Mac. Type checking, lint, formatting and the application build pass; the final
test-only change has targeted lint/format and type-check evidence. This is
reconciled acceptance across original invocations and exact corrective runs,
not a relabelled clean invocation or a comprehensive checkpoint.

The final hidden app batch records five launches across four isolated profiles,
all windows closed, no show/focus events or policy violations, and all four
profile directories removed. Native GPU presentation uses ANGLE Metal on the
Apple M4 Pro. No CPU feature fallback, changed image operator, numerical/quality
gate or reduced-resolution recovery is introduced.

The user subsequently approved the two native checks. Sunflower's native
1100 × 700 and 1440 × 1000 assertions pass in the initial **2/2, 12.35 s**
foreground invocation. Its fourteen tool screenshots were visually reviewed
against freshly rendered references, retaining the approved List + Beside
browser, Little Jizō and actual implemented-control/data differences. No blocking
composition, overlap or clipping defect was found.

The first Texture screenshot was rejected during visual review: the test's
earlier geometry/edit-ready assertions allowed capture while the photograph was
still loading. The native case now also requires completed prepared-mask
state/key agreement, full resolution, visible canvas and the exact revision's
photo-presentation context reporting `presented`. Its corrective invocation
passes **1/1 in 6.91 s**. The accepted native screenshot shows the committed
flamingo photograph, SDR presentation, Texture +25, reset and Console at
1100 × 700. This fixes test readiness; no production presentation change or
arbitrary delay was needed. The earlier premature capture remains retained.

Mac qualification therefore covers **56 distinct selected cases plus
1,034 cheap Node passes**, with no pending Mac foreground case. Native windows
closed and their isolated profiles were removed. The user then approved
publication of all seven reviewed source, test and documentation files. This
revision delivers the Mac corrections and acceptance record; #122 continues to
track unverified Windows qualification. It does not establish acceptance of
#80's separate Bazzite foreground checks.

Windows, physical HDR luminance, real authored-HDR
photographic appearance, broad quality/performance and the exact HDR service
analysis/clipping limits remain outside the background evidence. Local attempts
and corrective runs are retained under
`artifacts/masked-texture/2026-11-16-macos-qualification/` and linked verification
directories; the original failed runs remain failed.

## Bounded prototype checkpoint — 2026-11-14

Local research tools live in `scripts/research/masked-texture/`; their
[reproduction guide](../../scripts/research/masked-texture/README.md) explains
the owned background runner and separate photographic review. The frozen
`assets/tests/references/masked-texture/protocol.json`, independent float64
reference generator/output and source-only photograph manifest were hashed
before candidate execution. The sampled residual uses four finite Gaussian
levels, bands 1/2, 97 anchors, signed-asinh luminance and alpha-weighted filtering,
with coverage applied after nonlinear reconstruction. It preserves chromatic
differences without an SDR clamp. This is an explicit research adaptation of the
pinned MIT Halide example, not full implementation parity.

Evidence is private/generated under
`artifacts/masked-texture/2026-11-14-prototype/`:

- `numeric-04/summary.md`: 19 independent GPU reference cases passed in **1.58 s**
  on RX 7900 XTX / RADV Mesa 26.2.6. Maximum absolute RGB error was
  **2.3842e−7**, within unchanged `2e−6 + 2e−5 × |expected|` gates. Neutral,
  zero-coverage, hidden RGB, alpha and flat-source word checks passed. Frozen
  fine/mid-band, noise and step screens passed; a bounded 97×97 impulse had
  unchanged words outside the 32 px support bound. This probe is not general
  tiled/composed-halo qualification.
- `photo-03/summary.md` and `photographs/result.json`: the 2344×2708 flamingo run
  completed in **15.17 s**, with twelve independent mask/amount variants, Neutral,
  production global sharpening 50/1/50 and a sequential combined proof. Feather
  +25 → reflected legs +10 → ripples −25 materializes/reprepares each preceding
  native Float32 result. Photographic masks are disjoint partial radial regions;
  the small reference cases separately test overlapping order.
- All thirteen candidate/combined proofs retain exact zero-coverage/alpha/hidden
  working words and unchanged original-production RGBA pixels where coverage is
  zero. The prepared Neutral equals the original production proof exactly.
  Simultaneously retained LLF/proof/comparator owners are admitted within the
  unchanged Automatic RAM and conservative **2 GiB** GPU policy; the recorded
  largest GPU plan is **576,587,264 bytes**. No CPU feature fallback/repair ran.
- `photo-03/gallery.html` embeds all PNGs and receipts. The isolated HTML-only
  headless check loaded **24/24 images**, confirmed native 512 px crops and the
  Fit toggle, with no missing requests or script errors. No foreground window
  was opened. Numeric and photographic timing is bounded evidence from this
  research harness, not an editor responsiveness benchmark.

Initial inspection finds the modest feather treatment subtle, with a clearer
enhancement/softening distinction at stress settings. The existing sharpening
reference appears crisper on feather contours. The viewed native and combined
Fit images show no obvious new seam, but this limited first look does **not**
establish useful photographic quality. User gallery review remains pending;
skin/foliage are deliberately inactive and no parameter/method cycle starts.

The first attempt failed WGSL compilation on a reserved identifier. Subsequent
changes corrected that name, creation-failure cleanup and simultaneous resource
accounting without changing the frozen math, masks or thresholds. Every earlier
attempt is retained; final proof hashes equal the first successful photographic
run. The final registered contract target is `masked-texture-prototype`.
Frozen protocol/oracle JSON bytes are formatter-exempt and hash-checked by that
target; they were not reformatted after seeing output.

The prototype is uncommitted and not enabled in Irodori. Arbitrary active global
or local point edits, other mask kinds, RAW/photographic HDR, tiling, output
integration, UI/history/restart, integrated Radeon and other platforms remain
unverified. Those require separate selected delivery after a worthwhile proof.

### User photographic feedback — 2026-11-14

The user reviewed the self-contained flamingo gallery and selected **Texture +25**
for both feathers and reflected legs, could not distinguish the ripple examples,
and found the combined images better overall. The combined proof they viewed was
plumage +25 → reflected legs +10 → ripples −25; this feedback does not retroactively
change it to the preferred individual strengths or prove that ripple softening
helped. Exact gallery identity and verbatim feedback are retained in
`artifacts/masked-texture/2026-11-14-prototype/user-feedback-01.json`.

This establishes useful first-image benefit sufficient for the previously
conditional skin/body-hair and foliage checks. Freeze their native source-only
regions, manual masks, untouched controls and source identities separately before
candidate rendering. Keep the same method, −25/+25 and declared −100/+100 stress
strengths and all existing gates. Preserve the initial protocol/crops and every
earlier receipt. The new examples still need their own quality review; there is
no automatic tuning or full settings/UI/history/export integration.

### Supplemental checkpoint — 2026-11-14

The separate `assets/tests/references/masked-texture/supplemental-cases-v1.json`
was source-only reviewed, formatted and frozen before supplemental GPU execution
(SHA256 `54627d431ba43057c03be9c1b8993f4e42d9ac96839745e3a9a470fadb8a6ec0`).
It retains the original protocol and unchanged numerical evidence, selects one
partial radial per source, and fixes the existing two native 512 px crops and
two untouched controls each. All original/notice identities and the current-v4
forest master, motion mask and 86 source strips are authenticated.

`scripts/research/masked-texture/supplement.mjs` runs exactly one selected case,
with safe fresh destinations, the original numeric bundle/dependency prerequisite,
bounded isolated GPU ownership, native zero-coverage/alpha/hidden-word and original
production proof checks. It retains the four fixed nonzero strengths, Neutral and
existing global sharpening 50/1/50. Candidate scene-linear Rec.2020 descriptors
update both overall and 64-row strip hashes before unchanged production SDR proof;
the source is never overwritten or clipped to fit the admitted feature domain.

Local evidence under `artifacts/masked-texture/2026-11-14-supplements/`:

- `skin-run-01/summary.md`: 4272×2848 anonymous forearm/body-hair, **10.44 s**;
  four variants retain exact unmasked native words and original proof pixels.
- `forest-run-01/summary.md`: 3645×5465 retained v4 scene-linear master,
  **18.93 s**; the same four exact gates pass. Neutral equals the original proof
  on both inputs. Peak simultaneous GPU plans are **1,099,627,912 bytes** and
  **1,794,844,356 bytes**, within unchanged conservative 2 GiB policy.
- Each `gallery.html` embeds twelve native crops and three Fit images, with the
  exact source manifest and technical receipt. The isolated HTML-only checks load
  **15/15 images each**, verify source PNG hashes and native sizing, and exercise
  the Fit toggle without missing requests or script errors.

Initial inspection finds subtle skin softening at −25 without an obvious new
hair-edge artifact in the viewed crops, and subtle foliage definition at +25
on the already soft source. The boundary crop shows no obvious new seam in this
limited review. These observations permit presentation for user review; they do
not establish a complete photographic pass or justify full integration. The same
candidate and strengths remain frozen. All new quality feedback is still pending;
no further candidate/source/parameter cycle or foreground test starts.

### Supplemental user feedback and research conclusion — 2026-11-14

The user's exact response was **"Skin: Neutral / Fit"**. For foliage they could
not clearly distinguish the Fit views and preferred **"Global sharpening 50 / 1 /
50 or Texture +25"** in zoomed views. Preserve those viewing-scale distinctions:
the response does not select one native foliage winner or describe a general
failure of negative Texture. It supplies no separate skin native-crop assessment
or reason to infer an artifact-free quality pass.

| Example                   | Reported preference                                                  | Limit                                              |
| ------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Feathers / reflected legs | Texture +25                                                          | Selected local examples, not a global default      |
| Ripples                   | No clear difference                                                  | Neither enhancement nor softening benefit shown    |
| Skin                      | Neutral / Fit                                                        | Negative Texture benefit unestablished here        |
| Foliage                   | No clear Fit difference; sharpening 50/1/50 or Texture +25 at native | No single winner or ordinary-view benefit selected |

Exact feedback and both gallery hashes are retained in
`artifacts/masked-texture/2026-11-14-supplements/user-feedback-01.json`; the dated
`research-conclusion.md` supersedes earlier pending-user-review notes while
preserving their technical evidence. The combined flamingo recipe and every
frozen source, crop, mask, amount, threshold and receipt remain unchanged.

This supports Texture as an optional selective positive treatment, while skin
softening and ripple benefit remain unestablished. Stop the fixed-candidate study
without another source/strength/method cycle. Preserve the proposed neutral
default and all full-feature acceptance limits. The next proposed deliverable is
the bounded design of the ordered mask insertion/source-grid route and shared
history/preview/export contracts; this feedback does not itself authorize full
feature implementation, publication or adoption.

### Internal ordered GPU proof — 2026-11-15

The user selected the integration design's bounded next proof. New research tools
and explicit `masked-texture-order-model` / `masked-texture-order-gpu` targets
exercise the unchanged LLF method with global Exposure/Contrast/Saturation and
local Balance/six Light/Saturation, complete previous-prefix inputs and one final
coverage blend. The [reproduction and limits](../../scripts/research/masked-texture/ordered-README.md)
separate this seam proof from production integration.

The first setup stopped on a scene shader's unused precision binding; an explicit
layout/error-reporting correction passed the exact failing case. The first full
matrix then rejected a synthetic 0.125 EV local control, which the actual
hundredth-step validator does not admit. Keep v1 protocol/reference/generator and
all failures unchanged. V2 corrects four generator control sites to 0.12 EV (eight
fields in four cases), retaining every source/mask/crop/Texture strength, method,
tolerance and photo control. Actual production validators preflight all controls.
This is a versioned authoring-contract correction, not output-driven tuning.

Final evidence at `artifacts/masked-texture/2026-11-15-ordered-proof/`:

- **14** independent cases pass, including overlap/reorder/two Texture roots,
  partial and hidden alpha, zero/disabled/empty bypass, plus actual GPU odd crop,
  quarter-turn and fractional-straighten/canonical-coverage checks.
- Separate GPU working-prefix and actual native output guards pass. **28**
  Float32 SDR RGB / packed RGBA8 consumer checks retain legacy words outside the
  Texture union and at alpha zero, while visible inside-union words equal the
  candidate and show actual changes. Source/context, post-global domain, alpha
  and resource refusals pass. These are explicitly source-bound research results,
  not ordinary unedited `WorkingAsset` reuse.
- Registered model/GPU verification: **1,078 passed, zero failures/skips,
  81.61 s**. The routine 60 s warning and slow-test evidence remain recorded;
  assertions were not removed. Exact invocation summary:
  `artifacts/verification/2026-11-15T10-29-20.815Z-check-q48nHx/summary.md`.
- The same bundle's gated flamingo photograph completes in **6.69 s** on
  RX 7900 XTX / RADV Mesa 26.2.6. Three roots run bottom-to-top with prospective
  active global/local Light/Color. **5,948,928** outside-union working/actual-proof
  pixels and four untouched controls stay exact against the active-point legacy
  baseline. All pixels are finite and alpha is unchanged. No CPU filter fallback.
- `photo-01/photograph/gallery.html` embeds nine native crops and three Fit
  images. The isolated HTML-only check loads **12/12**, with exact PNG/receipt
  hashes, native sizing and working Fit toggle; no request/script failures.

The viewed feather/reflection/ripple pairs show no obvious new insertion seam;
the modest texture changes remain local. Compare **active Light/Color legacy**
against **the same edits plus ordered Texture**; original Neutral is context,
not an equal-point-settings baseline. This limited inspection is not new broad
photographic acceptance or a revision of the user's earlier preferences.

Global WB/curves/mixer/grading and vibrance remain neutral in this matrix; white
is 1. Scene-linear inputs exercise actual SDR output only. Native HDR planes and
metadata, authored HDR/SDR pairs, Electron presentation/histogram/analysis,
nonanalytic coverage, worker publication/cache/restart/UI/history/API and other
adapters remain unqualified. Tiny crop gates do not establish full-source tiled
or transformed-photo acceptance. No app setting/control, commit/push, foreground
test, full checkpoint or automatic further source/parameter cycle is selected.

### Ordered proof user review — 2026-11-15

The user selected **Active Light/Color + ordered Texture** for feathers,
ripples and reflected legs, and **Active Light/Color + ordered Texture / Fit**
for the overall image. These are preferences in the frozen active-Light/Color
comparison, not a revision of the earlier neutral-point or skin/foliage reviews.

The reviewed gallery SHA-256 is
`17decb27c7c96064598a8902ecd3408f3f14af4725c8d77c702d2c2af3c6aae1`.
Exact feedback and its scope are retained in
`artifacts/masked-texture/2026-11-15-ordered-proof/user-feedback-01.json`;
the adjacent `user-review.md` supplements the unchanged technical receipts.
No amounts, masks, crops, method or acceptance gates change after this review.
The preference supports this combination on the tested photograph, without
establishing absence of halos/color shifts, broad quality, HDR acceptance or a
new default strength. The proposed default remains zero.

The next proposed deliverable is explicit shared-consumer integration and
consumed-stage tracking for preview/export before persistence and UI. This
feedback records the completed review; it does not select that implementation
or further visual experiments. #80 remains open and in progress.

### Shared SDR consumer checkpoint — 2026-11-15

The next selected slice now implements explicit prepared-point consumption in
the common native GPU renderer, isolated preview worker and frozen SDR output.
The [integration checkpoint](masked-texture-integration.md#focused-current-device-checkpoint)
records **1,084 passing focused checks** on Bazzite, eight additional integrated
Radeon cases, retained failures and exact reruns. Candidate/union and actual
parent-stream hashes, complete point-context identity, exact legacy native-word
selection, source-cache refusal and shared resource admission are checked.
Thirty-three prior dirty/research files remain unchanged; unrelated Console
work and original research evidence are preserved.

This is an internal consumer contract, not an enabled Texture feature. The
ordered Texture preparer remains research-only. Production preparation,
live lease/cache/publication scheduling, HDR/authored pairs, persistence/history,
UI/MCP and full photographic/platform acceptance remain incomplete. The next
proposed step is connecting the ordered preparation owner to this verified SDR
boundary; no further implementation is selected automatically. Other-device
consumer checks are tracked by [#122](https://github.com/VaclavKlima/Irodori/issues/122).

## Original first-version proposal

- One **Texture** amount, integer **−100 to +100**, default **0**, per existing
  top-level mask. Negative softens texture; positive emphasizes it. A fixed
  internal scale policy avoids another Radius/Threshold panel.
- Put the control in **Masks → Adjustments → Texture**, following Light and Color.
  Reuse `AdjustmentInput`, the existing section reset, draft/commit/cancel rules,
  photo-wide Undo/Redo and keyboard behavior. Reset only Texture to zero.
- Use all existing mask kinds and final composed coverage. A reflection may have
  its own mask/amount. No automatic object inference, synthetic detail generation,
  deblurring or new selection tool is added.
- Zero amount is an exact bypass with no new spatial work; a zero-coverage pixel
  remains exactly the previous result on the native working grid before output
  rendition, resizing and encoding. Keep alpha and hidden transparent RGB.
  Resampling footprints and JPEG blocks can change neighboring encoded pixels;
  do not promise byte-identical unmasked JPEG regions.

This is the proposed compact control arrangement, not an implemented UI:

```text
Masks / Adjustments
  Light
  Color
  Texture                                  Reset
    Amount       −100 ─────── 0 ─────── +100
                 Soften                 Enhance
```

Before renderer implementation, review the actual existing Sunflower inspector
with this one section, including the 1100 × 700 Console-open state. This sketch
does not replace that presentation check. No foreground window is needed for
planning; any later foreground inspection is selected explicitly.

## First deliverable: one bounded photographic feasibility proof

The next implementation step should be a **research-only proof**, with a frozen
numeric/processing contract and one candidate. It must show a worthwhile result
before full settings/UI/history/export integration. Do not implement the whole
feature merely because an operator runs on GPU.

The candidate is a scale-limited, edge-aware local Laplacian treatment. The
[2011 author project](https://people.csail.mit.edu/sparis/publi/2011/siggraph/)
and [2014 fast-filter paper](https://people.csail.mit.edu/sparis/publi/2014/tog/Aubry_14-Fast_Local_Laplacian_Filters.pdf)
provide an established multiscale method rather than another sharpening-radius
sweep. The proposed Texture adaptation changes selected fine/mid pyramid bands,
initially targeting approximately 2–8 native photo pixels, while preserving the
finest band and broad base. These scale choices are an Irodori proposal, not a
claim to reproduce another application's proprietary Texture algorithm.

The official [Halide example](https://github.com/halide/Halide/tree/main/apps/local_laplacian)
supplies a concrete algorithm/reference implementation and GPU scheduling
example. Its [license](https://github.com/halide/Halide/blob/main/LICENSE.txt)
permits reuse with notices. Pin the exact revision and applicable notices before
copying or adapting code. Its normalized integer input, luminance convention,
RGB reconstruction and output clipping are **not** a drop-in signed/HDR contract
for Irodori. Do not add Halide as a production dependency or another CPU/GPU
backend merely to run this example.

The product distinction is consistent with Adobe's description of
[Texture and Clarity](https://helpx.adobe.com/lightroom/web/edit-photos/apply-effects/adjust-effects.html):
Texture changes textured detail; Clarity is a separate edge-contrast control.
That product reference provides no claimed Irodori performance or quality pass.

### Freeze before any candidate rendering

1. Write a versioned research protocol: exact pyramid kernels, selected levels,
   remapping curve, sampling/approximation policy, amount mapping, boundary support
   and full-frame/tile coordinate phase. Freeze modest amounts `−25 / 0 / +25`
   and stress amounts `−100 / +100`; no result-driven radius/parameter sweep.
2. Use luminance with the actual primaries, retain signed and above-white values,
   and specify the reversible luminance coordinate/reconstruction explicitly.
   Preserve chromatic differences and alpha. Do not clamp to SDR or normalize
   each photograph's exposure to accommodate the reference implementation.
3. Trace the current preview/export/analysis source grids and fix one common
   Texture insertion point. Preserve the existing ordering of global edits,
   crop/lens geometry, mask operations, output resizing and authored HDR/SDR
   renditions. A shortcut that moves existing nonlinear edits and changes
   unmasked native working pixels is not acceptable. Compare against the existing
   pipeline, not just the candidate's input: changing a point shader's execution
   owner can also change arithmetic outside the mask. Keep this check in the
   first feasibility gate. Scale is tied to the authoritative native
   photo grid, not CSS zoom; freeze its mapping for every output rendition.
4. Freeze small independent reference vectors and the new operator's numerical,
   halo, texture and noise gates before generating the photographic candidate.
   Keep all existing gates unchanged. No missing reference becomes acceptance.

Those are required outputs of the first design/feasibility slice; their exact
numeric kernel and approximation constants are not silently adopted by this
planning draft.

### Fixed photographic comparison

Reuse committed, reviewed originals and their permission/attribution records:

| Input                                        | Purpose                                                                             | Limits                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Wikimedia flamingo/reflected-legs photograph | Plumage, ripples and independently treated reflection; freeze separate manual masks | Reflected legs are available, not a complete reflected bird.                       |
| Zephyris `ArmHair.jpg`                       | Negative Texture on skin/body hair; positive-strength grain check                   | Processed SDR JPEG, no portrait-face/scalp-hair acceptance.                        |
| Verified forest v4 source from #43           | Fine foliage and a retained blend boundary                                          | No new merge/deghost-correctness claim; authenticate the original retained source. |

Freeze source-only crops, masks and moderate/stress amounts before viewing output.
Compare Neutral, existing saved-detail sharpening at 50/1/50 and the one Texture
candidate at Fit/native scale. The sharpening comparator is for visible benefit
and grain/rims, not a claim that these operators must have identical effects.

The proof must demonstrate useful fine-detail control on feathers/ripples and
controlled skin softening, independent reflection strength, exact unmasked native
working pixels before output conversion/resizing/encoding,
and no material new halo, mask-boundary seam, coarse-contrast shift or unacceptable
grain at modest settings. Inspect smooth regions and strong boundaries alongside
texture. Use the self-contained gallery pattern from #43 so the browser needs
access to only one HTML file.

Stop after the one candidate and this small fixed comparison. If it does not
clearly justify integration, retain a rejection/incomplete report and review the
effort before another method or parameter cycle. A successful small proof is not
full feature acceptance or permission to weaken a gate.

## Recommended integration contract after a worthwhile proof

The [November 15 integration design](masked-texture-integration.md) grounds this
proposal in the actual production ordering and crop geometry. It explicitly
separates canonical coverage from the crop-local native filtering lattice,
unblended Texture from the final root composite, and prepared point edits from
unedited sources. Its unresolved proof gates supersede assumptions in this
original high-level recipe.

Preserve existing bottom-to-top stack semantics. Each nonzero Texture mask should
read the preceding ordered result, use neighboring image pixels regardless of
that mask's boundary, apply its existing relative balance/Light/Color operations,
then perform the existing final coverage blend once:

```text
textured = Texture(previous, this mask's amount)
local    = existing mask Light/Color(textured)
next     = previous + coverage × (local − previous)
```

This recommendation avoids changing how overlapping masks depend on earlier
masks. It has a real cost: editing/reordering an earlier mask can invalidate
later spatial work. A reusable detail field that ignores preceding mask edits
would be a different stack policy, not an unannounced optimization. Prove the
recommended order and source-grid route in the first slice before broad coding.

Use the existing isolated native Dawn/WGSL worker and bounded spatial ownership
infrastructure, not a second renderer or CPU image fallback. Reuse strip/halo,
lease, admission, cancellation, stale-result and GPU retry owners; the existing
global Detail stage's position does not automatically make it the right insertion
point. Bound retained prefix/intermediate storage rather than caching a full
Float32 frame for every mask. Refuse excessive work without lowering resolution.

Sequential spatial masks also compose their receptive fields. A final output tile
can require larger prefix halos than one Texture operation. Either materialize
and drain validated prefix frames within the frozen budget, or derive and admit
the complete composed support for streamed tiles. The existing global Detail
stage's three-strip window is not automatically sufficient. Include all prefix
halos/intermediates in admission and test complete-frame versus tiled output with
overlapping and reordered Texture masks.

Texture gestures may commit an expensive spatial calculation, with immediate
control feedback, honest pending state and cancellation. Preserve established
Light/Color behavior, valid draft flushing and revision/target attribution. Do
not claim interactive performance or add speculative optimizations before a
matched available-device measurement demonstrates a problem.

## Full feature delivery, only after the proof

1. **Shared settings/history:** add a versioned neutral Texture group to
   `MaskDescriptor`/`ResolvedMask`, mutation validation and capabilities in
   `src/shared/masks.ts`. Migrate current settings and every historical snapshot;
   bump settings/catalog/rendering identities when implementing. Include Texture
   in effective pixel identity, neutral detection, enable/invert/reorder and
   resource admission. Preserve independent base/correction content and coverage
   cache reuse.
2. **Common processing/consumers:** the same selected operation and frozen order
   must feed preview, authored HDR and SDR primary, histogram/clipping, native
   inspection, output proof and frozen exports. Prevent downstream consumers
   from applying already-prepared point/mask work twice. Geometry changes must
   invalidate derived results while reusing immutable source decoding.
3. **Shared UI/API/MCP:** reuse `Masks.tsx`, `useMasks`, main-owned mask mutation
   services and atomic `irodori_mutate_masks`. One completed gesture/reset is one
   photo-wide Undo step; retain expected revision and frozen Console targets.
   No new independent persistence or arbitrary filesystem/shader API.
4. **Focused acceptance:** register unique model/numeric/GPU/photographic and
   integration targets as needed. Check exact neutral/zero-coverage/alpha,
   partial-mask boundaries, full versus tiled output, HDR/signed channels,
   overlap/reorder, cancellation/device loss, resource refusal, Undo/Redo/restart
   and frozen SDR/HDR export. Reuse unaffected history/selection checks and stop
   after relevant complete checks; no automatic comprehensive checkpoint.

Implement and verify on the available Bazzite device first, with the same backend
and portable contracts. Record actual adapter execution; use the integrated
Radeon for focused checks where applicable. Other-device acceptance remains
incomplete and gets a named linked follow-up at delivery. No unsupported GPU
failure may silently restart equivalent CPU processing.

## Concrete code owners to inspect before implementation

- Settings/validation: `src/shared/masks.ts`, `src/shared/edits.ts`, catalog editing
  migrations and `src/shared/masks-gpu.ts` packing/pixel identities.
- Atomic publication: `src/main/mask-store.ts`, `src/main/library.ts` and existing
  source/resource preflight before a new history revision.
- Spatial work: `src/main/processing/detail-bands.ts`, `detail-preparation.ts`,
  `src/main/gpu/spatial-detail.ts` and the current mask point-stage consumers.
- UI: `src/renderer/src/components/Masks.tsx`, `hooks/useMasks.ts`, shared
  `AdjustmentInput` and existing section/draft/reset patterns.
- API/agent: `src/main/editor-endpoint.ts`, `scripts/editor-mcp.mjs` and
  `src/shared/agent-guidance.ts`.

At this historical proposal checkpoint, the research tools and bounded neutral
photographic proof were implemented locally with the recorded preferences and
limitations. The ordered design and limited internal proof had separate recorded
checkpoints; proposed next work was shared-consumer integration, including then
unqualified HDR/analysis paths, before persistence and UI delivery. The current
application implementation and remaining acceptance limits are recorded above.
