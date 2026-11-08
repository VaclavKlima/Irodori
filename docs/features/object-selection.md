# Object selection and manual correction

## Delivery

The first implementation portion of [TODO 54](README.md#task-54) enables local SAM 2.1 Tiny object selection on the current Mac. It reuses the existing multiple-mask editor and six local Light controls. The user explicitly selected delivery on the available device, with [Bazzite follow-up](README.md#task-69), rather than waiting for another device before activation. The [research study](object-selection-research.md) retains model comparisons, limitations and the original proposal; this delivery supersedes its activation ordering.

## Editing workflow

Open **Masks → Create mask → Select object…**. This opens the **Coverage** tab. Draw a box, or indicate an object with a positive point. Add positive/negative guide points and choose **Create selection**. The box guides the model; it does not clip the resulting mask. Inspect the coverage overlay, then choose **Use mask** to create an Object mask. Nothing enters photo history before acceptance. A ready proposal makes **Use mask** the primary action; changing its guides requires **Update selection** before acceptance. Acceptance opens **Adjustments** for the selected mask's local Light controls.

Choose **Coverage → Refine object selection…** to generate a replacement base for the selected object mask. Existing Paint/Erase strokes, Light controls, name, inversion and order remain intact. A point refinement can make a selection worse; inspect each proposal and cancel or undo when necessary. After accepting, return to Coverage for Paint/Erase, Size and Feather, or use Adjustments for Exposure, Contrast, Highlights, Shadows, Whites and Blacks. **Show overlay** remains available above both tabs. Rename, duplicate, invert, reorder and delete belong to the mask row's **⋯** menu. Each acceptance or completed correction is one photo-wide Undo step. Accepted masks survive restart and frozen output without running the model again.

This selects indicated animals, plants, vehicles and other visible objects. It does not supply text grounding, automatic subject discovery, sky classification, reflection correspondence or finished hair/fur/feather matting. A reflection should be indicated separately. The research found coarse edges, false holes, unwanted fragments and severe fence-gap failures. Transparent objects have semantic coverage, not measured physical alpha. These limits remain visible in the research evidence and TODO 54's remaining quality acceptance.

The current export accepts six prompt slots: a box consumes two, while each positive/negative point consumes one. The Editor exposes four guide points so switching between a box and points never truncates input. Excess prompts are refused; manual brush corrections have the existing larger geometry limits. Sources are bounded to **32 MP and 8192 pixels per side**. Oversized sources keep normal manual masking available. Requested resolution and quality are never silently reduced to make inference fit.

## Ownership and coordinates

Main owns the inference worker, managed source paths, proposal lifetime and accepted mutation. The renderer receives typed photo/revision/grid contracts and compressed mask content, never filesystem or process access. There is one active inference request, one canonical source and one reusable embedding. Cancellation fences output and waits for the owned bundled-Node child; failures report the actual reason and a later request retries GPU. There is no equivalent CPU inference fallback.

Inference uses a full-native, once-oriented neutral SDR source with crop, lens edits, local edits and saved denoising/sharpening disabled. Source preparation uses existing processing; RAW uses sensor data. Committed presentation geometry maps screen points through crop/lens transforms into the canonical source. Box perimeters are sampled through that mapping and enclosed with one native-pixel padding; this is an indicated region rather than an exact ROI contract. Grid identities include source and geometry, including equal-sized rotations, independently of zoom/pan. Revision/source/grid checks run again before proposal publication and acceptance.

The UI keeps crop, pickers, inspection, object selection and brush input exclusive, preserves middle-button panning and cancels unfinished input on Escape, blur or lost capture. Proposals wait for actual coverage presentation before **Use mask** becomes available. Failed or cancelled work preserves accepted masks. Photo navigation, deletion and shutdown cancel owned selection work; a late result cannot retarget another photo.

## Storage and rendering

Settings **14** / catalog **24** add optional immutable generated-base references beneath the existing ordered brush chains. Migration preserves all version-13 masks, strokes, revisions, history cursors, branches and timestamps. Old catalogs still require their existing stroke store; only the new version requires the generated-base store. Global presets and Copy/Paste continue to preserve destination masks; independent legacy preset formats remain accepted.

The SQLite generated-base store retains lossless native grayscale R8 PNGs with content SHA-256, dimensions, PNG structure and chunk CRC validation. Assets and history publish in one transaction. Replacing a base preserves the brush head. Current/undo/redo data and accepted frozen jobs remain protected by append-only retention; missing or changed content is an explicit error. There is no public arbitrary-base upload operation.

GPU coverage starts from a single compact R8 texture array, then applies existing ordered Paint/Erase and whole-mask inversion. Shared WGSL/GLSL coverage is used by presentation, overlays, histograms and the native point/export renderer. Browser PNG decoding is native; bounded RGBA strips convert to R8 on GPU. Production code does not reconstruct full-image masks in JavaScript or run Python. Native Node codecs decode/encode PNG outside Electron.

Limits include 8 MiB encoded per base, 32 MiB combined retained brush/base content per photo, the existing 32-mask and stroke limits, and a 256 MiB native coverage atlas bound. Exact atlas/strip/native-decode bytes enter resource admission. Raster presentation retains its existing 512 MiB cap; acceptance also preflights generated-base stacks. Excess work is refused before history publication. Names and selection do not affect pixels; base hashes, correction chains, enabled/invert/order and Light values do.

## Model delivery

The exact ONNX Runtime Node **1.31.1** native WebGPU backend and FP32 SAM 2.1 Tiny exports are pinned. Exact float32 categorical labels retain the qualified original computation; model precision is unchanged. GPU preprocessing matches the frozen antialiased bilinear source transform, and native coverage uses bilinear low-resolution logits followed by threshold zero. Predicted IoU ranks alternatives and never accepts a result automatically.

[Bundled model resources](../../assets/app/object-selection/README.md) contain losslessly compressed, bounded graph chunks, exact whole-file/chunk hashes, source/export provenance and upstream Apache-2.0 notices. `npm run setup:object-selection` verifies them without Python or network downloads. Normal builds copy them into the application worker resources; packaged applications use those same resources. The root npm lockfile pins the inference dependency. Research artifacts are not runtime dependencies.

## Console / MCP

- `irodori_get_object_selection_context` returns the revision/grid and can map normalized current-photo box/points to canonical prompts.
- `irodori_create_object_selection` returns an uncommitted proposal and a separate native canonical black/white coverage image. Optional `maskId` preserves that mask's manual corrections and controls.
- `irodori_accept_object_selection` commits one history step after final revision/source/grid checks.
- `irodori_cancel_object_selection` cancels/disposes work while retaining accepted masks.

Console requests keep their frozen photo targets. A proposal belongs to the request that created it. Agent interruption/disconnection cancels inference. Accepted masks use the same ordinary mask operations for manual corrections and local Light changes; arbitrary source paths, commands and model uploads remain unavailable.

## Verification

Focused acceptance is on Apple M4 Pro/macOS arm64, with host Node 24.8.0, bundled Node 24.20.0, isolated test libraries and the hidden launcher. Across the affected selection and corrective runs, **990 distinct cases pass**; **34 platform-specific cases remain skipped**. [Machine-readable evidence reconciliation](../../artifacts/research/object-selection/2026-11-08/implementation-evidence.json) retains the applicable receipts. Original failed invocations remain failed, and no comprehensive checkpoint was run.

| Evidence                                                                                                                             | Result and scope                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Initial runtime/base integration](../../artifacts/verification/2026-11-08T14-32-33.708Z-check-rC3lr7/summary.md)                    | 18 passes in 14.94 s: portable model integrity, reference sampling, actual worker/refusal/cancel/retry, immutable storage and native/browser generated coverage.                                                                                           |
| [Affected selection](../../artifacts/verification/2026-11-08T14-52-25.934Z-check-oyn7NG/summary.md)                                  | 966 passes and 34 platform skips in 115.76 s; seven failures subsequently corrected below. The browser atlas suite, new UI/presentation checks and existing brush/source/output checks retain their successful evidence.                                   |
| [Exact Node repairs](../../artifacts/verification/2026-11-08T14-58-04.882Z-check-Z0tkIG/summary.md)                                  | 27 passes in 1.10 s. Current schema expectations use the version constants. Histogram readback lifecycle reuses a matching cached pipeline without changing its assertions, numeric gates or timeout.                                                      |
| [Actual managed MCP](../../artifacts/verification/2026-11-08T14-57-16.466Z-check-TwHExY/summary.md)                                  | Two passes in 6.38 s: migration, native proposal image transport, explicit acceptance, Paint/Erase, changed-point refinement preserving controls/history, restart and frozen SDR proof/export. The box assertion includes documented native-pixel padding. |
| [Real RAW/HDR selection](../../artifacts/verification/2026-11-08T15-19-17.088Z-check-0CLA0a/summary.md)                              | One pass in 9.40 s: actual SAM 2 on the committed 5496 × 3672 Sony original, accepted base, +0.35 EV, real HDR render/histogram binding 18, 65,536 histogram samples, zero GPU errors, native overlay alignment and Before/After restoration.              |
| [Final admission/deletion/shutdown and static checks](../../artifacts/verification/2026-11-08T15-22-39.919Z-check-NLD1ib/summary.md) | 28 passes in 21.72 s, including 16 selection-service cases, concurrent cancel/accept/supersession/removal barriers, exact memory-boundary refusal and existing deletion/shutdown behavior. Type checking, lint and formatting pass.                        |

