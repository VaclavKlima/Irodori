# Vibrance and saturation

## Status

**Implemented; acceptance in progress.** Saturation and Vibrance are enabled with
shared history, typed MCP, preview/export GPU paths and equivalent CPU fallbacks.
The [processing decision record](professional-editing-processing.md#implemented-saturationvibrance-decision)
defines CIE Lab/D65 intensity, frozen numerical limits, migrations and focused
verification. Real-photo HDR/visual and source-matched performance gates remain
pending. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Control global color intensity with neutral defaults, stable luminance and hue, and predictable behavior above SDR white.

## User workflow

Adjust Saturation for overall color intensity or Vibrance for a restrained boost weighted toward less saturated colors. Compare SDR/HDR output and return either control to zero to restore its neutral contribution.

## Controls

Use `AdjustmentInput` for both controls, proposed integer −100…+100 with neutral 0. Saturation −100 produces neutral color while preserving the chosen luminance definition. Define Vibrance's weighting, negative endpoint, and any skin-tone protection precisely before labeling the behavior in UI; automatic skin detection is outside scope.

## Processing approach

Research an HDR-capable color model and chroma scaling rule on dark colors, skin, foliage, saturated lights, and values above 1. A clipped SDR HSL conversion is insufficient. Specify working primaries, reference white, luminance preservation, neutral-axis behavior, and how signed/out-of-gamut values enter the model. Vibrance weights must vary continuously near neutrals and saturated colors without hue-boundary discontinuities.

Freeze operator order relative to white balance, light controls, curves, and color mixer in the versioned stage graph. Apply gamut mapping at the documented output stage, preserving master headroom. Zero values bypass processing exactly; preserve alpha. Publish candidate comparisons, quantitative hue/luminance errors, and fixed tolerances before selecting the model.

## API/MCP implications

Extend typed edit patches with the two validated values. Combined color/light edits create one revision-checked history entry. Expose control capability and operator version through the same application API; reject nonfinite, fractional, or out-of-range values where integer controls are specified.

## Persistence

Transactionally migrate current settings and all history snapshots with zero defaults. Preserve cursor, redo branches, and revisions. Include operator versions and values in downstream cache identities; do not repeat RAW decoding for downstream-only gestures. Keep legacy render versions stable.

## Dependencies

Requires [HDR processing](hdr-processing.md), [camera profiles](camera-color-profiles.md), and [tone mapping](tone-mapping.md). The chosen color model supplies the foundation for [color mixer](color-mixer.md).

## Failure handling

Reject unsupported processing versions and malformed edits without altering confirmed state. Use the reference CPU operator on GPU failure. Invalid color-model results fail the render with a retry path rather than storing clipped replacement data.

## Acceptance criteria

- Both zero values reproduce baseline pixels; Saturation −100 produces equal working neutral channels within the chosen neutral-axis tolerance and preserves alpha.
- Test a brightness sweep from near black through 16× reference white and hue sweeps across the full circle; no NaNs, abrupt hue shifts, or clipping of the master.
- Vibrance measurably applies its documented weighting; record hue/luminance errors against fixed independent references.
- CPU/GPU output meets foundation tolerances; combined extremes, migrations, history/restart, stale requests, and MCP parity pass.
- Gestures retain one commit and keyboard cancellation; meet existing SDR interaction gates and record HDR latency separately.

## References

- [Adjustment inputs](../input-design.md), [shared adjustment contract](../../src/shared/adjustments.ts), and [current edit validation](../../src/shared/edits.ts).
- [Tone mapping and gamut policy](tone-mapping.md).
