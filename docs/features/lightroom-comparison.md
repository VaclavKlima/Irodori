# Lightroom-inspired feature evaluation

**Two-goal split accepted by the user — 2026-10-25.** Compare useful photographic
workflows, identify Irodori's gaps, and set delivery priorities. This is a product
evaluation, not a claim that Irodori reproduces Adobe's rendering or matches every
Lightroom feature.

The [professional-editing plan](professional-editing.md) is the authoritative
implementation order. It now records Goal 1 and Goal 2 below. The full professional-editing
objective remains active across both goals, and all previously approved features and
acceptance requirements are retained. Existing curve research is preserved for Goal 2.

## Accepted priorities

Make the first goal **Everyday global photo editing**: finish one photograph, reuse
the useful adjustments on a selection, and export a dependable result. Include the
requested color grading, noise reduction, sharpening and ordinary enlargement.
Bring crop/straighten and selective copy/paste forward because they complete that
workflow. Finish acceptance of the inspector and color work already implemented.

Put advanced Master/RGB curves, named presets, final-size proof/output sharpening
and the optional FSR experiment in a second goal. They remain useful, approved work;
they do not need to hold back the first complete workflow. Keep masking after these
global foundations, as previously agreed. This ordering is a recommendation based
on the user's stated needs and Irodori's dependencies, not an Adobe recommendation.

## Reference and method

