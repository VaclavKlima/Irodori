# White balance picker

## Status

**Implemented; acceptance in progress.** Bounded read-only proposals and explicit
Apply share existing Temperature, Tint and As Shot history. Independent synthetic
D50/D65, rejection, coordinate, real isolated-worker/service and synthetic UI-component
checks pass. [Verification receipts](professional-editing-processing.md#inspector-implementation-evidence)
keep those scopes distinct. Actual Sony photo, native pointer/visual and physical-neutral
acceptance remain pending; this is not a claim of physical camera calibration.
[Shared requirements](README.md#shared-implementation-requirements) apply.

## Initial estimator decision

The initial provider is `neutral-camera-roi-v1`, limited to supported single RAW
captures with a white-balance profile and verified source limits. Imported HDR and
composite masters remain unavailable. The sample uses the existing oriented,
lens-corrected, As Shot linear asset before any custom white balance or creative
edit. Normalized coordinates select `floor(position * dimension)`, with endpoint 1
selecting the last pixel. A 7, 15 or 31 pixel square clips at image boundaries.
At most two authenticated 64-row strips are read, copying at most 961 pixels.
No rendered canvas pixels, additional RAW decode or full-image GPU readback is used
when the working asset is prepared. Estimation is small CPU work in the isolated
image worker; the accepted edit uses the ordinary GPU preview and CPU fallback.

Before integration, freeze these initial bounds: at least 16 valid pixels and 75%
coverage; alpha at least 0.99; every reconstructed camera channel at least 0.005 of
sensor white and below 80% of its verified black-subtracted saturation threshold.
The fourth CFA green threshold is included conservatively. Reconstruct the camera
domain using the provider matrix, source normalization and As Shot gains exactly
once. Prepared-source clipping checks are conservative estimates after demosaic,
lens processing and highlight blending; they do not expose an exact per-site RAW
validity mask. Native photographic acceptance must assess that limitation.

Estimate medians of log R/G and B/G. Reject a 90th-percentile maximum channel
deviation above 0.04 log units, and require the retained inliers to meet the same
coverage/count bounds. Search the existing provider's 50 K grid and integer Tint
near the CIE 1960 perpendicular projection, without clamping estimates into range.
The maximum residual normalized camera-channel disagreement must be at most 1%.
This assumes the selected surface is neutral; a uniformly colored surface cannot
be identified as such from one sample alone. No automatic neutral or skin detection
is claimed.

The independent initial checks use the published
[D50/D65 chromaticities](https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#predefined)
and synthetic camera responses. They verify recovery and rejection against these
fixed limits; they are not measured photographs under two physical illuminants.
That photographic criterion and real Sony source acceptance remain pending.

## Goal

Set white balance from a neutral area without sampling tone-mapped screen pixels or confusing clipped highlights with neutral material.

## User workflow

Activate the picker, move its sample area over the photo, inspect sample validity, and apply a valid neutral measurement. Temperature and Tint update together in one history entry. Escape leaves confirmed settings unchanged; As Shot restores original gains through the existing service.

## Controls

Provide a keyboard-focusable picker toggle, sample-size control, and readable validity feedback. Support keyboard positioning or numeric normalized coordinates and an explicit Apply action. Keep the existing Temperature/Tint input ranges and gestures unless the provider contract is deliberately extended. Picker interactions must release capture on cancel, photo change, or loss of focus.

## Processing approach

Sample a robust neighborhood from linear, pre-creative-adjustment data, with the inverse geometry mapping needed for orientation, crop, zoom, and lens corrections. Use source saturation/black-level information where available. Exclude transparent, invalid, clipped, and near-black samples; reject a region with insufficient valid coverage rather than inventing a neutral estimate.

Research robust median/trimmed estimation and the inversion into the current white-balance provider's Kelvin/Tint model. Record minimum luminance, valid-pixel fraction, channel-saturation thresholds, and residual neutral error before implementation approval. Do not clamp an unrepresentable illuminant silently into the UI range. Color profiles and as-shot gains must be applied exactly once. Mixed lighting may have no single global solution; report sample uncertainty. Merged and imported HDR assets require declared white-balance capability and source semantics, not guessed camera metadata.

## API/MCP implications

Design a read-only sample proposal operation taking photo ID, expected revision, normalized position, and bounded sample area. Return validity, provider identity, estimated settings, sample counts, and residual error. Applying the proposal uses the existing revision-checked edit service; sample coordinates never grant filesystem access. MCP and UI share the same estimator.

## Persistence

Persist resulting Custom white balance using shared history. Picker position and hover feedback are transient. Sampling provenance may accompany the edit for explanation, but playback uses saved settings/provider version rather than resampling. If the current settings type suffices, no new independent adjustment or history stack is needed.

## Dependencies

Requires [HDR processing](hdr-processing.md), [camera color profiles](camera-color-profiles.md), and existing white-balance/history services. Support for merged/HDR imports follows their capability adapters; initial availability can remain limited to verified RAW.

## Failure handling

Give distinct reasons for clipping, darkness, mixed samples, unsupported input, and out-of-model estimates. A stale revision or changed photo discards the proposal. No failed sample changes settings. Retain manual Temperature/Tint and As Shot where currently supported.

## Acceptance criteria

- Known neutral patches under at least two measured illuminants recover neutrality within a fixed residual tolerance selected during research.
- Tests reject clipped channels, black, transparency, tiny valid regions, and unsupported camera profiles without adding history.
- Cropped, rotated, panned, Fit, and 100% samples identify the same source area within the documented pixel-boundary rule.
- One accepted sample creates one combined edit; Undo/Redo, restart, concurrent MCP edits, Escape, and As Shot pass.
- Keyboard-only use works at 1100 × 700 with the console open, and sampling does not alter originals or display mode.

## References

- [White-balance model](../../src/shared/white-balance.ts), [edit service contracts](../../src/shared/edits.ts), and [input design](../input-design.md).
- [Current white-balance processing](../raw-processing.md#white-balance-statistics-and-comparison).
