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
Apple Silicon macOS and Windows remain unverified. Hidden Wayland windows do not
establish foreground authored HDR selection or physical HDR luminance.

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