Use **Lightroom Classic** as the main reference because Irodori's product direction is
a local desktop editor. Use Lightroom desktop documentation where it explains shared
editing tools clearly; those rows identify that source. Adobe describes Classic's
desktop/local workflow and Lightroom's desktop/mobile/web workflow in its
[product comparison](https://www.adobe.com/products/photoshop-lightroom-classic/lightroom-cc-vs-lightroom-classic.html).
This does not assume identical features between the two applications.

Adobe references were checked on 2026-10-25. The Irodori snapshot is the current
working tree, including uncommitted implementation, rather than only the last
release. Compare capability and workflow, not proprietary algorithms, slider ranges,
marketing claims, or pixel equivalence. This is a practical inventory, not an
exhaustive list of every Lightroom command or a hands-on Lightroom benchmark.

Irodori evidence comes from the [product direction](../../Irodori.md),
[current usage](../../README.md), [edit contract](../../src/shared/edits.ts),
[inspector](../../src/renderer/src/components/Inspector.tsx),
[export contract](../../src/shared/export.ts),
[HDR JPEG import](../../src/main/processing/hdr-jpeg.ts),
[backlog](README.md#workspace-feedback-backlog), and
[processing/verification ledger](professional-editing-processing.md).
Research helpers and a passing mathematical test do not establish an available tool.

Status meanings:

- **Available:** an existing usable workflow, with the stated source/platform limits.
- **In progress:** production code exists, but its declared acceptance is unfinished.
- **Research only:** mathematical/prototype work exists without the complete editor tool.
- **Missing:** no complete user-facing workflow in the inspected implementation.

“Available” does not certify additional cameras, physical HDR brightness, or untested
operating systems. Relative implementation sizes below are engineering estimates,
not delivery dates: **S** is a bounded extension, **M** spans several application
layers, **L** adds a substantial interaction/processing path, and **XL** requires
major new research or infrastructure. Every estimate includes history, export,
fallback and verification where relevant.

## What Irodori already has

These foundations should be preserved and extended rather than replaced to resemble
another application's interface. Adobe's
[Develop overview](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-tools.html)
documents the corresponding editing workflow; the Irodori column records narrower,
independently established capabilities.

| Workflow                               | Irodori status                                                                                                                                                   | Implication                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Import, browse and inspect photographs | Available: managed originals, date/search browsing, metadata, selection and stacks.                                                                              | Build new editing on the existing library.                                                |
| Exposure and tonal correction          | Available: Exposure, Contrast, Highlights, Shadows, Whites and Blacks.                                                                                           | Keep these as the primary controls for everyday brightness and contrast.                  |
| White balance                          | Available for verified Sony RAW profiles: As Shot, Temperature and Tint.                                                                                         | Wider camera and raster white balance remain separate gaps.                               |
| Lens correction                        | Available with verified providers; support is source dependent.                                                                                                  | Lens correction does not imply perspective correction or universal camera support.        |
| Before/after and analysis              | Available: Before, split comparison, histogram, clipping/range warnings and typed analysis.                                                                      | Reuse them to judge every new operator.                                                   |
| Nondestructive editing                 | Available: persisted settings, photo-wide Undo/Redo, restart recovery.                                                                                           | New tools must participate in the same history.                                           |
| HDR editing and exposure merge         | Available within documented experimental Sony/merge and display limits; float masters and HDR/SDR presentation.                                                  | Preserve HDR throughout new processing. Separate merge performance acceptance stays open. |
| Export                                 | Available: individual/batch SDR and ISO 21496-1 HDR JPEG, frozen edits, downscaling and naming/metadata choices. Bounded ISO gain-map JPEG reimport also exists. | The main output gaps are enlargement, output sharpening/proof and additional formats.     |
| Manual/agent editing                   | Available through the typed editing MCP API; integrated console execution is missing.                                                                            | Keep UI and agent edits equivalent; do not make new tools console-only.                   |

## Editing gaps and priorities

**First** means accepted Goal 1; **Next** means accepted Goal 2; **Later** means a
separately evaluated future goal. A familiar Lightroom label is useful when it makes
a control easier to understand. Its mathematics and interaction still need to fit
Irodori's HDR processing and input standards.

| Feature and plain-language purpose                                               | Adobe reference                                                                                                                          | Irodori now                                                                                                                                                                                                                                                                                                     | Priority / size / reason                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Compact inspector: find controls without losing the photograph or histogram.     | [Classic panels](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-tools.html)                 | In progress: pinned/collapsible histogram and shared disclosures; native/minimum-size acceptance remains.                                                                                                                                                                                                       | **First / S–M remaining.** Directly addresses backlog #26–28.                                       |
| Saturation/Vibrance: change overall color strength.                              | [Lightroom editing](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                              | In progress: GPU/CPU, history, MCP and frozen-export checks pass; real-photo/performance gates remain.                                                                                                                                                                                                          | **First / S–M remaining.** Finish existing work.                                                    |
| Neutral white-balance picker: remove a color cast using a neutral patch.         | [Classic white-balance selector](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-tools.html) | In progress for supported single RAWs; synthetic/worker/UI evidence, real-camera acceptance pending.                                                                                                                                                                                                            | **First / M remaining.** Useful correction with explicit source limits.                             |
| Crop, rotate and straighten: improve framing or level a horizon.                 | [Classic crop](https://helpx.adobe.com/uk/lightroom-classic/desktop/help/crop-rotate-straighten.html)                                    | Functional UI/MCP, native geometry validation, history/migration and frozen exports have small-PNG and hidden application evidence. HDR adapters/filtering have synthetic/native-kernel checks. Real-source, native visual/input and performance acceptance remain open. A merge's valid-area crop is separate. | **First / L.** Implemented experimentally; finish acceptance before calling this workflow complete. |
| Color mixer: adjust all similar reds, blues, etc. with Hue/Saturation/Luminance. | [Classic mixer](https://helpx.adobe.com/uk/lightroom-classic/desktop/process-and-develop-photos/color-mixer.html)                        | Functional inspector, partial UI/MCP edits, transactional history and independent GPU/CPU/native processing have focused checks. Small-raster proof, source reuse, frozen export and restart pass. Full real-source HDR application, photographic/native/performance acceptance remains open.                   | **First / M–L.** Direct, understandable creative control; eight ranges.                             |
| Three-way grading: tint shadows, midtones and highlights, with blending/balance. | [Lightroom grading](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                              | Functional three-tone wheel/numeric controls, blending/balance, section reset, versioned history and partial API/MCP use the original Irodori model. Independent processing and small-raster/hidden workflow checks pass; photographic/native/performance acceptance remains open.                              | **First / M–L.** Preserves the user's original color-grading priority.                              |
| Luminance/chroma denoise: reduce brightness grain and colored speckles.          | [Lightroom Detail](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                               | Internal bounded NLM has independent noise/texture references and CPU/GPU kernels with resource/cancellation ownership. Native, streamed preview/export, history/UI/MCP and photographic/performance adoption remain unfinished; controls are unavailable. Multi-frame stacking stays separate.                 | **First / L.** High practical value, but requires independent texture/noise checks.                 |
| Detail sharpening: strengthen edges without excessive halos or noisy shadows.    | [Lightroom Detail](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                               | Internal luminance sharpening has fixed halo/noise gates and CPU/GPU reference/owner coverage. Public native/cache/preview/export/history/UI/MCP and photographic/performance adoption remain unfinished.                                                                                                       | **First / M–L.** Follow denoise; judge at native 100%.                                              |
| Ordinary enlargement: export more pixels at an explicitly chosen size.           | [Classic image sizing](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-files-disk-or-cd.html)                     | Missing: existing sizing deliberately never enlarges.                                                                                                                                                                                                                                                           | **First / M.** Extend the existing Lanczos3 path; preserve the old default.                         |
| Master/RGB curves: shape a precise tone or channel response using points.        | [Lightroom curves](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                               | Research only: independent CPU/GPU math, no complete persisted editor tool.                                                                                                                                                                                                                                     | **Next / L.** Valuable advanced control; basic tone sliders and grading serve the first workflow.   |
| Point Color: select a narrower color range directly from a photograph.           | [Classic Point Color](https://helpx.adobe.com/uk/lightroom-classic/desktop/process-and-develop-photos/color-mixer.html)                  | Missing.                                                                                                                                                                                                                                                                                                        | **Later / L.** Start with the simpler eight-range mixer.                                            |
| Dedicated black-and-white treatment and color-sensitive monochrome mixing.       | [Classic tone/color](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/image-tone-color.html)                 | Missing as a dedicated workflow. Saturation −100 already removes chroma.                                                                                                                                                                                                                                        | **Later / M.** Useful style expansion after the core color model.                                   |
| Texture, Clarity and Dehaze: control fine texture, local contrast or haze.       | [Lightroom effects](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                              | Missing.                                                                                                                                                                                                                                                                                                        | **Later / L.** These are distinct operators with halo/noise risks, not substitutes for sharpening.  |
| Creative vignette and added film grain.                                          | [Lightroom web effects](https://helpx.adobe.com/lightroom/web/edit-photos/apply-effects/adjust-effects.html)                             | Missing. Lens-vignetting correction is different.                                                                                                                                                                                                                                                               | **Later / M.** Styling rather than a prerequisite for finishing a photo.                            |
| Perspective correction: straighten converging walls or buildings.                | [Lightroom geometry](https://helpx.adobe.com/lightroom/desktop/edit-photos/crop-rotate-geometry.html)                                    | Missing.                                                                                                                                                                                                                                                                                                        | **Later / L.** Crop/straighten first; perspective adds further resampling and geometry.             |
| Automatic tone/white balance and additional camera/profile choices.              | [Lightroom editing](https://helpx.adobe.com/lightroom/desktop/edit-photos/edit-photos.html)                                              | Missing beyond current manual/provider capabilities.                                                                                                                                                                                                                                                            | **Later / L–XL.** Broader support needs camera evidence and a well-defined Auto result.             |

Noise reduction removes unwanted sensor noise. Film grain deliberately adds a
texture. Sharpening increases edge contrast. Enlargement changes pixel dimensions.
None guarantees recovery of detail that the original photograph did not capture.

## Reuse, output and larger workflow gaps

| Feature and purpose                                                                  | Adobe reference                                                                                                                                                                                                                                        | Irodori now                                                                       | Priority / size / reason                                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Selective copy/paste and batch apply: reuse an edit without copying unwanted groups. | [Classic copy/paste](https://helpx.adobe.com/uk/lightroom-classic/desktop/help/copy-paste-settings.html)                                                                                                                                               | Missing. Batch **export** exists; batch **editing** does not.                     | **First / M–L.** Large practical benefit for a sequence; explicit application, no automatic synchronization.                            |
| Named edit presets: save a reusable look across sessions.                            | [Classic Develop options](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)                                                                                                                    | Missing. JPEG quality shortcuts are export presets, not saved photo edits.        | **Next / M.** Build on selective copy/paste after settings groups stabilize.                                                            |
| Output sharpening: sharpen for the exported size and destination.                    | [Classic output sharpening](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-files-disk-or-cd.html)                                                                                                                              | Missing; saved detail sharpening is also unfinished.                              | **Next / M.** Apply after final resize, separately from photo detail settings.                                                          |
| Final-size proof: inspect exactly the pixel dimensions being exported.               | Irodori workflow proposal paired with resizing; not a Lightroom feature-equivalence claim.                                                                                                                                                             | Missing. Existing preview is source-pixel based.                                  | **Next / M–L.** Keep distinct from printer-profile soft proofing.                                                                       |
| AI Denoise, Raw Details and Super Resolution.                                        | [Classic Enhance](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/enhance-details.html)                                                                                                                                   | Missing.                                                                          | **Later / XL.** Learned enhancement needs its own models, licenses, source domains and quality evidence.                                |
| Optional AMD FSR 1 enlargement.                                                      | Irodori experiment; not a Lightroom feature claim.                                                                                                                                                                                                     | Missing.                                                                          | **Next / L research.** Compare against standard resizing; adopt only if photographic results justify it. A reasoned rejection is valid. |
| Local brushes/gradients, subject/sky/range masks.                                    | [Classic tools](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-tools.html)                                                                                                                                | Missing.                                                                          | **After global foundations / XL.** Previously agreed sequence remains.                                                                  |
| Heal/clone, dust/spot removal and generative removal.                                | [Classic tools](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-tools.html)                                                                                                                                | Missing.                                                                          | **Later / L–XL.** Retouching adds a different set of interactions and processing.                                                       |
| Blur based on estimated depth.                                                       | [Classic Lens Blur](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/lens-blur.html)                                                                                                                                       | Missing.                                                                          | **Later / XL.** Specialized effect with depth-estimation dependencies.                                                                  |
| Ratings, picks/rejects and color labels.                                             | [Classic flags/ratings](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/flag-label-rate-photos.html)                                                                                                            | Missing. Existing selection does not store a photographic rating.                 | **Separate library goal / M.** Useful for choosing keepers, but does not unlock global processing.                                      |
| Keywords, named collections and smart collections.                                   | [Classic keywords](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/keywords.html), [collections](https://helpx.adobe.com/lightroom-classic/desktop/organize-photos-in-lightroom-classic/photo-collections.html) | Missing. Existing date sections/stacks are different.                             | **Separate library goal / M–L.** Evaluate from real organizing needs.                                                                   |
| Snapshots, virtual copies and reference-photo matching.                              | [Adobe workflow comparison](https://helpx.adobe.com/lightroom-classic/desktop/kb/lightroom-feature-comparison.html)                                                                                                                                    | Missing as named/independent variants; ordinary Undo/Redo and before/after exist. | **Later / M–L.** Useful after reusable edits.                                                                                           |
| Additional output formats, print soft proofing and print layouts.                    | [Classic export](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/export-files-disk-or-cd.html), [soft proofing](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)              | Missing beyond current JPEG output; no print-proof workflow.                      | **Separate interoperability/print goal / L–XL.** New format/ICC/printer acceptance is larger than adding a menu choice.                 |
| Panorama stitching.                                                                  | [Classic panoramas](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/panorama.html)                                                                                                                                        | Missing. Existing HDR/noise merges do not establish panorama support.             | **Later / XL.** Different geometry and blending.                                                                                        |
| Mobile/web synchronization and online publishing.                                    | [Adobe comparison](https://www.adobe.com/products/photoshop-lightroom-classic/lightroom-cc-vs-lightroom-classic.html), [Classic publishing](https://helpx.adobe.com/lightroom-classic/desktop/export-photos/prepare-send-or-post-photos.html)          | Missing. Local editing is the present product focus.                              | **Separate product decision / XL.** No need to reproduce Adobe's service model.                                                         |

Adobe's Super Resolution doubles width and height, giving four times as many pixels;
it is a learned enhancement feature. Standard Lanczos3 and a possible spatial FSR 1
port are different methods. Their presence would not establish Lightroom Enhance
quality or recovered scene detail. [Adobe Enhance documentation](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/enhance-details.html).

## Goal 1: Everyday global photo editing

**Outcome:** A supported local RAW, raster photograph or durable merge can be
corrected, framed, graded, cleaned up, sharpened and exported; selected adjustment
groups can be reused on a complete selection without harming originals or histories.

| Delivery slice                        | Concrete result                                                                                                                          | Acceptance focus                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Finish the current foundation      | Complete inspector #26–28 and applicable #10 dropdown fixes; finish Saturation/Vibrance and supported neutral-picker acceptance.         | Native layout/keyboard checks, real photographs, CPU/GPU/export agreement and saved performance comparison.               |
| 2. Frame the photograph               | Nondestructive free/fixed-ratio crop, rotate/straighten, reset, numeric editing and cancellation.                                        | Preview/export geometry, authoritative dimensions, inverse picker coordinates, Undo/Redo/restart.                         |
| 3. Control color and mood             | Eight-range HSL mixer and three-way grading with blending/balance and equivalent numeric controls.                                       | Smooth hue/tonal transitions, neutral bypass, signed/HDR behavior, independent references and frozen exports.             |
| 4. Clean and sharpen                  | Single-image Luminance/Chroma denoise, then Amount/Radius/validated edge protection for detail sharpening.                               | Known-noise/real-texture evidence, native 100%, alpha/edges, bounded tiles, cancellation and matching CPU fallback.       |
| 5. Export at the needed size          | Explicit ordinary Lanczos3 enlargement, original-size/downsize choices, accurate resulting dimensions, preserved no-enlargement default. | Crop-aware output geometry, HDR/SDR round trips, frozen method/settings, resource bounds and truthful errors.             |
| 6. Reuse edits and close the workflow | Selective copy/paste and bounded batch application, followed by integrated real-source acceptance.                                       | Complete selections including unloaded records, capability checks, per-photo history, conflicts/cancellation and restart. |

This is still a substantial goal because it preserves the user's requested color
and detail work. Deliver and verify each slice separately. The order is delivery
priority, not the order of pixel operations: denoising still precedes sharpening,
and geometry precedes final output sizing. Freeze processing contracts for each
operator before enabling it; the [existing acceptance requirements](README.md#shared-implementation-requirements)
and [processing ledger](professional-editing-processing.md) are unchanged.

For copy/paste, default to excluding geometry and camera-dependent white balance/lens
settings. Explicit inclusion needs destination compatibility checks. Do not offer
live Auto Sync in this goal. Applied settings create one coherent history entry per
photo; batch progress reports applied, skipped, failed and conflicted results.

The goal is complete only when the combined workflow passes on a real supported RAW,
an authored raster and a durable merge, including export and restart. Exercise bounded
gain-map JPEG input where applicable; record unsupported combinations. Verify UI/MCP
parity, source/master byte preservation, neutral compatibility, transactionally migrated
history, fallback, cancellation and shutdown. Native minimum-size/keyboard and meaningful
performance checks remain required; mathematical/unit checks alone cannot close them.

## Following goals

1. **Advanced global control and reusable looks:** Master/RGB curves, named versioned
   presets, final-output-size proof/output sharpening and the optional FSR 1 decision.
   Complete their original photographic, HDR/SDR, history, fallback and resource gates.
   Keep current curve research and independent fixtures as the starting point.
2. **Local editing and retouching:** brush/linear/radial/range masks first, with automatic
   selections or healing assessed separately after their dependencies are established.
3. **Independent workflow expansion:** library ratings/keywords/collections, broader
   camera/HDR formats, print workflows and selected effects, prioritized from actual use.

This preserves the original approved crop, presets and copy/paste work. The accepted
change from the original plan is **crop and copy/paste earlier; curves, named presets,
final-size proof/output sharpening and optional FSR in Goal 2**. Finishing Goal 1 is a
complete everyday-editing checkpoint; it does not mark the full professional-editing
objective complete. Local editing and independent workflow expansion are future roadmap
candidates, not additional work authorized by accepting this two-goal split.

## Opportunities to make Irodori clearer and faster

These are design directions to evaluate, not claims of superiority to Lightroom:

- Keep familiar control names and a compact inspector; show advanced controls when
  useful. Provide short contextual explanations, precise numeric input, keyboard
  access, section resets and coherent photo-wide Undo/Redo.
- Make HDR ranges and source limitations explicit. A monitor change must not change
  saved color; unsupported white balance, enhancement or format combinations need a
  concise reason rather than a control that appears to work.
- Reuse GPU source textures, compiled color parameters and existing point passes.
  Use bounded GPU tiles for neighborhood filters where measurements justify them.
  Keep equivalent worker/native CPU paths; avoid unnecessary image uploads, readbacks,
  RAW decodes and full-size copies. GPU utilization is a means to responsiveness,
  not an acceptance metric by itself.
- Give manual controls and MCP the same revision-checked operations, progress, errors
  and history. Preserve pending gestures when changing photographs or closing.
- Prefer explicit batch application with clear results. Keep editing responsive while
  background work runs within shared RAM/VRAM limits.

Backlog #26–28 and applicable #10 belong in the first slice. Investigate #25 if it
blocks reliable saving/exit. Extend resource admission for #30 only where new processing
needs it; the full queue redesign, immediate background deletion #29 and separate merge
continuation #31 retain their own scopes. Branding/license/README work also stays separate.

While the user is playing, keep automated checks light and hidden. Run deferred RAW-heavy,
native desktop and GPU performance acceptance when the workstation is available. Preserve
the existing performance thresholds, source-matched baselines and failed evidence.

## Decision recorded

The user selected **Use the proposed two-goal split** on 2026-10-25. The authoritative
plan has been updated. Continue Goal 1 while preserving prior implementations and
research; leave advanced curve integration, named presets, final-size proof/output
sharpening and the FSR decision for Goal 2. Keep the full milestone active until both
goals meet their declared acceptance requirements.
