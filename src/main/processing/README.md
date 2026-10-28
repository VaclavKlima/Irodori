# Adding lens corrections and image processors

This guide explains how to extend Irodori's processing modules. Start with the [contracts](contracts.ts) and the working [LibRaw adapter](decoders/libraw.ts), [Sony camera profile](cameras/sony-zv1.ts), and [Sony lens provider](lenses/sony-embedded.ts). The [processing overview](../../../docs/raw-processing.md) describes the pipeline and its existing verification results.

Modules are TypeScript files registered in the repository and included in the application build. Runtime plugin installation is not implemented.

## Choose the extension point

| What you want to add                                                | Interface or location                                                             | Registration                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Correction data for a camera/lens combination                       | `LensCorrectionProvider` in `lenses/`                                             | `lensProviders` in [metadata.ts](metadata.ts)                                 |
| Camera aliases and verified GPU capabilities                        | `CameraProfile` in `cameras/`                                                     | `cameraProfiles` in [cameras.ts](cameras.ts)                                  |
| Another RAW decoder or RAW file extension                           | `RawDecoder` / `RawSession` in `decoders/`                                        | [formats.ts](formats.ts) and [decoders.ts](decoders.ts)                       |
| A new demosaicing algorithm, rendering backend, or raster processor | [preview-engine.ts](../preview-engine.ts) and the relevant CPU/GPU implementation | Explicit pipeline integration; no general image-processor registry exists yet |

Prefer an existing decoder and algorithm when they can handle the new camera. Decoder support and GPU support are independent: an unverified camera can still use CPU processing. Adding a camera profile cannot make a decoder understand unsupported compression.

## 1. Add a lens-correction provider

### Establish the data contract

Create `lenses/<provider-name>.ts` implementing `LensCorrectionProvider`. Its synchronous `resolve(metadata, tags)` receives normalized numeric processing metadata and group-qualified ExifTool tags extracted with `-G1 -n`. Do not parse formatted inspector labels. Match the actual make, model, lens, and any calibration conditions your data requires; check focal length and aperture when the calibration depends on them.

Return `null` when the provider does not apply. For a matching combination, return a `LensProfile` containing each independently verified correction. Omit an unavailable table and supply an English explanation in `unavailable` for that correction. Malformed or missing data must preserve other supported corrections and normal viewing, without throwing.

The provider converts its source data into the shared [LensProfile and RadialTable types](../../shared/lens.ts):

| Field                               | Meaning                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `distortion`                        | Output-to-source radial coordinate scale; `1` leaves geometry unchanged                          |
| `vignetting`                        | Multiplicative gain in linear camera RGB at the source pixel; `1` leaves brightness unchanged    |
| `chromaticAberration.red` / `.blue` | Additional radial coordinate scales relative to green, multiplied by the common distortion scale |
| `label`                             | Detected lens/profile name shown in the interface                                                |
| `provider`, `version`, `identity`   | Stable provider name, implementation/data version, and identity of the resolved correction data  |
| `unavailable`                       | Reasons keyed by `distortion`, `vignetting`, or `chromaticAberration`                            |

Each table has its own `radii` and `values` arrays; their lengths must match within that table, but different corrections can have different sample counts. Radius is measured from `((width - 1) / 2, (height - 1) / 2)` in unrotated active-sensor pixels and divided by the active image half-diagonal. Tables use piecewise linear interpolation and clamp to their endpoint values outside the sampled interval.

Validate at least two finite samples per table, strictly increasing nonnegative radii, finite positive scales/gains, and bounds justified by your data source. Geometric mappings must remain monotonic, including the combined distortion and channel scales, so the centered crop contains their mapped interior. The shared renderer assumes validated tables; it does not interpret calibration syntax or repair invalid profiles. Forward mappings, different radius conventions, or polynomial coefficients need conversion before returning the profile. Asymmetric or decentered corrections require an extension to the current radial contract.

### Implement and register

