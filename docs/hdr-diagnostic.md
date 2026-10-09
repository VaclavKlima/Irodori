# Sony RAW HDR milestone: display diagnostic

## Status

The isolated display diagnostic established the Linux Wayland hardware candidate used by the [experimental Sony RAW HDR pipeline](hdr-processing.md). The owner visually confirmed HDR/SDR differences and chose to proceed without a meter. Local MacBook Pro M4 Pro hardware presentation and native full-screen evidence is now recorded in that processing document. Physical luminance, Windows and broader platform certification remain unverified. This is an experimental rollout, not completion of the original calibrated, cross-platform acceptance gate.

The diagnostic does not open a catalog, start the editor endpoint, or change photo settings. The application now keeps legacy SDR and experimental HDR processing identities separate. The renderer uses context isolation, sandboxing, no Node integration, and an isolated preload that only forwards resume notifications. Window-management permission is allowed only for the diagnostic's exact top-level document; all other permissions are denied.

## Run

```sh
# Default platform path, including on macOS
npm run hdr:diagnostic

# All Linux candidate configurations
npm run hdr:diagnostic -- --matrix

# Keep the diagnostic open for visual comparison and monitor transitions
npm run hdr:diagnostic -- wayland-vulkan --interactive

# On the MacBook Pro M4
npm run hdr:diagnostic -- --interactive
```

The launcher builds the app and creates a temporary profile. Closing the diagnostic saves evidence and removes the profile. Automated mode cycles SDR, HDR, and Auto and closes its windows. Each invocation writes a unique `artifacts/verification/*-hdr-display-*` directory with JSON reports, Chromium GPU reports, logs, and SDR screenshots. Screenshots and successful submission are not measurements of HDR luminance. An unavailable adapter is a valid diagnostic result, not a claim that HDR works.

Available configurations: `default`, `wayland`, `wayland-vulkan`, `wayland-native-vulkan`, `wayland-angle-vulkan`, `wayland-angle-blit`, `wayland-gl-interop`, and `x11-vulkan`. Nondefault configurations are Linux-only. Their exact flags and effective feature switches are recorded. The experimental application uses the Wayland Vulkan candidate; the other configurations remain diagnostic alternatives.

Playwright's Electron loader normally forces `--force-color-profile=srgb` and replaces requested feature flags with its screenshot feature. The separate diagnostic main entry removes the forced profile and restores the requested feature flags before Chromium initialization. Both overrides would invalidate HDR capability evidence. The normal application applies its own narrow capability configuration and removes the forced sRGB profile only for the isolated HDR test harness. Playwright owns ephemeral debugging ports during this isolated diagnostic, not Luma's production launch or fixed development MCP port.

## Patch and capability contract

- Four rows (neutral and three chromatic mixtures) contain linear RGB levels 0, 0.18, 1, 2, 4, and 16 relative to reference white. Colored rows use channel ratios `(1, 0.1, 0.1)` and permutations; their column headings describe the multiplier, not equal luminance across hues.
- `extended-srgb-transfer-v1` encodes each channel once with the sRGB transfer function. Both sRGB and Display-P3 canvas primaries use that transfer. Alpha is opaque. The patch shader writes `rgba16float`; it does not use an 8-bit intermediate. Float textures are bounded to 4096 × 2048 in this diagnostic.
- SDR comparison clamps linear channels to 1 before encoding and uses standard canvas tone mapping. HDR uses extended canvas tone mapping and preserves the submitted patch levels; it deliberately does not apply a photographic shoulder. The compositor/display may limit them. This diagnostic is separate from the photographic output transform.
- `ScreenDetailedHdrHeadroom` is enabled specifically. `hdrHeadroom` is in stops: the relative peak is `2 ** hdrHeadroom`. Invalid, missing, negative, or overflowing values fail closed to SDR. The media query is recorded separately and never substitutes for a numerical headroom query.
- Auto/HDR require a nonfallback WebGPU adapter, valid headroom above one, and an accepted canvas configuration. Every successful candidate remains explicitly unverified. Missing hardware leaves a neutral empty patch area with a reason.
- Screen changes, headroom events, focus, visibility, resize, and system resume re-probe. Each transition invalidates the generation and hides old pixels immediately. Device loss clears the canvas; **Recheck display** requests a new device. No photo exposure or edit revision depends on this state.
- Timings include pipeline creation, queue completion, and two animation frames. They are neither physical scanout timing nor a warmed photo-interaction benchmark.

