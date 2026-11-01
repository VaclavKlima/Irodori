# Color mixer

## Status

**Functional implementation; photographic/performance acceptance pending.** Independent scalar, native C++, WebGPU
and hidden WebGL references pass for the original eight-range model in the
[processing record](color-mixer-grading-processing.md). GPU/CPU preview/export and
shipping native adapters have focused coverage. Settings 10/catalog 20 migrate
complete neutral groups through existing histories. Inspector controls, partial
typed API/MCP patches, section reset, shared history and small-raster frozen export
have hidden/service evidence. Combined real Sony RAW, photographic raster,
synthetic ISO gain-map and genuine v4 merge edits, frozen export and restart with
source/master preservation also pass focused checks. Native keyboard/minimum-size
checks pass on Bazzite after the GPU cleanup; see the
[acceptance record](professional-editing-processing.md) and current
[GPU migration boundaries](../gpu-processing.md). Broader photographic appearance,
physical HDR and source-matched sustained performance acceptance remain unfinished.
[Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Adjust hue, saturation, and luminance of selected color ranges while preserving smooth transitions, useful shadow detail, and HDR headroom.

## User workflow

Select a named color range, adjust its Hue/Saturation/Luminance controls, and inspect affected regions in the normal preview and comparison. Multiple range adjustments remain a single ordered part of the photo's edit pipeline.

## Controls

Use named red, orange, yellow, green, aqua, blue, purple, and magenta ranges with
`AdjustmentInput` and neutral zero. Each dimension has integer amounts −100…+100;
Hue maps to a maximum ±30 Lab degrees and Luminance to a maximum ±1 EV. The
[processing record](color-mixer-grading-processing.md) defines selection anchors,
overlap and neutral protection. UI colors supplement text labels. An optional
affected-area overlay is transient and must also be keyboard accessible.

## Processing approach

Use the HDR color model validated for global color intensity. Specify circular hue weights, overlap normalization, and neutral/low-chroma protection. Weights should derive from the input hue to the mixer stage so changing one range cannot unpredictably cascade into another. Resolve all ranges in one documented operator, with circular interpolation at the red wrap boundary.

Research how range luminance changes affect chroma and how to preserve hue near black and extreme highlights. Define precedence relative to global vibrance/saturation, curves, and local color adjustments in the versioned graph. Preserve values above white and alpha; leave final gamut compression to the output stage. Record smoothness and selectivity metrics before freezing the model.

## API/MCP implications

Accept validated patches keyed by stable range IDs and dimension, with expected revision. Return range definitions and units as capabilities. Combined patches commit atomically through the existing service. Neither range selection nor overlay visibility creates a photo edit.

## Persistence

Add zero-valued ranges to every historical settings snapshot transactionally. Persist range-definition and operator versions so later boundary tuning does not alter old edits. Include all range values in downstream frame identities; preserve upstream data reuse.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and the validated model from [vibrance/saturation](vibrance-saturation.md). Local mixer support, if offered later, also uses [local adjustments](local-adjustments.md).

## Failure handling

Reject unknown ranges, invalid dimensions, and nonfinite values. Unsupported processing versions remain clearly unavailable. Follow the [GPU-only direction](../gpu-processing.md): unsupported GPU capabilities or device loss fail explicitly, retire resources and allow an appropriate GPU retry without a CPU editing fallback. Failures never rewrite confirmed settings or original pixels.

## Acceptance criteria

- All-zero mixer output is identical to the preceding pipeline; changing one range follows its documented influence weights on a synthetic hue wheel.
- Dense hue sweeps cross 0°/360° and every range boundary without discontinuities above the fixed research tolerance.
- Near-neutral colors remain stable; exercise dark, saturated, and 16×-white samples, preserving finite values and alpha.
- Compare GPU RGB/hue/luminance errors against the independent reference with fixed tolerances; test overlapping extreme settings, explicit capability refusal, device loss/retry and resource cleanup. Retain historical CPU proofs without requiring another production backend.
- Shared history, migrations, restart, stale revisions, keyboard use, and equivalent UI/MCP edits pass.

## References

- [Vibrance/saturation color model research](vibrance-saturation.md), [input conventions](../input-design.md), and [shared edits](../../src/shared/edits.ts).
