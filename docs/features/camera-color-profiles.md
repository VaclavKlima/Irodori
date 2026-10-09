# Camera color profiles and natural rendering

## Status

**Planned.** Existing camera matrices and verified Sony white balance remain supported; this brief adds validated characterization and rendering profiles. The current [ACES 2 renderer](../display-rendering.md) is separate from measured camera characterization and has no profile selector. Existing LibRaw color and exposure calibration remain approximations. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Produce believable neutrals, skin tones, foliage, and saturated highlights across verified cameras and illuminants, without using camera JPEG appearance as a colorimetric reference.

## User workflow

Open a RAW, see the matched profile and its availability, compare compatible profiles, and commit a profile change into the same history as light and white-balance edits. Unsupported cameras retain the current documented decoder path.

## Controls

Offer a compact profile selector only for validated options. Show provider/version and unsupported recording-mode reasons in photo information. Keep characterization separate from creative looks; do not label a look as a measured camera profile.

## Processing approach

Extend camera providers with characterization identity and supported camera/recording/illuminant conditions. Keep alias matching out of shaders. Research matrix-only versus matrix-plus-LUT transforms and single/dual-illuminant interpolation using licensed chart captures and independent reference values. Record decoder black/white levels, matrix direction, chromatic adaptation, white point, and extrapolation behavior. A decoder accepting a file does not establish color-profile validity.

White balance and characterization must compose once in a defined order, retaining HDR values and avoiding a second application of gains. Compare current Sony As Shot output before selecting defaults. Keep tone rendering and gamut compression in the separate output pipeline. Research format/library choices and redistribution licenses before shipping profile data; the present `CameraProfile` interface is not a general profile loader.

## API/MCP implications

Expose compatible profile IDs, versions, availability reasons, and a revision-checked profile edit through the shared service. MCP uses the same validation as the selector. Do not accept profile paths or arbitrary executable plugins.

## Persistence

Persist stable profile identity and required calibration version in settings and every snapshot. Migrate legacy edits to their original characterization. Profile changes invalidate upstream working assets; output-transform changes only invalidate downstream variants. Missing historical profiles must remain identifiable and must not silently resolve to a different profile.

## Dependencies

Requires [HDR processing](hdr-processing.md) and current camera/white-balance providers. [Tone mapping](tone-mapping.md) consumes characterized output. Each additional camera needs its own licensed RAW fixtures and recording-mode verification.

## Failure handling

Reject singular matrices, nonfinite LUTs, invalid illuminants, or mismatched camera modes. Keep normal viewing available with an explicit fallback profile label where supported; block unavailable historical rendering instead of misrepresenting it as exact.

## Acceptance criteria

- Record mean, 95th-percentile, and maximum color error against independent chart values under at least two illuminants; freeze numerical thresholds before choosing the profile implementation.
- Verify neutral ramps, skin, foliage, saturated lights, mixed light, and above-white samples in both SDR and HDR transforms; record visual review separately from chart metrics.
- As Shot and legacy settings preserve their established output; profile edits, white balance, history branching, restart, and UI/MCP parity pass.
- A second camera provider integrates without camera names or aliases added to GPU algorithms. Unsupported modes and invalid profile data return deterministic reasons.
- CPU/GPU transforms meet foundation tolerances, and cache keys distinguish profile versions without changing originals.

## References

- [Camera/provider extension guide](../../src/main/processing/README.md), [provider contracts](../../src/main/processing/contracts.ts), and [white-balance implementation](../../src/main/processing/white-balance.ts).
- [RAW processing and characterization context](../raw-processing.md).