The following is a wiring template for `lenses/example-calibrated.ts`. **You must implement the imported `resolveCalibration` helper** in `example-calibration.ts` using verified data. Its return type is `Omit<LensProfile, 'provider' | 'version' | 'identity'> | null`; it performs the matching and independent validation described above. The example does not supply lens coefficients.

```ts
import { createHash } from 'node:crypto'
import type { LensCorrectionProvider } from '../contracts'
import { resolveCalibration } from './example-calibration'

const id = 'example-calibrated'
const version = '1'

export const exampleCalibrated: LensCorrectionProvider = {
  id,
  version,
  resolve(metadata, tags) {
    const calibration = resolveCalibration(metadata, tags)
    if (calibration === null) return null

    const profile = { ...calibration, provider: id, version }
    return {
      ...profile,
      identity: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    }
  },
}
```

Construct calibration objects in a deterministic field order before hashing. Include all resolved tables and their interpretation version in the identity. Include calibration selectors if they change the result; never use a source path, timestamp, or photo ID as the calibration identity.

Import the module in [metadata.ts](metadata.ts) and add it to the typed registry:

```ts
import { exampleCalibrated } from './lenses/example-calibrated'

export const lensProviders: readonly LensCorrectionProvider[] = [sonyEmbedded, exampleCalibrated]
```

The current resolver calls every provider and selects the **first non-null profile**. It does not combine tables from multiple providers. Keep matching narrow and put a more specific provider before a broader provider that would otherwise claim the same photo. A profile with no valid tables still counts as a match.

Bump `PROCESSING_METADATA_VERSION` in [shared/lens.ts](../../shared/lens.ts) when adding a provider or changing extraction/calibration interpretation. Existing imports then reload their stored processing metadata lazily from managed originals, preserving settings and their revision. Bumping only the provider version does not refresh already stored profiles.

The existing three checkboxes and applied-correction status use the returned profile automatically. Adding a fourth correction kind requires shared contracts, persistence, rendering, and UI work. Providers currently run for recognized RAW files; enabling them for raster images also requires changes to metadata selection and processing in [preview-engine.ts](../preview-engine.ts).

### Use Sony as a reference, not a universal format

The [Sony provider](lenses/sony-embedded.ts) handles `SubIFD` / `SR2SubIFD` tables independently. In the real fixture, distortion has 11 samples, vignetting has 16, and chromatic aberration has 22 coefficients split between red and blue. `Sony:DistortionCorrParams` is a different field. Do not copy Sony coefficient formulas or group names into another provider without evidence that they apply.

## 2. Add camera support

Create a camera module such as `cameras/example-camera.ts`. This fictional example deliberately declares only CPU support:

```ts
import type { CameraProfile } from '../contracts'

export const exampleCamera: CameraProfile = {
  id: 'example-camera-family',
  version: '1',
  make: 'Example',
  aliases: ['Camera A', 'Camera A II'],
  coordinates: 'active-sensor',
  orientation: 'decoder-flip-once',
}
```

Import it and append it to `cameraProfiles` in [cameras.ts](cameras.ts). Make matching is case-insensitive; model aliases are exact and case-sensitive. Inspect the decoder's normalized camera names as well as the ExifTool names used by your lens provider. A camera profile is not required merely to decode a file on CPU.

Only add the following capability after verifying the camera against the existing GPU algorithm and fixtures:

```ts
gpu: {
  algorithm: 'bayer-ahd',
  cfa: [0, 1, 3, 2],
  colors: 3,
  pixelAspect: 1,
},
```

This CFA uses LibRaw's channel numbering, including `3` for the second green. The current capability contract describes this specific Bayer layout and square pixels. Other layouts need algorithm and contract changes. The generic [GPU source reader](../gpu/raw-source.ts) also validates sensor storage, margins, black levels, white balance, and the camera matrix before allowing acceleration. Keep camera-name checks in profiles rather than adding them to shaders or the viewer.

## 3. Add a RAW image processor

### Declare supported files

