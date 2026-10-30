# Detail and output sharpening

## Status

**Public detail controls implemented; output sharpening remains in Goal 2.**
Detail provides Amount 0…100, Radius 0.5…3.0 native source pixels in 0.1 steps and
Threshold 0…100 through shared numeric/slider inputs. Amount zero bypasses while
retaining the authored radius and threshold. Settings 11/catalog 21 and the typed
edit/MCP API share transactional history, revision checks and Undo/Redo. Source
preparation updates on commit; downstream point-color edits reuse the result.

The [detail decision record](detail-processing.md) fixes protected luminance
high-pass, noise protection, halo limits and denoise-before-sharpen ordering before
geometry/manual WB. CPU/GPU kernels, bounded source adapters and preview/export
leases retain independent small-fixture evidence. Focused public application
checks cover UI/MCP, original Before/Split pixels, keyboard gestures, cancellation,
minimum Console-open layout and restart. A tiny actual JPEG export freezes saved
detail controls across foreground retry and later edits. Real RAW/HDR/gain-map/
merge application, native input/visual, photographic and full-size performance
acceptance remain pending. Final-output-size proof and output sharpening are
separate unfinished Goal 2 features.
[Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Improve perceived detail without objectionable halos, amplified noise, or clipped HDR highlights, and tailor final sharpening to export dimensions.

## User workflow

Adjust detail sharpening at 100% after noise reduction. Inspect reduced previews with a clear scale indication. At export, choose output sharpening for the actual resized output and review its proof independently of the master edit.

## Controls

Provide Amount, Radius in source pixels, and validated threshold/detail protection using `AdjustmentInput`; Amount 0 bypasses. Output sharpening belongs in export options with Off as a valid choice. Final ranges, units, and protection semantics require algorithm evidence. Avoid making Fit look sharper by silently increasing the saved amount.

## Processing approach

Research bounded unsharp/deconvolution candidates using edges, texture, noise, and bright HDR impulses. Specify luminance versus channel processing, stage order, edge extension, negative-value policy, alpha treatment, and halo suppression. Define detail sharpening after the selected denoising stage and before final output preparation. Output sharpening uses final resized dimensions; research its placement relative to output tone/gamut mapping and encoding, then version it.

Reference calculations and measurements must quantify overshoot/undershoot, edge spread, texture retention, and noise amplification. A radius is never interpreted in CSS pixels or changed by device pixel ratio. Full-resolution computation or a validated approximation must underpin Fit; proof at 100% uses actual output pixels. Tile overlap must cover the filter support.

## API/MCP implications

Persist detail parameters via ordinary revision-checked edits. Include output parameters in typed export/proof requests and frozen job descriptors. Report source/output dimensions and the operator version so MCP can distinguish detail edits from export-only processing.

## Persistence

Migrate photo history with detail sharpening disabled. Save output sharpening in export presets/job manifests, not photo history unless a future explicit design calls for that. Include source scale, radius, algorithm version, and export resize policy in the appropriate cache identity. Legacy edits remain unchanged.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and the [noise-reduction](noise-reduction.md) stage contract. Detail sharpening can ship before export; output sharpening acceptance is completed with [export](export.md).

## Failure handling

Validate radius and allocation bounds before committing settings. On unsupported GPU operations, use the bounded reference CPU path. Export must report an unsupported sharpening mode rather than silently omitting it. Stale proof jobs cannot replace the active photo preview.

## Acceptance criteria

- Amount 0 is identical to baseline; flat fields remain unchanged and alpha is preserved.
- Edge/impulse fixtures meet predeclared overshoot, halo-width, and noise-amplification thresholds across SDR and 16×-white samples.
- Verify native 100%, Fit, multiple device pixel ratios, and two export sizes; radius behavior follows source or output pixels as specified.
- Tiled and reference output agree within fixed tolerances without seams; test CPU/GPU fallback, bounded memory, and cancellation.
- Detail history/restart, export preset round trips, UI/MCP parity, and preview/export proof agreement pass with real noisy and merged fixtures.

## References

- [Native-pixel preview contract](../../README.md#preview-controls), [input design](../input-design.md), and [noise reduction](noise-reduction.md).
- [Export output preparation](export.md).