The eight dedicated selection geometry/UI/presentation cases pass. The isolated 1100 × 700 Console-open proposal screenshot was visually inspected: Sunflower controls and explicit acceptance fit without horizontal clipping, inspector scrolling remains independent, and the photograph remains dominant. During the initial object-selection delivery, the running development app was restarted through normal save/shutdown and read back with settings 14, all four selection bridge operations available, the active photograph retained, an enabled visible Select object button and no preview GPU errors. The subsequent panel layout moves that action into Create mask. No user-photo mask was created by that readback.

The real RAW check initially exposed a conservative accounting refusal (2118 MiB estimated against the unchanged 2048 MiB GPU budget). Admission now uses the maximum of sequential source/preprocessing/reconstruction phases, including exact preprocessing and R8 buffers, while retaining the 512 MiB opaque model allowance and existing RAM/policy limits. Source preparation and temporary GPU buffers retire before the next phase. The unchanged 100% test passes with Automatic RAM 6 GiB / GPU 2 GiB; no model resolution, precision, assertions or budget ceilings were relaxed.

GPU preprocessing agrees with the frozen reference within `3.58e-7`; the separately checked 20 MP native R8 result is byte-exact. These are Mac findings, not Bazzite, photographic matting or physical HDR certification.

## Bazzite follow-up