If LibRaw already handles the desired format, extend its `extensions` in [formats.ts](formats.ts) and verify real files through both preview paths. Otherwise add a decoder definition with a unique ID and a lowercase extension without its leading dot. For example, an additional fictional definition is:

```ts
{ id: 'example-raw', version: '1', extensions: ['xraw'] }
```

Keep these declarations lightweight: Electron main imports them to generate import filters and native picker filters. Never import a decoder SDK, sharp, or Dawn into this file. The current LibRaw adapter reads the first definition by index, so preserve that entry's position unless you also update its lookup.

Selection currently uses the filename extension and chooses the first matching definition. There is no content-sniffing or decoder retry chain. Avoid overlapping extensions; a decoder's `open` must still validate the actual file and report unsupported or corrupt input.

### Implement the worker adapter

Create `decoders/example-raw.ts` exporting a `RawDecoder` with the same ID, version, and extensions as its declaration. Follow [decoders/libraw.ts](decoders/libraw.ts) for resource cleanup and CPU behavior. `open(path)` must resolve to a complete `RawSession`:

| Member               | Required behavior                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`           | Camera names, full sensor storage dimensions, active left/top margins, color count, and CFA order                                      |
| `dimensions`         | Unrotated active width/height and the final decoder flip                                                                               |
| `unpack()`           | Unpack sensor samples; repeated calls must be safe                                                                                     |
| `gpuSource()`        | Return a validated, owned [RawSource](../gpu/raw-source.ts) for the supported algorithm, or `null` to use CPU                          |
| `linear()`           | Return an owned, full-resolution `LinearFrame` for CPU lens corrections                                                                |
| `display(halfSize?)` | Return packed 8-bit, three-channel display RGB with orientation applied; full resolution by default and a quick preview when requested |
| `close()`            | Release decoder resources, including after errors                                                                                      |

`LinearFrame.data` is interleaved RGBA `Float32Array` storage with `width * height * 4` elements. RGB is white-balanced linear camera RGB in normalized sensor units; alpha is padding. Pixels remain in active-sensor coordinates with no lens correction, display curve, or camera-to-display conversion applied. `matrix` carries the camera-to-linear-sRGB coefficients as three rows of four values, with the first three columns used for RGB. It is metadata accompanying the pixels, not a transform already applied to them.

`flip` uses the decoder convention: bit `1` reflects X, bit `2` reflects Y, and bit `4` transposes, in that order. If your decoder returns oriented linear pixels, normalize them back to active-sensor coordinates as the LibRaw adapter does. The final renderer applies orientation once after correction and cropping.

Returned pixel storage must outlive the decoder session; do not retain views into freed SDK/WASM memory. Enforce allocation and input limits before allocating large buffers. The current LibRaw adapter caps input at 512 MiB and retained linear pixels at 384 MiB. Supply a working CPU path even if the adapter can produce GPU source data. Full RAW display must decode sensor pixels; embedded JPEGs are only for quick import/gallery previews.

Import the adapter and append it to the registry in [decoders.ts](decoders.ts):

```ts
import { exampleRawDecoder } from './decoders/example-raw'

