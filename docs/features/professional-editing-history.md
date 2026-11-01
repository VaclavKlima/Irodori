# Historical professional-editing plan

**Archived on 2026-11-01 when the user requested individual TODO tasks.**
The snapshot below preserves the former two-goal plan, evidence, failures and
acceptance requirements. Its instructions to continue the whole milestone, finish
all gates together or wait for Goal 1 before every later tool are historical.
Use the [current task index](professional-editing.md) and
[canonical backlog](README.md#workspace-feedback-backlog) for new work.
No unchecked criterion became a pass through this reorganization.

---

# Professional editing foundations before masking

## Status

**Implementation in progress; full milestone established 2026-10-25.** The user
accepted the [Lightroom-inspired two-goal split](lightroom-comparison.md) on the same
date. **Goal 1: Everyday global photo editing** is the current delivery focus.
**Goal 2: Advanced global control and reusable looks** follows it. The overall
professional-editing objective stays active across both goals; finishing Goal 1
alone does not complete that objective or establish readiness for
[local adjustments and masking](local-adjustments.md).

The accepted change brings crop/straighten and selective copy/paste forward, keeps
color grading, denoising, sharpening and ordinary enlargement in Goal 1, and moves
advanced curves, named presets, final-size proof/output sharpening and the optional
FSR decision to Goal 2. Preserve all existing feature work, original scope and
acceptance thresholds. Curve mathematics remains retained research until Goal 2;
its passing tests do not enable a curve tool in Goal 1.

The [processing decision record](professional-editing-processing.md) tracks the
source domains, independent references and fixed acceptance gates. Inspector,
Saturation/Vibrance, supported neutral white-balance picking, crop/straighten,
eight-range HSL and three-way grading have focused functional evidence. Combined
real RAW/raster/ISO gain-map and genuine v4 merge edit/export/restart checks now
pass, alongside a source-matched neutral preview comparison. Focused native
keyboard/minimum-size, full-source resource refusal/cancellation and 1.25×
full-size SDR export checks also pass. Strong-noise photographic quality and
remaining sustained responsiveness stay open; see the
[combined checkpoint](professional-editing-processing.md#goal-1-combined-real-source-correctness--2026-10-29)
and the later dated native/resource records.

Goal 1 slice 4 now exposes single-image Luminance/Color noise reduction and detail
Amount/Radius/Threshold through the inspector and the shared edit/MCP API.
Settings **11/catalog 21** add neutral defaults transactionally while preserving
older crop, color and history settings. Spatial changes rebuild prepared native
sources on commit; point-color edits reuse those sources. The selected bounded
NLM followed by protected luminance sharpening runs before geometry and manual WB.
Its independent numerical/quality references, resource limits and earlier
CPU/GPU/native checkpoints remain in the [detail record](detail-processing.md).

Real portrait review on 2026-10-29 found that the current fixed-bandwidth NR v1
underfilters heavy ISO 6400 noise, including at its maximum. The user chose to
improve strong-noise removal **within Goal 1** before accepting it. Existing
mathematics, snapshots, export/batch receipts and quality limits remain preserved;
noise-aware candidates require an independent, predeclared comparison and an
explicit compatibility plan before adoption. Goal 2 integration still follows
Goal 1 acceptance.

The user's [performance direction of 2026-10-31](../performance-decisions.md)
accepts a loading period for expensive denoising, distinguishes it from continuous
color feedback, and requires an effort/benefit decision before costly optimization.
Strong-noise quality remains a Goal 1 requirement. Existing numerical gates and
historical results retain their scope; no instantaneous denoising target is added.

The user subsequently prioritized [GPU-only cleanup](../gpu-processing.md) and
remaining Goal 1 checks before further denoising research. Detail and fractional
crop preparation now select strict GPU handling by default, with explicit
precision limits. Both available Radeon adapters have focused numeric/cleanup
evidence, and real-Sony native minimum-size/Console-open checks were refreshed.
Strong-noise quality stays required and open; this priority does not reduce scope.

The later [strict HDR preview checkpoint](../gpu-processing.md#strict-hdr-presentation-and-retry--2026-11-01)
adds explicit failure/GPU retry without HDR CPU presentation, preserves pending
edits and active authored HDR sources through device loss, and passes native
source/history/view/pixel recovery checks. It does not close sustained-performance
or strong-noise quality requirements; raster/other legacy migration remains separate.

The [November 1 GPU resize checkpoint](upscaling.md#gpu-implementation-checkpoint--2026-11-01)
adds strict default/automatic export reduction and enlargement with sequential
phase budgets and a new frozen resize policy. Independent references, actual
RAW/HDR reduction and small integration cases pass on the discrete GPU; the small
cases also pass on the integrated Radeon. The later full-size GPU checkpoint
passes actual 1.25× SDR/HDR exports through restart on RX 7900 XTX, with unchanged
cap refusal and complete independent HDR reconstruction. Idle performance remains
unverified; historical CPU-size receipts are kept separate.

Focused hidden application checks cover public UI/MCP parity, real original
Before/Split pixels, pending-comparison cancellation, keyboard gestures, minimum
1100 × 700 Console-open layout, Undo/Redo and restart on a tiny original PNG.
Service checks cover transactional history/migration and a real JPEG export with
frozen spatial settings across foreground preemption and later edits. These checks
do not accept photographic quality, native input or full-size performance. The
later combined checkpoint adds actual RAW/HDR application and export integration;
the remaining gates stay open before slice 4 acceptance.

Goal 1 slice 5 now exposes explicit [standard Lanczos3 enlargement](upscaling.md)
through Custom export and MCP. It freezes policy and resources, keeps crop-aware
aspect-preserving geometry, and retains legacy/quick no-enlargement defaults.
Independent Decimal80 vectors, tiny real SDR/HDR JPEG exports, GPU rendition/CPU
recovery, hidden keyboard/minimum-size UI/MCP and restart pass focused checks.
The combined checkpoint adds real RAW/merge round trips with tiny native crops
and 2× enlargement; full-size photographic and performance acceptance remains pending.

Selective copy/paste and bounded batch application have focused functional,
journal, hidden UI/MCP/restart and native minimum-size evidence; combined
everyday-editing acceptance remains in Goal 1. All Goal 2 work remains unfinished.
The user made the desktop and GPU available on 2026-10-29 for the deferred
real-source, native and performance checks. Both goals, original sources and all
acceptance thresholds stay intact.

## Goal

Make Irodori useful for a complete global photo edit: correct color, shape tone, apply a creative grade, reduce distracting noise, recover controlled edge contrast, crop/straighten, reuse edits, and export at a chosen size. Each supported operation must work from managed originals or durable masters, retain HDR information, share persisted history and UI/MCP behavior, and preserve responsive browsing and editing.

The initial hardware acceptance environment is the current Bazzite workstation. Preserve cross-platform contracts and record other platforms as unverified until exercised. This milestone does not imply broader camera calibration, physical HDR luminance certification, or completion of the full HDR roadmap.

## Accepted delivery order

Each slice includes processing, persistence, typed API/MCP, UI and focused
verification. Do not accumulate working controls over unfinished processing.
Freeze algorithms and source domains before adopting the corresponding operator.
Independent research may proceed when useful, but advanced-tool integration waits
for its delivery goal. This is a delivery order; the processing graph still obeys
its declared operator dependencies.

| Goal / slice | Deliverable                                                                                                                        | Exit evidence                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared / 0   | Freeze processing contracts, candidates, independent quality references, resource limits and source-matched performance baselines. | Source domains/order, capability limits, identity defaults, transactional migrations, fixed thresholds and registered target selections recorded before adoption. Repeat operator-specific decisions as needed. |
| Goal 1 / 1   | Finish inspector #26–28/applicable #10, Saturation/Vibrance and supported neutral white-balance picking.                           | Native keyboard/minimum-size acceptance, real-photo HDR/SDR checks, shared history/MCP/export and the saved performance comparison. Retain the functional evidence already recorded.                            |
| Goal 1 / 2   | Nondestructive [crop, rotate and straighten](crop-straighten.md).                                                                  | Free/fixed aspect ratios, numeric/keyboard editing, reset/cancellation, orientation and inverse picker geometry, export dimensions and Undo/Redo/restart.                                                       |
| Goal 1 / 3   | Eight-range HSL mixer and three-way grading.                                                                                       | Smooth hue/tonal transitions, shadow/midtone/highlight blending/balance, neutral bypass, signed/HDR and GPU agreement with independent references.                                                              |
| Goal 1 / 4   | Single-image luminance/chroma denoise, followed by detail sharpening.                                                              | Predeclared noise/texture/halo limits, native 100% proof, bounded tiles, cancellation, explicit GPU capability handling and combined export.                                                                    |
| Goal 1 / 5   | Explicit standard Lanczos3 enlargement through existing export sizing.                                                             | Crop-aware dimensions/aspect ratio, preserved no-enlargement default, HDR/SDR round trips, frozen settings and bounded resources. No FSR dependency.                                                            |
| Goal 1 / 6   | Selective copy/paste, bounded batch application and the complete everyday-editing workflow.                                        | Frozen complete selections, explicit included groups, capability checks, coherent per-photo history, conflicts/cancellation/restart, real RAW/raster/merge edit-export acceptance.                              |
| Goal 2 / 1   | Master/Red/Green/Blue tone curves.                                                                                                 | Accessible graph/numeric point editing, signed/HDR coordinates/tails, one history entry per gesture, GPU/export agreement with independent references and unchanged identity behavior. Reuse retained research. |
| Goal 2 / 2   | Named versioned edit presets.                                                                                                      | Explicit groups and compatible destinations, application copies settings into photo history, edits and definitions survive restart independently; reuse Goal 1 batch operations.                                |
| Goal 2 / 3   | Final-output-size proof and export-only output sharpening.                                                                         | Cancellable output-pixel proof, one proof pixel per CSS pixel at 100%, sharpening after resize, frozen jobs and independently decoded export agreement.                                                         |
| Goal 2 / 4   | Evaluate optional spatial FSR 1.                                                                                                   | Independently compare EASU with standard enlargement, then equivalent sharpening; record validated domains and adoption or reasoned rejection. Standard resizing remains fully functional.                      |
| Goal 2 / 5   | Combined advanced/global acceptance and readiness for masking.                                                                     | Repeat complete RAW/raster/merge edit-export-restart workflows with all enabled global tools, focused regressions, intentional performance evidence and accurate backlog/platform status.                       |

Continue Goal 1's deferred real-source, native and performance acceptance with the
available desktop/GPU. Complete every Goal 1 exit gate before reporting Goal 1
accepted; focused functional passes do not close the remaining gates. Goal 2 and
masking retain their accepted delivery order. Comprehensive checks still need a
separately agreed checkpoint.

## GPU-only architecture update — 2026-10-31

The user confirmed that this personal-use application should avoid duplicate CPU
and GPU feature implementations and their development-credit costs. Apply
[backlog #32 and the GPU-only decision](../gpu-processing.md) to new or rewritten
processing/rendering stages. This supersedes the original per-feature production
CPU-parity/fallback requirement. Retain independent quality references, HDR/SDR
correctness, history, resource bounds and explicit unsupported-capability handling.
Legacy fallback removal proceeds in bounded stages; #32 remains open until its
actual production routes are migrated. Historical CPU evidence remains preserved.

## Controls

### Inspector and related backlog

- **#26:** Keep the histogram in a reserved top region while the adjustment body scrolls independently. Its collapsed header remains available and the expanded plot cannot cover controls below it.
- **#27:** Introduce a shared accessible section disclosure for Histogram, Light, Color, Curves, Color Mixer, Color Grading, Detail, Crop, Lens corrections, Presets, and Metadata as each section becomes available. Preserve open state across photo changes and workspace recovery; opening a section is workspace state, never a photo edit. Collapse must not discard an in-progress adjustment or remove its save subscription.
- **#28:** Use compact headings, aligned values, existing tokens and icons, and contextual help. Replace the current long availability paragraph with concise capability/error feedback where needed. Keep unavailable behavior explicit and the photograph visually dominant at 1100 × 700 with the Console open.
- **#10:** Reproduce and fix spontaneous Linux select dismissal in the shared controls used by these tools. Include native foreground verification where hidden tests cannot reproduce the platform behavior. Do not claim macOS verification from Linux evidence.
- **#30:** Reuse and extend shared resource admission only as needed for interactive denoise, detail, proof, and export jobs while import continues. Keep full queue redesign as its own backlog item unless it becomes a demonstrated prerequisite. Preserve exclusive publication and Trash mutations.
- Exercise edit flushing and shutdown during the new workflows. If **#25** blocks reliable saving or exit, resolve the reproduced dependency with isolated evidence. Immediate background deletion **#29**, merge comparison **#9**, branding, and merge performance continuation remain separate tasks.

### Color and tone

- Implement [Saturation and Vibrance](vibrance-saturation.md) using the shared numeric input. Add the [white-balance picker](white-balance-picker.md) only for sources with a validated provider; unsupported sources retain an explicit capability reason.
- In Goal 2, implement [Master/Red/Green/Blue tone curves](tone-curves.md) with a graph and numeric point editing, identity reset, keyboard movement, and one history commit per gesture.
- In Goal 1, implement the [eight-range color mixer](color-mixer.md): red, orange, yellow, green, aqua, blue, purple, and magenta, each with Hue/Saturation/Luminance.
- In Goal 1, add [shadow, midtone, and highlight grading](color-grading.md) controls for hue and chroma strength, plus blending and tonal balance. A color wheel must have equivalent numeric/keyboard controls. Define tonal weights, neutral handling, luminance behavior, and HDR range before choosing final ranges or labels. A global grade can be built from the three regions and global color controls in this milestone.
- Keep per-section reset or temporary comparison actions at section level and route persisted changes through the shared history. Do not add independent save or Undo/Redo controls beside sliders.

### Detail and output size

- [Noise reduction](noise-reduction.md) means separate Luminance and Chroma strength, with detail/edge protection only after validation. Start with deterministic classical processing; learned restoration is a later decision. Existing multi-frame noise stacking remains a separate operation.
- [Detail sharpening](sharpening.md) provides Amount, Radius in source pixels, and validated threshold/edge protection. A zero amount bypasses. Internal edge protection does not require a user-painted mask.
- Export resizing exposes an explicit enlargement choice, target dimensions or scale, and method. Preserve the current no-enlargement default for old jobs and quick presets. Start with the existing Lanczos3 resizer, extending its geometry policy and verifying enlargement rather than creating a second resize engine.
- In Goal 2, add optional output sharpening after resizing, with Off available. Keep saved detail sharpening separate from export-only sharpening and avoid applying RCAS and output sharpening twice.
- In Goal 2, provide a cancellable final-size proof that identifies output dimensions and method. At 100%, one proof pixel maps to one CSS pixel. Ordinary Fit/100% preview retains its existing source-pixel meaning; enlargement never substitutes for full-resolution RAW decoding.

### Framing and reusable edits

- Goal 1 crop/straighten stores nondestructive geometry with fixed/free aspect ratios, rotation, straighten, keyboard/numeric editing, reset, and Escape cancellation. Reuse shared preview interaction and source-coordinate mapping; do not bake a crop into originals or merge masters.
- Goal 2 named edit presets save explicit adjustment groups and versions. Goal 1 selective copy/paste and batch apply default to excluding crop/geometry and camera-dependent white balance/lens state; including those groups requires an explicit choice and destination compatibility checks. Applying a preset copies settings into history so later preset edits cannot change earlier photographs.
- Batch application freezes complete selection, including unloaded records, and reports applied/skipped/failed/conflicted counts. One application creates one coherent history entry per destination photo. Define cancellation and partial-result behavior; do not imply a cross-photo Undo stack.
- Texture, Clarity, Dehaze, vignette, LUT import, learned denoising/super-resolution, and additional export formats remain follow-up candidates. They require their own operator and quality decisions; they are not completion requirements for this goal.

## Processing approach

### Shared operators and scale

Extend the existing versioned processing path instead of building inspector-specific filters. Phase 0 must record the exact graph and domains for RAW, authored raster, imported HDR, and durable merge inputs. Reuse the fixed ACES 2 HDR/SDR rendition contract; color editing must not add content-based exposure normalization or clip working data to SDR.

The required ordering constraints are denoising before detail sharpening, grading before the final output transform, crop geometry before final export dimension calculation, and output sharpening after final resize. Placement of denoising, geometry resampling, curves, and color operators relative to white balance, lens preparation, and each other requires recorded comparisons. Preview scale does not change a saved source-pixel radius or denoising strength. Preview approximations need measured agreement and a clearly identified exact 100% result.

Use independent numeric and photographic references to verify production GPU stages. New or rewritten stages do not require an equivalent production CPU backend; prefer compact existing reference vectors over a complete second implementation. Follow the [GPU-only direction](../gpu-processing.md), retaining necessary CPU decoding, codecs and orchestration. Keep native libraries and processing outside Electron. Use bounded rows/tiles with sufficient overlap for neighborhood operators; include source, operator versions, parameters, geometry, scale, and output target in appropriate cache identities. Avoid repeating RAW decode or upstream processing for downstream-only color gestures.

### Goal 2 AMD FSR decision

AMD documents **FSR 1** as a single-frame spatial upscaler with EASU reconstruction and a separate RCAS sharpening pass; its reference code has a permissive license. This makes it a technically plausible still-image candidate. It does not establish photographic quality or recover detail absent from the source. See [AMD's overview](https://gpuopen.com/fidelityfx-superresolution/) and [reference license](https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/license.txt).

The reference EASU implementation expects bounded RGB channels with a display-like transfer curve and limited input noise. Irodori's scene-linear HDR assets cannot be passed directly through it without a validated adaptation. Freeze an upstream revision, preserve notices, determine an appropriate backend or port, and verify any port against the upstream implementation. Compare EASU with RCAS off against Lanczos3 first, then compare equivalent sharpening strengths. See [AMD's implementation requirements](https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h).

Use known high-resolution references downsampled by an independent method, plus real photographs containing hair, foliage, fine text, skin, high-contrast edges, and noisy shadows. Record edge artifacts, noise amplification, color/HDR error, texture retention, native crops, runtime, memory, cancellation, and GPU capability/device-loss handling. Freeze supported scale limits before enabling a method; do not label an area multiplier as a per-axis multiplier.

Adopt FSR 1 only for input/output domains that pass the declared quality and resource gates. If only SDR is validated, expose that limitation explicitly and retain the standard HDR resizer. If it does not provide useful photographic results or practical integration, record the rejection and finish standard enlargement. An unavailable optional method must not block ordinary resizing or silently replace a chosen method during export.

Newer temporal FSR upscaling uses multiple-frame history and rendering inputs such as motion vectors and depth. Based on these requirements, it is not an appropriate default for a single photograph. This is an integration assessment from [AMD's temporal upscaling documentation](https://gpuopen.com/manuals/fsr_sdk/techniques/super-resolution-ml/), not a benchmark of Irodori.

## API/MCP implications

Extend the typed photo-edit service and capability model for all enabled operators. Renderer and MCP use photo IDs, validated bounded parameters, and expected revisions. Curve points, grade regions, crop geometry, preset membership, and batch targets are data contracts, not filesystem or command access.

Export/proof requests include frozen committed settings, geometry, target dimensions, resampling method, output sharpening, and processing versions. Proof selection and temporary comparison do not add history. Capability responses identify source/method support and reasons; never infer camera calibration from filename or ISO alone.

Presets and batch edits need specific main-owned operations, stable preset IDs, per-photo conflict detection, and bounded work. Pending UI gestures must flush or be explicitly cancelled before freezing copy, batch, proof, or export settings. Reuse the shared menu model for copy/paste, preset application, and selection commands in Editor and Library, with explicit targets and availability.

## Persistence

At implementation time, recheck the current settings and catalog versions; the planning snapshot uses settings 7/catalog 17. Add neutral or identity values to current settings and every historical snapshot transactionally, preserving revisions, redo branches, cursor, timestamps, originals, and durable master bytes.

Persist algorithms and parameter semantics sufficiently to reproduce accepted edits. Separate workspace state (disclosures, selected range, proof view), photo history (color, denoise, detail, crop), named preset definitions, and export preferences/job manifests (resize and output sharpening). Include frozen new settings in in-flight export recovery. Never replay an old job using newly selected defaults.

Neutral operators and identity geometry must preserve the existing look exactly. Pixel-policy changes require rendering-version changes and cache invalidation; the milestone must not silently retune existing nonneutral edits. Keep prepared caches disposable and protected by existing leases and resource accounting.

## Dependencies

- Reuse the existing [HDR foundation](../hdr-processing.md), [display renderer](../display-rendering.md), [RAW/provider contracts](../raw-processing.md), and [JPEG export](export.md). Additional cameras are not a prerequisite for global tools on already supported inputs.
- The [color model](vibrance-saturation.md) precedes mixer and grading; [tone curves](tone-curves.md) share its HDR/negative-value decisions without depending on 8-bit screen samples.
- Define the [denoising](noise-reduction.md) contract before [sharpening](sharpening.md); deliver standard enlargement in Goal 1 and complete output sharpening with final-size proof in Goal 2.
- Plan inverse geometry before Goal 1 crop so the early white-balance picker remains correct. Selective copy/paste precedes Goal 2 presets, which follow stabilized settings contracts; avoid creating transient parallel schemas.
- Use [input](../input-design.md), [scrolling](../scrolling-design.md), [menu](../menu-design.md), [background testing](../background-testing.md), and [task scheduling](../import-pipeline.md) standards.
- Keep full queue reorganization, automatic masks, local brush/gradient editing, terminal execution, and cloud features outside this milestone.

## Failure handling

Reject invalid/nonfinite parameters, malformed curves, unsupported versions, unsafe dimensions, and resource overflow before committing or allocating. A failed preview preserves confirmed settings and offers retry; it cannot display a stale revision, camera JPEG, or an upscale of an embedded preview as native detail.

Bound expensive preparation and proof work under current RAM/VRAM limits. Cancel obsolete jobs, release captures/leases, and retain the last matching frame only where its identity remains valid. GPU loss retires owned resources and reports an explicit processing failure or GPU retry; do not silently substitute a CPU implementation. Export must report failure rather than silently bypassing saved denoising, sharpening, grading, or the selected resize method.

Preset/batch failures retain per-photo outcomes and already committed histories. Coordinate cancellation, protected sources, deletion, publication, and shutdown through existing services. Missing native support disables only the affected method with a clear reason.

## Selective transfer implementation status — 2026-10-29

[Selective copy/paste and bounded batch editing](copy-paste.md) has focused
service, hidden UI/MCP/restart and native minimum-size Console-open evidence.
The final focused selection passed 804 checks in 45.53 seconds with zero failures
or skips; the separate foreground checkpoint passed 788 checks in 41.68 seconds
and its native menu/chooser screenshots were inspected. These invocation counts
overlap and are not additive; the [transfer ledger](../../artifacts/edit-transfer/20261029T072040Z/summary.md)
retains their selected targets and cleanup evidence.
Copied settings stay main-owned; application jobs retain complete ordered targets,
per-photo revisions/outcomes and ordinary photo-wide Undo/Redo. This completes the
initial tool integration, while the Goal 1 exit checklist below remains open for
combined real-source, photographic and performance acceptance. Named presets and
advanced integration remain in Goal 2.

## Remaining Goal 1 evidence — 2026-11-01

Functional integration is substantial; an open aggregate checkbox does not mean
the corresponding tools are absent. Keep these distinct exit requirements:

Backlog #26–28 is complete for the current Bazzite inspector: pinned histogram,
consistent disclosures and compact controls pass the recorded native and hidden
checks below. The aggregate foundational-color criterion still includes the
separate photographic and performance requirements.

| Area                           | Current evidence and remaining requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspector and native inputs    | Pinned layout, minimum size, keyboard controls and the tested native Aspect-ratio popup route have scoped passes. The latest `inspector-ui` selection adds Detail keyboard/DOM retention, Detail/Crop photo/crash/restart persistence, and pending Detail edit/external-revision handling: 888 checks, zero failures/skips, 77.97 s, `artifacts/verification/2026-11-01T10-24-01.288Z-check-FQRn4r/summary.md`. These do not imply every platform/dropdown has been certified.                |
| Picker photographic neutrality | Functional real-Sony sampling/history passes. The [picker brief](white-balance-picker.md#acceptance-criteria) still requires a known neutral target under two independently measured illuminants. The committed ISO125 paper capture and synthetic D50/D65 responses cannot supply that physical ground truth. No qualifying measured-light cohort is currently identified.                                                                                                                   |
| Photographic appearance        | [Color](color-mixer-grading-processing.md) and [detail](detail-processing.md) still require their declared native crop review: useful skin/foliage/blue-purple/noisy-shadow grading, sharpening/combined-detail texture and halo behavior, and representative crop/enlargement texture/ringing. Existing forest/starfield/fur/carpet evidence is scoped; a reduced composition review or synthetic pass does not close all subjects. Historical unreviewed/private portraits remain excluded. |
| Strong-noise method            | Public NR v1 remains weak on high-ISO photographs. Rejected C16 and the fixed BM3D trial are not eligible replacements. A review or further bounded noise-model study awaits the user's effort decision; no gate or saved v1 meaning changes while it is pending.                                                                                                                                                                                                                             |
| Spatial workloads/resources    | Admission, cancellation, full-size exports and the later real crop/sharpen import/export contention case pass their stated correctness scopes. Action-specific cold limits and warm timing gates for spatial settings remain open, as does eligible strong-noise processing. Managed reservations and the new owned-memory snapshots do not measure whole-app physical peaks. Do not impose instantaneous denoising.                                                                          |
| Sustained responsiveness       | Previously passed configurations retain their scope. Remaining native-maximized 120-Hz acceptance is incomplete: the bounded post-refactor Exposure selection missed the 118.8-Hz input prerequisite in all six trials. The [effort stop](../performance-decisions.md#bounded-post-preview-check--2026-11-01) applies; no further unchanged pacer/trace/grid loop is selected.                                                                                                                |

Selective transfer and real RAW/raster/merge edit-export-restart integration are
already checked below with their stated limits. Curves, named presets, final-size
proof/output sharpening and optional FSR remain Goal 2; they are not extra Goal 1
blockers. Broader camera/display calibration is separate from the specific
measured-neutral picker criterion above. Missing evidence stays open until the
corresponding requirement is actually demonstrated.

The later [full-RAW sharpening check](professional-editing-processing.md#full-raw-sharpening-supersession--2026-11-01)
adds a hidden pass for superseded preparation replies, matching GPU retry, exact
history/view and preserved source bytes. It records app-owned memory snapshots
but does not close cold timing, in-flight shader cancellation, NR/crop or actual
import/export contention. The [native SDR enlargement review](upscaling.md#native-sdr-appearance-review--2026-11-01)
also extends the reduced composition proof to six actual output crops, retaining
the missing 1×/clean-reference and broader photographic limits.

The user confirmed on 2026-11-01 that they do not have a calibrated neutral target
or color-temperature meter. The existing paper RAW remains functional picker
evidence only. No equipment purchase or new capture was requested, and the
measured-illuminant criterion above remains unverified rather than waived.

The [real spatial contention case](professional-editing-processing.md#real-cropsharpen-import-and-export-contention--2026-11-01)
now adds cold crop/sharpen variant correctness, actual forest-import counter
advancement, export worker progress during an uncommitted gesture and matching
frozen JPEG bytes. It passes one focused hidden case in 26.71 s. Cold speed limits,
warm timing gates for those settings and physical memory peaks remain open;
correctness evidence does not establish performance acceptance.

The later [native SDR skin review](color-mixer-grading-processing.md#native-sdr-skin-appearance--2026-11-01)
adds four hardware-WebGL preview crops from a committed, licensed, anonymous
forearm JPEG. This covers one bounded skin/body-hair appearance example at 100%;
RAW/HDR, other subjects/lighting and the remaining quality/performance requirements
stay open. The photographic capture case requires explicit foreground on Bazzite.

## Acceptance criteria

### Goal 1 exit

- [ ] Inspector and foundational color acceptance is complete, including deferred native/real-photo/performance gates.
- [x] Crop/straighten, mixer/grading, single-image denoise/detail sharpening and standard enlargement are usable through the UI and typed API/MCP with declared source limits. The [current combined workflow](../../artifacts/verification/2026-10-31T19-59-26.702Z-check-9x6X1C/summary.md), [native controls](../../artifacts/verification/2026-10-31T19-47-16.142Z-check-WoHjVX/summary.md) and recorded [enlargement UI/MCP checks](upscaling.md#focused-verification-2026-10-28) establish functional use. [GPU precision limits](../gpu-processing.md) remain explicit; strong-noise quality and performance are separate open requirements.
- [x] Selective copy/paste and bounded batch editing preserve complete targets, destination state, photo-wide history, conflicts and cancellation. [Focused service/UI/MCP evidence](../../artifacts/verification/2026-10-29T07-52-32.597Z-check-KmtZiL/summary.md) and [native composition](../../artifacts/verification/2026-10-29T07-20-40.787Z-check-ah3Dy2/summary.md) cover the recorded Bazzite scope.
- [x] Real RAW, raster and durable-merge edit-export-restart paths pass, with source/master preservation and appropriate gain-map input coverage. The [current reviewed-input checkpoint](../../artifacts/verification/2026-10-31T19-59-26.702Z-check-9x6X1C/summary.md) refreshes actual Sony RAW/raster/genuine v4 merge and explicitly synthetic encoded ISO coverage after GPU-policy changes; exports use small native crops. This closes functional correctness for those settings, not photographic/full-size/performance acceptance.
- [ ] All Goal 1 features meet the shared correctness, migration, GPU capability handling, resources, minimum-size/keyboard and performance requirements below. Missing hardware/baselines remain incomplete.
- [ ] Status/backlog evidence describes Goal 1 accurately and leaves Goal 2, masking and unrelated backlog work open.

### Full milestone: both goals

- [ ] Phase 0 records candidate algorithms/licenses/versions, source domains, exact stage graph, independent fixtures/references, fixed numerical/quality thresholds, and the existing performance baselines before adoption. Unfilled algorithm tolerances block the corresponding feature's acceptance.
- [ ] Backlog #26–28 is verified at native 1100 × 700 with the Console open: independent scrolling, a readable pinned/collapsed histogram, consistent disclosures, keyboard focus, restored workspace state, and preserved pending edits. Resolve #10 for affected controls or report the remaining native blocker explicitly.
- [ ] All color operators preserve finite HDR values, alpha, and neutral behavior across near-black, hue-boundary, out-of-gamut, and at least 16×-white fixtures. Curves, mixer, and grading pass independent continuity, selectivity, hue/luminance, and GPU checks against independent references.
- [ ] Denoising meets predeclared residual-noise and texture-retention gates; sharpening meets overshoot/halo/noise-amplification limits. Include dark texture, skin, stars, hair, foliage, repeating patterns, and deghost boundaries in durable merges. Tiled output has no seams and native 100% proof is trustworthy.
- [ ] Standard enlargement and resize-aware sharpening pass dimension/aspect/identity, scale, memory, cancellation, and HDR/SDR output checks. Final-size proof matches independently decoded export within declared codec tolerances. Record FSR's validated domain and quality evidence or its reasoned rejection.
- [ ] Crop/straighten preserves originals and masters, shares Undo/Redo/restart, handles orientation and lens-corrected coordinates, and agrees with export dimensions and picker sampling. Identity crop bypasses resampling.
- [ ] Presets and selective/batch application preserve destination-specific state by default, include unloaded selections, handle capabilities/conflicts/cancellation, and create coherent per-photo history. Versioned presets and applied settings survive restart independently.
- [ ] Every enabled edit survives migration, Undo/Redo, redo-branch changes, restart, stale revisions, and equivalent UI/MCP calls. Frozen exports retain the accepted settings while later editing continues. Both embedded and decoder-fallback import paths retain real Sony ZV-1 fixture coverage.
- [ ] Retain existing resource, interaction, and uncorrected-preview gates unchanged. At intentional performance milestones compare against a saved source-matched baseline, including the 15% uncorrected regression gate; record hardware computation, actual presentation cadence/missed updates, cold/warm behavior, memory, cancellation, and contention separately. Missing baselines or hardware mean incomplete verification.
- [ ] Each new suite receives a unique target and execution group in `scripts/verification-plan.ts`. Run explicitly selected targets and affected regressions, using hidden isolated profiles by default. Existing candidate regressions include `adjustment-wiring`, `edit-history`, `adjustment-engine`, `adjustment-engine-raw`, `adjustment-history-ui`, `adjustment-history-raw-ui`, `workspace`, `preview`, `editor-mcp`, `editor-mcp-raw`, `export-model`, `export-rendering`, and `export-ui`; choose per change, not the whole list automatically. Preview selections with `--plan`.
- [ ] Read each invocation's `summary.md` first; retain counts, duration, evidence, and limitations under ignored `artifacts/verification/`. Use explicit foreground runs for native dropdown/focus, minimum-size visual acceptance, and presentation timing. Never import into the user library or weaken a deferred gate. Comprehensive `check:full`/`check:all` runs require a separately agreed checkpoint.
- [ ] Goal 2 final acceptance demonstrates the combined workflow and updates this checklist, feature statuses, backlog completion, and supported-platform limitations from retained evidence. The plan alone does not close any backlog item or establish readiness for masking.

## References

- [Product direction](../../Irodori.md), [current milestone](../../README.md), and [workspace backlog](README.md#workspace-feedback-backlog).
- Existing briefs: [white-balance picker](white-balance-picker.md), [vibrance/saturation](vibrance-saturation.md), [curves](tone-curves.md), [color mixer](color-mixer.md), [noise reduction](noise-reduction.md), [sharpening](sharpening.md), and [export](export.md).
- Existing implementation entry points: [inspector](../../src/renderer/src/components/Inspector.tsx), [adjustments](../../src/shared/adjustments.ts), [export contracts](../../src/shared/export.ts), [linear resizer](../../src/main/export/resize.ts), and [verification registry](../../scripts/verification-plan.ts).
- AMD primary sources: [FSR 1 overview](https://gpuopen.com/fidelityfx-superresolution/), [spatial integration manual](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-spatial/), [reference code](https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h), [license](https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/license.txt), and [temporal upscaling requirements](https://gpuopen.com/manuals/fsr_sdk/techniques/super-resolution-ml/). Reviewed 2026-10-25; recheck and pin exact inputs during implementation.