[TODO 69](README.md#task-69) owns verification and any necessary implementation fixes on Bazzite. On that device:

1. Install locked dependencies and the existing native prerequisites, then run `npm run setup:object-selection` and build. Confirm packaged and development workers load bundled graphs without research paths or Python.
2. Run the object-selection model/worker/service, generated-base, UI/presentation and MCP targets listed in the verification registry. Repeat GPU checks on the available discrete Radeon and Radeon 610M using the existing documented adapter-selection workflow. Record actual provider/device/limits; do not infer the ORT adapter or its memory capacity from a different Dawn owner.
3. Verify RAW/raster/authored-HDR/merge input registration, crop/straighten/lens changes, source replacement, point/box selection and separate subject/reflection masks. Review Fit/native coverage and correction effort with permitted fixtures; retain known coarse-edge failures.
4. Verify Paint/Erase after AI refinement, history/restart, neutral Before and frozen SDR/HDR proofs/exports without a model rerun. Exercise the 1100 × 700 Console-open layout, Create mask and per-row command menus, Coverage/Adjustments tabs, bounded mask-list/detail scrolling, old workspace-tab recovery, delayed zoom/pan, Wayland focus/native-picker behavior, cancellation, explicit GPU refusal/retry and resource cleanup under contention. Include shared photo-menu focus/keyboard behavior after the common menu extraction.
5. Fix observed device issues while retaining the same production backend and shared contracts. Record unavailable checks as incomplete. Windows and physical HDR acceptance remain separately unverified.