export const rawDecoders: readonly RawDecoder[] = [librawDecoder, exampleRawDecoder]
```

Keep decoder and native resources inside the bundled Node processing worker. Document any new runtime dependency and license in [runtime dependencies](../../../docs/runtime-dependencies.md), preserve the npm lockfile, and verify bundling and native externalization. Do not load sharp or native GPU libraries into Electron.

## 4. Change a rendering backend or processing stage

A new decoder can reuse the current rendering pipeline. A new raster processor, demosaicer, or GPU algorithm requires explicit integration in [preview-engine.ts](../preview-engine.ts); it cannot be installed by registering a lens provider or camera alias.

Use [preview-types.ts](../preview-types.ts) for the worker/API contracts and [preview-process.ts](../preview-process.ts) for cancellation and worker lifetime. The CPU reference is [lens-correction.ts](lens-correction.ts); GPU processing lives in [raw-renderer.ts](../gpu/raw-renderer.ts) and [lens-shader.ts](../gpu/lens-shader.ts).

Preserve these behaviors when integrating a backend:

- Correct linear camera RGB before color/display conversion. Apply source vignetting gain before a single combined distortion/channel resampling. CPU and GPU use matching Catmull–Rom bicubic interpolation.
- Correct in sensor coordinates, crop to a centered rectangle at native pixel spacing, then apply orientation. Return the actual cropped dimensions; do not enlarge the result to restore the original dimensions.
- Preserve the uncorrected path when all corrections are off. Keep import-review and gallery quick previews separate from full rendering.
- Return RGBA8 sRGB with valid dimensions, byte count, frame hash, render identity, settings revision, and applied-correction status. Generate the blurred placeholder from that exact output frame.
- Preserve CPU fallback, cancellation, stream leases, deletion, shutdown, and release of retained frames. Retain at most the active photo's bounded intermediate; current GPU allocation estimates are capped at 1 GiB.
- Keep renderer requests limited to typed photo-ID operations. File paths and native resources remain in the privileged worker boundary.

Additional adjustments, HDR, manual profile selection, and longitudinal chromatic-aberration correction remain separate milestones.

## Versions and cache invalidation

| Change                                                                           | What to update                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Add/change provider matching, extraction, or calibration                         | Provider `version` and resolved `identity`; increment `PROCESSING_METADATA_VERSION` to refresh persisted profiles |
| Change decoder output or support                                                 | Decoder definition `version` in `formats.ts`, kept consistent with the adapter                                    |
| Change camera capabilities                                                       | Camera profile `version`                                                                                          |
| Change correction/color pixel policy                                             | `LENS_RENDER_VERSION` in `lens-correction.ts`; update relevant backend render IDs as well                         |
| Change crop policy                                                               | `CROP_POLICY` in `lens-correction.ts`                                                                             |
| Change broader frame/cache format or output policy not covered by the module key | `PREVIEW_VERSION` in [full-previews.ts](../full-previews.ts)                                                      |

The preview key includes the original content hash, decoder definitions, camera profiles, correction-data identity, settings, lens rendering version, and crop policy. A backend render ID alone does not invalidate the cache key. Settings revisions protect requests from stale responses; they are not pixel identities, so returning to identical settings can reuse a cached variant. All variants, their exact placeholders, and prepared floating-point assets share the 2 GiB disk-cache budget. Exposure, contrast, highlights, shadows, whites, blacks, and lens settings use the shared schema-7, settings-v4 edit document and history; see [exposure and presentation](../../../docs/raw-processing.md#exposure-and-presentation--september-2026).

## Verify the module

Use licensed, attributed fixtures and record their provenance in [tests/fixtures/README.md](../../../tests/fixtures/README.md). Synthetic test data belongs in tests, never in production profiles. The [second camera/provider test](../../../tests/lens-correction.spec.ts) demonstrates extension through injected registries without viewer changes.

For performance work, save a baseline from `npm run benchmark:preview`. Its unique artifact directory survives subsequent verification runs. For correctness changes, select explicit suite targets. Comprehensive checks require a user-requested or previously agreed checkpoint; feature completion alone never triggers one. After implementation:

1. Test provider selection, unrelated files, missing/malformed tables, independent availability, unequal lengths, calibration boundaries, and stable identities.
2. Compare grids, synthetic brightness falloff, and deliberately displaced channels with the CPU reference. Cover sensor margins, portrait orientation, all supported flips, native crop dimensions, and CPU/GPU agreement.
3. Preserve the real Sony compressed ARW regression through embedded quick previews and decoder fallback. Verify new formats with real sensor data, including GPU failure and CPU-only operation. Embedded JPEGs are framing references, never pixel/color references for full processing.
4. Exercise persistent toggles, rapid changes, stale responses, cache reuse, restart, lazy metadata refresh, cancellation, deletion, exact placeholders, and same-photo zoom/pan through Electron and MCP.

Useful focused checks, run from the repository root:

```sh
npm run verify -- --target lens-correction --target lens-correction-raw
# Add affected cache/library/UI targets explicitly; use --plan to inspect selection.
```

At an agreed comprehensive checkpoint:

```sh
LUMA_PREVIEW_BASELINE=/absolute/path/baseline.json npm run check:all
```

The preview benchmark requires the uncorrected CPU and GPU paths to stay within 15% of the saved baseline and corrected GPU rendering to remain faster than corrected CPU rendering. It reports correction overhead separately and measures actual Electron presentation. `benchmark:preview` covers preview measurements only; `benchmark:all` retains all benchmark families. Missing baselines or required hardware produce incomplete verification. Run benchmarks without competing GPU tests.

`LUMA_RAW_TEST_FILES` accepts a JSON array of absolute paths for additional GPU regression samples; `LUMA_RAW_BENCHMARK_FILE` selects one benchmark RAW. Keep private samples outside committed fixtures. Report hardware skips and unverified platforms explicitly.

For visual changes or unresolved UI problems, start `npm run dev:mcp`, inspect the actual renderer with `luma_ui`, and run `npm run mcp:check` against that window. Follow [testing.md](../../../docs/testing.md) for isolated libraries, MCP setup, and process cleanup. Record commands, fixture coverage, pixel comparisons, performance results, and any remaining limitations in the contribution.

## Register another display adjustment

1. Declare a module beside `src/shared/contrast.ts` with an ID, version, limits/default, and matching CPU, GLSL, and WGSL functions. Register it in `adjustmentModules` in `src/shared/adjustments.ts`, and explicitly add its execution in the same order in CPU conversion, native `ahdShader` display, and the WebGL presenter. Registration alone does not execute a module. Keep decoder/camera/lens work upstream.
2. Extend `AdjustmentParameters`, neutral defaults, complete-state equality, edit validation, and the editing MCP schema. Add an explicit settings/catalog migration for **current settings and all snapshots**, preserving cursor, redo, revision, and timestamps transactionally. Never insert fake migration edits into history.
3. Pass parameters through the worker, committed rendering, uniform data, and the fallback worker. Include module versions and values in rendered-frame identity, but do not put display adjustments in upstream working-asset identity. Bump the cache output version when changing pixel policy.
4. Use `AdjustmentInput` and typed controller patches for numeric sliders, following [input design](../../../docs/input-design.md). Flush the previous control before starting another; keep history in the workspace toolbar. Other input types can use the same controller without owning persistence.
5. Verify independent curve invariants, neutral byte identity, alpha, CPU/native/WebGL agreement on synthetic and real RAW pixels, complete-state fallback coalescing, migration rollback/redo, mixed history, MCP conflicts, restart/shutdown, and texture/upstream reuse. Extend the warmed interaction benchmark while retaining the neutral 15% regression gate and p95 ≤33 ms target.

## Add a white-balance provider

Implement `WhiteBalanceProvider` from `contracts.ts` and register it in `white-balance.ts`. Resolve a profile only for independently verified camera models; keep aliases and capability flags in `cameras/`. The decoder adapter supplies owned numeric arrays for original As Shot gains, XYZ-to-camera characterization, and camera-to-working RGB conversion. A provider supplies stable identity/version, model version, supported ranges and estimated readouts. Validate finite, invertible matrices and positive channel responses across the complete supported range. Do not add camera names to CPU arithmetic, GLSL, WGSL or UI code.

The shared resolver computes a working-space 3×3 transform, so a new provider does not change shaders or controls. Adding camera support requires real fixtures and attribution, measured reference values, temperature/tint direction, As Shot byte identity, combined CPU/native GPU/WebGL/Canvas2D agreement, alpha, corrections and cache reuse tests. `white-balance.spec.ts` includes a synthetic second provider solely to verify modularity; it does not establish support for another camera. Current verified profiles remain Sony ZV-1/ZV-1A.
