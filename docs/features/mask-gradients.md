# Linear and radial mask gradients

Issue [#84](https://github.com/VaclavKlima/Irodori/issues/84) adds one analytic
gradient per mask. Compound intersections and subtractions remain in
[#85](https://github.com/VaclavKlima/Irodori/issues/85). The reviewed
[Sunflower study](../design/mask-gradients.html) establishes the compact Coverage
and Adjustments layout at 1100 × 700 with Console open.

## Workflow and geometry

Create mask → Linear gradient or Radial gradient arms photograph drawing. A valid
drag creates a neutral mask atomically, selects it, enables Show overlay and opens
Adjustments. Cancellation and degenerate drags create no history. Place centered
supports keyboard creation using the cropped output extent independently of zoom
and pan: the middle half of the vertical extent for linear, and a centered ellipse
spanning half the cropped width and height for radial. Radial drawing starts at the
center and drags toward a bounding corner, initially unrotated with 50% Feather.

Coverage → Gradient shape holds Edit gradient, radial Gradient feather and a
collapsed Geometry disclosure. Geometry positions and ellipse diameters use full
oriented-photo pixels; rotation uses degrees. Geometry remains normalized in the
oriented source grid. Endpoints and centers allow −1…2; semiaxes allow at most
twice their corresponding source dimension. Separation and semiaxes require one
source pixel. Rotation is −180…180° and Feather is integer 0…100%.

Handles appear only in Coverage with Edit gradient active. Linear endpoints and
center move the transition; radial center, axis and rotation handles move and
reshape the ellipse. Arrow keys move a handle by one source pixel, Shift by ten;
one key gesture creates one history step. Escape, lost pointer capture, blur,
navigation and stale geometry cancel unfinished gestures. Paint/Erase and Edit
gradient are mutually exclusive, derived from the existing brush preference and
selected tab/mask. No new persisted workspace mode is added. Brush corrections
remain registered to the photograph when geometry moves. Show overlay is
independent of handles. Middle-button panning retains its existing owner.

Guides sample source geometry and invert the committed crop, lens and flip mapping
before screen projection. The bounded inverse checks monotonic lens mapping and
round-trip error; unreliable projection displays an explicit reason and leaves
numeric Geometry available. Pending edges retain committed exact coverage and
show draft guides; neutral-edge geometry drafts preview analytically.

## Coverage and durable contracts

Linear coverage is `1 − t²(3 − 2t)` for the clamped projection `t` between its
full-strength start and zero-strength end. This uses the standard cubic
[smoothstep definition](https://registry.khronos.org/SPIR-V/specs/unified1/GLSL.std.450.html).
Radial coverage uses source-pixel elliptical distance, a full-strength core with
radius `1 − feather/100`, and a smooth transition to zero at the outer ellipse.
Feather zero explicitly uses a hard boundary; inside is selected by default.

Composition is gradient → ordered Paint/Erase → inversion → Expand/Contract →
whole-mask Feather. Light and Color consume the resulting coverage once.
Prepared final coverage replaces the internal analytic gradient and ordered strokes,
with inversion already baked in, so coverage cannot be applied twice. Shared WGSL and
GLSL descriptors append two vec4s (11 total per mask); existing Color offsets stay
unchanged and allocation admission includes the expanded descriptor.

Settings 17/catalog 27 preserve Color, edges, immutable stroke/base content and all
history branches. Settings-16 presets and frozen edit jobs remain accepted.
Creation and complete geometry replacement share the application service and MCP;
duplication preserves geometry and corrections. A generated object base and a
gradient are mutually exclusive, and object refinement refuses gradient masks
before decoding or inference. MCP mask-context mapping defaults to inside-photo
points; `allowOutsidePhoto: true` permits normalized −1…2 gradient points and
rejects unsupported mapped coordinates. Brush validation remains 0…1.

## Verification

Registered focused targets: `mask-gradients-model`, `gradient-geometry`,
`mask-gradients-gpu`, `mask-gradients-webgl`, `mask-gradient-ui`. Affected service,
MCP, migration, frozen-output and mask-edge targets retain independent references.
The exact local evidence is recorded below after acceptance. Other-device
verification is owned by [#97](https://github.com/VaclavKlima/Irodori/issues/97):
the Apple Silicon Mac receipt is recorded below; Windows and integrated Radeon
WebGL remain unverified. Hidden Wayland windows do not establish foreground
authored HDR selection or physical HDR luminance.

### Bazzite acceptance — November 10, 2026

Tested checkout: `50eeb95` plus the local #84 implementation. No comprehensive
checkpoint or performance benchmark was requested or run. Exact inputs are tracked:
`tests/fixtures/photos/forest-light.jpg`, `tests/fixtures/photos/alpine-lake.jpg` and
`tests/fixtures/sony-zv1.ARW`, retaining their existing provenance and original bytes.

| Evidence                                                                                                         | Result and scope                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [RX 7900 XTX GPU/output run](../../artifacts/verification/2026-11-10T17-06-03.987Z-check-twgYiz/summary.md)      | 1,019 passed, zero failures/skips, 102.51 s; static checks/build, fast model checks, `mask-gradients-gpu`, `mask-gradients-webgl`, `mask-edge-gpu`, `mask-edge-mcp`, `masks-rendering`. Hardware witnesses: Dawn `amd-radeon-rx-7900-xtx-radv-navi31` / Mesa 26.2.6; ANGLE Radeon RX 7900 XTX / radeonsi navi31 ACO.                                                                                                                                   |
| [Integrated GPU and final UI run](../../artifacts/verification/2026-11-10T17-08-02.880Z-check-mpLh7L/summary.md) | 1,016 passed, zero failures/skips, 84.03 s; all four gradient UI cases, independent WGSL references, edge tests and GLSL. Dawn witnesses the integrated Raphael/Mendocino Radeon (Radeon 610M); Electron ANGLE still witnesses RX 7900 XTX, so this does not certify integrated WebGL.                                                                                                                                                                 |
| [Service/migration run](../../artifacts/verification/2026-11-10T17-00-40.211Z-check-2Ejteg/summary.md)           | 1,004 model passes plus 35 service passes; one new MCP assertion failed only on floating-point roundoff. Its [exact MCP rerun](../../artifacts/verification/playwright-1794330125062-d95a6244-6df6-442f-a331-4b1d40b4b647/playwright/summary.json) passes with a 12-decimal numeric comparison (one case, 1.21 s). Includes atomic geometry/admission, settings-16 history migration, presets/frozen jobs, correction retention and inference refusal. |
| [Retained UI/fidelity run](../../artifacts/verification/2026-11-10T17-02-44.381Z-check-OW5j9w/summary.md)        | Existing mask UI, presets MCP and Sunflower fidelity pass. The report retains two gradient UI failures: held-key cancellation and photograph readiness after native resize. These were corrected and exactly rerun; the final adapter/UI receipt below includes all four gradient cases.                                                                                                                                                               |

Real forest linear/radial gradients include local Light/Color, ordered brush
corrections and nonneutral Mask edges. The real Sony RAW case includes a
quarter-turned, straightened crop and an HDR JPEG. Frozen proof/export keeps the
existing ≤2 primary-channel gate and independent ISO gain-map reconstruction
absolute-error gate of 0.02. Coverage references include Feather 0/50/100,
source-pixel aspect/rotation, extended and degenerate geometry, all eight flips,
crop/lens registration, ordered corrections, inversion, edge processing and
prepared-coverage replacement.

Native 1100 × 700 Console-open radial and expanded Geometry screenshots remain
in the ignored test artifacts. Inspection confirmed aligned ellipse guides,
independent scrolling, pinned chooser/tabs and visible photograph/Console space.
Pointer drawing, capture loss, blur, held-key cancellation and one-step history
are renderer/native-window acceptance; no physical mouse hardware automation or
physical display measurement is claimed. Live signed-in Console and the
unavailable platforms in #97 remain unverified.

Mesa Vulkan selection used `DRI_PRIME=pci-0000_18_00_0!` for the integrated
Dawn witness. A separate GL-selector rerun without `!` also passes (one case in
5.7 seconds) but ANGLE again selects RX 7900 XTX; its
[exact receipt](../../artifacts/verification/playwright-1794330617108-0dd7b32c-1d75-48ea-bfb4-f57d2330b6ac/playwright/summary.json)
retains that witness. Integrated WebGL presentation remains unverified rather
than being inferred from integrated WGSL acceptance. Both final runner receipts
exceed the routine 60-second advisory; their linked details retain the slowest
ten cases. No assertion was shortened or removed.

### Publication review

The final audit corrected the MCP duplication schema to require `newId` and omit
an unsupported `gradient` field. Duplication retains the original mask geometry;
shape replacement uses the update operation. A transport schema assertion now
protects this contract. The [focused publication check](../../artifacts/verification/2026-11-10T17-36-22.835Z-check-c7YrKx/summary.md)
passes 1,008 cases with zero failures/skips in 59.0 seconds, including typecheck,
lint, formatting, production build, the fast model checks and all mask MCP cases.
The existing GPU, photographic output and native UI receipts remain applicable.

### macOS qualification — November 16, 2026

[#97](https://github.com/VaclavKlima/Irodori/issues/97) records the available-device
slice based on published main `d3fa365330aa62ae9ed108d0e8ede24d6507f93d`:
macOS 26.7 (25G229), Apple M4 Pro, 24 GiB unified memory, bundled Node 24.20.0,
Electron 44.3.0 and Playwright 1.63.0. Dawn witnesses Apple M4 Pro/Metal; GLSL
witnesses `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)`.
The native mask host and accepted C++ codec match the accepted #118 bytes.

**95 distinct selected feature/regression cases and 1,047 other cheap checks
pass**, with no unresolved Mac failure. Thirty-four Linux-only native RAW cases
remain unavailable. Original incomplete/failed invocation statuses are preserved;
these reconciled receipts establish the selected Mac slice, not a comprehensive
checkpoint or acceptance of other devices.

| Evidence                                                                                                     | Accepted scope                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Audited unchanged #99/#105/#118 receipts                                                                     | 86 selected passes: gradient model 4, gradient geometry 5, mask geometry 5, edge model 7, frozen rendering 5, mask service 6, mask MCP 11, catalog migration 21, edge service 12, edge GPU 4, edge MCP 3 and edge UI 3                                                         |
| [New GPU/GLSL selection](../../artifacts/verification/2026-11-16T18-51-31.966Z-check-I8ijji/summary.md)      | Four selected passes: independent WGSL coverage, crop/lens/all eight flips and quarter-turn registration, prepared edge replacement and GLSL; 1,072 total passed, zero failures, 34 unavailable, 53.70 s, original exit 2                                                      |
| [New foreground UI selection](../../artifacts/verification/2026-11-16T18-54-13.464Z-check-m4TwnX/summary.md) | All five UI cases pass: creation/geometry/restart, radial Feather/Paint/duplication, pointer and grouped-key cancellation, native 1100 × 700 Console-open Fit/100% guides and actual authored HDR; 1,073 total passed, zero failures, 34 unavailable, 57.89 s, original exit 2 |

The reused cases have matching relevant production/test/helper bytes, tracked
forest/alpine/Sony RAW fixture hashes and native executable hashes. This includes
settings-16 migration, immutable corrections, shared-service/MCP operations,
real cropped/rotated Sony RAW and forest linear/radial Light/Color with Paint/Erase
and nonneutral edges. Frozen SDR/HDR proof/export retains the ≤2 primary-code
gate and independent ISO reconstruction absolute-error gate of 0.02. Some source
invocations failed unrelated cases; their original statuses remain intact and
only individually passing cases are reused.

The qualification changes only the UI test: held-key cancellation uses the
platform primary modifier (Command+Z on Mac), the native case explicitly waits
for a current 100% frame and a visible center handle without changing history,
and a foreground case imports the existing synthetic ISO gain-map chart.
Neutral radial creation and a committed local exposure edit both present an
authored HDR frame at the exact settings revision, source identity, completed
request serial and display-target generation. The actual Built-in Retina Display
target reports 1800 × 1169 logical pixels at device-pixel ratio 2, hardware/extended
HDR capability and 2.2646618657× headroom (1.179295659 stops). The non-fallback
Apple/Metal WebGPU canvas uses `rgba16float`, Display-P3 and extended tone mapping;
revision 2 is presented at target generation 9. Serial equality is asserted;
numeric serial values are not serialized in the attachment. No probe is spoofed
and no OS display setting is changed. The synthetic chart establishes
presentation plumbing, not photographic quality or measured physical HDR luminance.

The four retained native captures were visually reviewed: Fit ellipses and
handles align, expanded Geometry scrolls independently, the 100% guide remains
registered with its center visible, and the HDR chart retains guides and Console
space. Captures are SDR layout evidence, not a calibrated HDR measurement.
Production processing, common backends, numerical/resource gates and the Mac's
reference arithmetic/tile batch 32/separate fence/cache-disabled policy are
unchanged. Windows x64, actual integrated Radeon ANGLE/WebGL, live signed-in
Console and physical display calibration remain outside this accepted slice.

The bounded local index, exact case reconciliation, source/fixture/native hashes,
visual review and retained HDR presentation attachment are under
`artifacts/mask-gradients/2026-11-16-macos-qualification/`. No new photograph,
benchmark or comprehensive checkpoint was needed. Verified default-branch delivery
of the qualification test and this brief is recorded in
[#97](https://github.com/VaclavKlima/Irodori/issues/97), which remains open for
Windows and integrated Radeon WebGL acceptance.
