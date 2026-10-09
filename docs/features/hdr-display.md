# True HDR display and SDR fallback

## Status

Supported Sony RAWs and merge masters use the automatic ACES 2 HDR/SDR renderer. Raster presentation stays display-referred. See [the implementation contract](../hdr-processing.md) and [isolated diagnostic](../hdr-diagnostic.md). Linux Wayland has hardware API and user visual evidence. Physical luminance is unmeasured; Local built-in MacBook Pro M4 display evidence is recorded; Windows and broader display certification remain unverified. The product is not certified or calibrated HDR output.

## Goal

Show verified HDR luminance on supported displays and an intentional SDR rendition elsewhere, with accurate mode and capability reporting.

## User workflow

Open a photo in Auto mode, inspect the active HDR/SDR state, switch to an SDR proof, and move the window between monitors. The photo's saved edits and normalized view remain unchanged while presentation adapts.

## Controls

Provide Auto, HDR when available, and SDR preview choices; report active mode, known headroom, and a concise unavailable reason. Keep application chrome at normal UI brightness. Do not present an estimated or unknown display peak as a measured nit value. Output targets and creative brightness choices follow the tone-mapping contract.

## Processing approach

Start with a synthetic-pattern feasibility spike. Chromium documents WebGPU canvas `rgba16float` with `toneMapping: { mode: 'extended' }` for output above SDR white; standard mode restricts the range. This is a candidate path, not proof of Luma compatibility. [Chromium HDR presentation documentation](https://developer.chrome.com/blog/new-in-webgpu-129).

Test the exact bundled Electron/Chromium runtime, GPU backend, compositor, OS HDR setting, and display. Compare alternative presentation paths only when necessary and record why. Detect available capabilities and distinguish API availability from verified end-to-end output. Research reliable headroom queries and behavior when the OS provides no absolute brightness calibration.

Production integration consumes a validated float frame and the selected tone/gamut transform. Declare canvas color space, reference white, alpha/compositing policy, and ownership of OS color conversion to prevent double transforms. Capability changes, monitor movement, scaling, sleep/wake, OS HDR toggles, and GPU/context loss invalidate the presentation target generation. Rapid changes must not flash stale HDR pixels or alter photo history.

SDR fallback renders the same master and edit revision through the controlled SDR transform, with a matching placeholder or neutral loader. Never route HDR data through RGBA8 and still label it HDR. Native decoders and filesystem access remain outside the renderer; any renderer WebGPU use is presentation of validated data.

## API/MCP implications

Expose typed display capabilities and active-target descriptors: verified/available/unavailable/unknown, reason, color space, transfer policy, relative headroom, and measured absolute values only when available. Photo statistics name their target separately. Presentation-mode changes are workspace operations, not photo edits; MCP must be able to distinguish requested from active mode.

## Persistence

Store user preview preference in workspace settings. Re-probe capabilities on launch and monitor changes. Include output target and display transform versions in presentation/cache identity; saved photo rendering intent remains independent of a monitor's current state.

## Dependencies

The initial spike has no dependency on a production master: use synthetic float patches. Its findings inform [HDR processing](hdr-processing.md). Production acceptance then requires that foundation and [tone mapping](tone-mapping.md); [analysis](hdr-analysis.md) consumes the resulting target descriptor.

## Failure handling

If HDR is unavailable, unknown, or lost, select SDR and show the reason without changing edits. A failed presentation device can use the current SDR fallback path after proper tone mapping. Do not imply that CPU rendering or a float texture alone guarantees HDR display.

## Acceptance criteria

- Measure a neutral patch ladder containing 1×, 2×, and 4× reference white up to available headroom on actual HDR hardware. Record meter readings, OS settings, display model, calibration, runtime, GPU/driver, and output mode; distinguish panel limits from processing clipping.
- Verify neutral/chromatic patches, SDR UI white, target gamut, and SDR/HDR comparison against known references. A screenshot or successful API call alone cannot pass this gate.
- Monitor moves, HDR toggles, sleep/wake, context loss, mixed DPI, and missing capability queries produce correct target changes, stale-frame rejection, and labeled SDR fallback.
- Maintain CSS-pixel zoom, pointer anchoring, pan constraints, capture cleanup, retries, and 1100 × 700 console layout. Record actual Electron presentation latency and memory separately from compute.
- Complete the platform matrix below with evidence or a concrete unsupported reason before release; no unverified row may be marketed as working HDR.

| Platform/configuration                       | HDR status today | Required release evidence                                                                                      |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Linux, Wayland and X11 considered separately | Unverified       | Compositor/OS HDR path, GPU/driver, display/headroom, fallback and monitor transitions.                        |
| Windows                                      | Unverified       | OS HDR on/off, GPU/driver, display/headroom, color management and mixed-monitor transitions.                   |
| macOS                                        | Unverified       | Built-in/external HDR configurations, reference brightness/headroom, color management and monitor transitions. |

## References

- [Chromium WebGPU HDR candidate](https://developer.chrome.com/blog/new-in-webgpu-129), reviewed September 20, 2026; it does not replace runtime/hardware verification.
- [Current presenter](../../src/renderer/src/preview/presenter.ts), [current preview architecture](../raw-processing.md), and [testing workflow](../testing.md).