The fast tests check logarithmic headroom, fallback policy, transfer round trips to 12 decimal places on fixed synthetic values, and the independent 0.18 encoding value to nine decimal places. The Electron test checks temporary-profile isolation, sandbox preferences, unrelated permission denial, missing-adapter fallback, mode changes, and the 1100 × 700 layout.

## Linux evidence, September 24, 2026

Corrected matrix evidence: `artifacts/verification/2026-09-24T14-09-28.946Z-hdr-display-QnLzAu/`. Earlier runs retain useful debugging logs but included harness overrides or incomplete launcher code and **must not be used as platform acceptance evidence**.

Runtime: Electron 44.3.0, Chromium 152.0.7977.78, Bazzite 44 / GNOME Wayland, Mesa 26.2.2. Chromium's OpenGL renderer identifies the Radeon RX 7900 XTX; WebGPU reports AMD `rdna-3`, nonfallback, on successful configurations. The complete Chromium reports retain the actual compositor, driver, and display details. The renderer sandbox and context isolation remained enabled, with no `--no-sandbox` flag. Chromium separately reports its GPU-process sandbox as `false`; this result must not be described as a verified GPU-process sandbox.

| Configuration                                | Observed result                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Default and explicit Wayland                 | No WebGPU adapter                                                              |
| Wayland Vulkan/OpenGL interop feature        | SwiftShader fallback; rejected                                                 |
| Wayland Vulkan, ANGLE Vulkan, and ANGLE blit | Hardware adapter; extended float canvas submitted on the HDR-reporting display |
| Explicit native Vulkan                       | Hardware adapter; observed SDR target on the SDR display                       |
| X11 Vulkan                                   | Hardware adapter; SDR target, no reported HDR headroom                         |

The display labeled `Microstep 34"` reported 4.5530028343 stops (23.474179624×); the `LG Electronics 22"` display reported zero stops (1×). These are API reports, not verified panel peaks or measured nits. Monitor selection changed during the run; per-generation records identify the actual screen. Wayland HDR candidate submissions took roughly 17–18 ms in the recorded samples, including two animation frames. The sample count is insufficient for a performance acceptance claim.

Final Wayland Vulkan smoke evidence is in `artifacts/verification/2026-09-24T14-35-36.267Z-hdr-display-2CejuC/`: hardware presentation, simulated device-loss clearing, and re-probe recovery succeeded. Physical output remains unverified.

Verification: `npm run verify -- ui preview` passed 104 tests, with zero failures/skips, in 296.7 seconds; evidence is in `artifacts/verification/2026-09-24T14-14-28.835Z-check-W7o5UY/`. After final diagnostic-only validation refinements, all four diagnostic tests passed again in 1.1 seconds, along with type checking, focused lint, and a rebuild. That diagnostic-only run did not change photo-processing, history, library, or MCP behavior. The later integration and its evidence are documented separately.

## Deferred physical and platform acceptance

The user approved a Linux-first experimental rollout without an instrument. Local macOS presentation checks supplement that evidence; physical readings, calibrated brightness and broader MacBook certification remain deferred. Before claiming verified physical output, record instrument, display mode and brightness settings, reference-white luminance, patch size/position, patch readings, uncertainty, runtime, GPU/driver, OS HDR on/off, mixed-monitor movement, scaling and sleep/wake. Establish numerical luminance tolerances before measurement. Windows remains unverified.

The integrated versioned processing, migration, output, analysis, UI/MCP and resource contracts are described in [HDR processing](hdr-processing.md). Diagnostic submissions and screenshots do not replace measurements. The initial GPU-process sandbox report remains an explicit limitation of the platform evidence.

## Sources and licensing

The diagnostic implements the [Chromium HDR canvas contract](https://developer.chrome.com/blog/new-in-webgpu-129) and the [Chromium logarithmic headroom interface](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/screen_details/screen_detailed.idl). Linux configurations follow [Chromium WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips), [the Vulkan/ANGLE testing switches](https://developer.chrome.com/blog/supercharge-web-ai-testing), and [the Vulkan/OpenGL interoperability rollout](https://developer.chrome.com/blog/new-in-webgpu-144). The sample's sandbox-disabling and headless flags are not used. `@webgpu/types` 0.1.72 supplies declarations under BSD-3-Clause; no new image fixtures or decoder code are included.
