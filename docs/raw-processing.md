# RAW processing and lens corrections

Luma registers repository modules for RAW decoding, verified camera capabilities, and lens correction. Runtime plugin installation and Lensfun database shipping are deferred.

For implementation steps, registration examples, versioning, and contributor checks, see [Adding lens corrections and image processors](../src/main/processing/README.md).

## Module contracts

- `src/main/processing/contracts.ts` defines `RawDecoder`, `RawSession`, `CameraProfile`, `LensCorrectionProvider`, and `LinearFrame`.
- `processing/formats.ts` contains lightweight decoder declarations used by both native pickers and import scanning. `processing/decoders.ts` registers worker implementations. Add an implementation and its declaration together; keep extension lists in the declaration.
- `processing/cameras.ts` registers camera modules. Sony ZV-1 and ZV-1A share `cameras/sony-zv1.ts`. Camera names and verified CFA requirements belong here, not in GPU algorithms or the viewer. LibRaw decoder support does not imply verified GPU support. Other layouts use CPU processing; unsupported compression needs a decoder update or another decoder.
- `processing/metadata.ts` registers lens providers. A provider resolves numeric metadata into radial tables and independent unavailable reasons. `tests/lens-correction.spec.ts` registers a test-only second camera and calibrated provider without changing orchestration or the viewer.

LibRaw and native Dawn stay in the bundled Node worker. Main imports only lightweight declarations and pure processing utilities. The renderer receives photo IDs, settings, status, and validated display frames; it has no filesystem or native-resource access.

### Coordinates, color, and ownership

`RawSource` contains owned, unpacked sensor samples, active dimensions, stored row width, active left/top margins, CFA order, black levels, white balance, camera matrix, and LibRaw flip. The Bayer reader handles storage margins before demosaicing. Camera profiles declare active-sensor coordinates and final decoder orientation.

A `LinearFrame` is an owned, interleaved RGBA `Float32Array`: unrotated active-sensor camera RGB, white-balanced, normalized to 0–1 sensor units, with padding alpha. It has no camera-to-sRGB matrix, display curve, or lens correction. The CPU adapter requests linear 16-bit camera output from LibRaw, then normalizes the memory-image API's oriented storage back to sensor coordinates. GPU AHD writes the corresponding camera RGB into a worker-owned `rgba32float` texture. The CPU and GPU retain at most one photo's intermediate; these SDR intermediates are not HDR editing masters.

Corrections run in this order:

1. Decode and demosaic into linear camera RGB.
2. Evaluate vignetting gain in source sensor coordinates.
3. Combine distortion and lateral chromatic aberration into one inverse radial mapping. CPU and GPU use Catmull–Rom bicubic interpolation with the same edge extension. The GPU applies gain to each source tap before interpolation, which avoids another full-sized texture.
4. Apply the camera matrix, neutral histogram-based brightness, exposure, contrast, and SDR sRGB display curve.
5. Apply final orientation and write RGBA8 plus its exact 96-pixel placeholder.

The original uncorrected path remains available when all corrections are off. A centered crop excludes unmapped borders and preserves the original aspect ratio to integer-pixel rounding. The crop uses native pixel spacing and never resizes back to the original dimensions. Decoded/cropped dimensions are authoritative for 100% and Fit. On the checked-in fixture, all corrections yield 5422 × 3622 versus 5496 × 3672 uncorrected.

The shared 4096-entry radial lookup contains red/green/blue coordinate scales and vignetting gain. It is independent of camera metadata syntax. Radius is normalized by the active image half-diagonal, measured from the center of pixel centers. The crop checks each edge pixel and each channel; providers must supply monotonic radial mappings. Taps at a valid border extend the outermost pixel.

### Sony embedded tables

Read ExifTool with `-G1 -n`. Prefer `SubIFD:DistortionCorrParams`, `SubIFD:VignettingCorrParams`, and `SubIFD:ChromaticAberrationCorrParams`; use the corresponding `SR2SubIFD` tags when absent. Do not use `Sony:DistortionCorrParams`, which describes a different maker-note field and is all zero in the fixture.

Each table has its own count prefix, followed by signed coefficients and optional zero padding. Chromatic aberration counts both channels, with red followed by blue. The fixture contains 11 distortion samples, 16 vignetting samples, and 22 chromatic-aberration coefficients (11 per channel). A missing or malformed table disables only that correction. Numeric fields are stored separately from formatted inspector strings.

For a table of N samples, sample radii are `(i + 0.5) / (N - 1)`. Distortion scale is `1 + value / 16384`; red/blue scales are `1 + value / 2097152`. Vignetting gain is `2 ** (2 ** (value / 8192 - 1) - 0.5)`. Values outside the supported ranges, malformed counts, nonfinite values, nonzero padding, and non-monotonic geometry are rejected. Each provider version and its parsed numerical result contribute to correction identity.

The correction order follows the [Lensfun modifier documentation](https://lensfun.github.io/manual/latest/structlfModifier.html). Sony coefficient interpretation was cross-checked against the upstream [darktable implementation](https://github.com/darktable-org/darktable/blob/master/src/iop/lens.cc) and [RawTherapee implementation](https://github.com/Beep6581/RawTherapee/blob/dev/rtengine/lensmetadata.cc). Luma's TypeScript and WGSL correction implementation is independently written; no Lensfun database or upstream lens module is bundled. Existing AHD attribution remains in `third_party/libraw`.

## Catalog, requests, and cache

The `processing` table introduced in schema 3 contains numeric metadata and legacy lens choices; schema 4 moves authoritative settings and revisions into shared edit history (see below). Imports publish the photo and processing row in one SQLite transaction. Existing photos lazily read metadata from their managed originals using a serialized metadata worker. No source files or reimport are needed. Bump `PROCESSING_METADATA_VERSION` when extraction or provider interpretation changes; older metadata is then reloaded lazily while preserving settings and their revision. Deleting a photo also removes its processing row through a catalog trigger.

`getLensSettings(photoId)` and `updateLensSettings(photoId, kind, enabled)` are narrow typed bridge operations. Updates validate the ID, setting name, boolean, and supported correction. Main serializes writes and emits `lensChanged`. The renderer updates controls immediately, reconciles confirmed state, cancels obsolete requests, and checks revisions before presenting pixels. Same-photo updates preserve normalized zoom/pan and stop pointer capture.

Preview cache v7 keys variants by original hash, module versions, correction-data identity, settings, and crop policy. Revisions identify requests, while identical settings can reuse an older pixel variant with the current revision. All variants, matching placeholders, and prepared float assets share the existing 2 GiB LRU budget and stream leases. Regeneration invalidates the selected variant; deletion invalidates every variant. Originals remain byte-for-byte unchanged.

GPU buffers are released after demosaicing before allocating the corrected texture. GPU allocations remain subject to the existing 1 GiB estimate and device limits; CPU retained float data is limited to 384 MiB. Changing supported corrections can reuse the active linear frame; cancelling work can terminate the worker. Changing photos, deletion, worker release, shutdown, and the 30-second idle timeout release retained resources. CPU workers may remain warm for corrected frames. Preview work stays outside the import/deletion task lock.

## Contributor verification

Select explicit suite targets for processing changes, for example `npm run verify -- --target full-previews --target full-previews-raw`. Broad `preview`, `adjustments`, and `library` scopes remain deliberate regression choices. Comprehensive commands require a user-requested or previously agreed checkpoint; feature completion alone never triggers one. Use `benchmark:preview` for preview measurements and `benchmark:all` or `check:all` for all existing performance gates, with a saved `LUMA_PREVIEW_BASELINE`. The real camera fixture's provenance and license remain in [tests/fixtures/README.md](../tests/fixtures/README.md); do not add private photographs to fixtures. Embedded JPEGs may be inspected for framing, never used as corrected preview pixels or color references.

Coverage includes uncorrected LibRaw regression, independent/malformed/unequal Sony tables, linear CPU output, synthetic grids, falloff and displaced channels, centered crops and portrait orientation, full-resolution CPU/GPU agreement, linear reuse, exact placeholders, settings revisions, cache variants/restart/removal, lazy catalog migration, rapid UI updates, native zoom, and the minimum console layout. Existing tests cover real embedded and decoder-fallback imports, cancellation, stale work, hardware loss, stream leases, and shutdown.

The benchmark reports correction time separately and compares CPU/PNG, CPU/RGBA, GPU/RGBA, corrected CPU/RGBA, and corrected GPU/RGBA through actual Electron presentation. Keep the pre-change `benchmark.json` in its unique run directory under `artifacts/verification/`, then set `LUMA_PREVIEW_BASELINE=/absolute/path/benchmark.json` for the post-change run. This adds the required 15% uncorrected CPU/GPU regression gate. The corrected GPU must remain faster than corrected CPU. Run benchmark samples without other GPU tests in parallel.

### Local results — September 15, 2026

Linux/Radeon RX 7900 XTX, bundled Node 24, checked-in Sony ZV-1 fixture; four measurements per path with independent workers. Times include generation, streamed loading, integrity validation, and actual Electron canvas presentation.

| Path                 | Before this change | After this change |
| -------------------- | -----------------: | ----------------: |
| Uncorrected CPU/RGBA |            2664 ms |           2701 ms |
| Uncorrected GPU/RGBA |             695 ms |            707 ms |
| Corrected CPU/RGBA   |                  — |           5297 ms |
| Corrected GPU/RGBA   |                  — |            747 ms |

The first-display regression gate passed: CPU +1.4%, GPU +1.7%. Corrected GPU was 7.1× faster than corrected CPU. Corrected GPU added approximately 40 ms to first display compared with uncorrected GPU. Cached GPU presentation was 34.7 ms versus 33.4 ms for the legacy PNG path in the same run, passing the existing 15% relative cached-presentation gate. Animation-frame waits depend on compositor refresh timing, so cached wall times should be compared within the same run.

The full-resolution corrected CPU/GPU comparison had mean absolute difference 0.00321 on the 0–255 scale; 0.00965% of RGBA components differed by more than two levels. These are fixture results, not guarantees for every photograph. The correction-stage diagnostics include resampling and downstream color work; the CPU stage also includes its final display conversion.

Verification passed: `npm run check` (67 tests; opt-in benchmark skipped there and run separately), six final focused Electron preview tests, two final RAW regressions, the extended benchmark with the saved baseline gate, `npm run mcp:test`, and `npm run mcp:check`. Direct `luma_ui` MCP inspection also verified the isolated development window and compact console layout. Generated evidence is under `artifacts/verification/` and `artifacts/mcp/`, outside version control. The test harness reloads its existing Electron window for MCP persistence checks because the MCP navigation tool intentionally blocks file-URL navigation.

Import-review and gallery thumbnails remain quick previews. Additional adjustments, HDR export, manual profile selection, longitudinal chromatic-aberration correction, and native terminal execution are separate milestones. Windows/macOS hardware and packaging require independent verification.

## Exposure and presentation — September 2026

Catalog schema 4 adds a versioned settings document (`version: 1`, `exposureEv`, and independent lens choices), ordered snapshots, and a history cursor. Existing version-3 lens choices and revisions become the initial snapshot; migration cannot reconstruct edits made before history existed. Current settings and history are saved in one SQLite transaction. Undo and Redo advance the same monotonic revision as ordinary edits; editing after Undo removes the redo branch. Deleting a catalog photo removes its history.

`getEdits`, `updateEdits`, `getEditHistory`, `undoEdit`, and `redoEdit` are the shared application API. Committed updates and history navigation require an expected revision. Conflicts reload confirmed settings in the UI and return an error through MCP. Legacy lens operations delegate to this service. `editsChanged` covers all adjustments; `lensChanged` additionally identifies upstream invalidation. Exposure gestures stay local until pointer release, key release, blur, photo change, or normal shutdown. Escape and pointer cancellation restore the confirmed value.

The rendering stages are decode/demosaic, lens correction, working linear RGB, adjustments, SDR conversion, and presentation. `src/shared/adjustments.ts` declares the versioned exposure module and display transform. Exposure multiplies linear RGB by `2 ** exposureEv`, before clipping and encoding; alpha is preserved. RAW automatic brightness is computed from the neutral histogram and never recomputed from exposed pixels. Camera-to-working conversion retains values above display white. Native Dawn uses the same adjustment arithmetic in WGSL; CPU and WebGL use the shared display parameters. Raster originals use sharp's embedded-profile handling and floating-point scRGB output, preserving their alpha and original precision before SDR conversion. See [sharp colour conversion](https://sharp.pixelplumbing.com/api-colour/).

The viewer first presents the authoritative RGBA frame on a viewport-sized Canvas2D surface, avoiding an expensive bitmap-to-WebGL upload on cached visits. It then prepares a matching, oriented, cropped RGBA32F working asset and display parameters, and switches to WebGL2 when that texture is ready. The main process owns asset paths, validation metadata, stream leases, cancellation, and cache eviction. The renderer validates dimensions, byte count, SHA-256, finite pixels, and display parameters before uploading a texture. These bounded SDR working assets are not HDR masters. Their source identity includes decoder, camera, lens, and crop versions, but excludes downstream adjustment versions and values. Exposure, contrast, and highlights variants reuse the same asset, including after worker restart. Prepared upstream data avoids repeated decoding or lens work during adjustment-only updates. Committed frames and placeholders remain revision-specific RGBA8 output.

Preview cache v7 includes RGBA frames, exact placeholders, and optional float assets in its 2 GiB LRU budget. Active frames, upstream assets, and streams are pinned. Float assets are at most 512 MiB; retained worker CPU float data is limited to 384 MiB. When retaining camera and corrected working frames would exceed that limit, the worker keeps the stage needed by the current request. Lens changes may then decode again. Native GPU allocations remain bounded by the worker's 1 GiB policy and device limits.

`PreviewPresenter` uses a viewport-sized WebGL2 canvas with a device-pixel-ratio-aware backing buffer. Geometry stays in CSS pixels: 100% means one source pixel per CSS pixel. Reduced images use filtered mipmaps; 100–3200% uses explicit nearest-pixel sampling. A one-CSS-pixel grid fades in from 800%, aligned to source pixel boundaries even with fractional pan. Renderer texture mipmaps and canvas buffers are checked against a 512 MiB allocation bound. Texture preparation happens after first display. Exposure changes update uniforms without reuploading textures or writing transient frames to disk.

Capability failures and context loss replace the surface with Canvas2D. A dedicated presentation worker retains the validated working pixels, runs the same CPU adjustment function, and coalesces requests using the complete exposure/contrast state. Native decoding remains outside Electron. Worker and texture resources are released on photo changes and shutdown; warm processing workers have a 30-second idle timeout.

Verification now includes catalog migration and failed transactions, history branching and concurrent revisions, exposure arithmetic and unchanged alpha, JPEG/PNG/TIFF neutral comparisons, native-GPU/CPU exposure agreement, WebGL pixel sampling, context loss, gesture grouping, conflict invalidation, close-time flush, and the dedicated stdio editing protocol. The benchmark exercises the actual `PreviewPresenter` and records warmed slider-to-presentation latency in addition to the unchanged 15% uncorrected first-display gate.

Local verification on September 17, 2026 passed `npm run check` (78 tests; two opt-in benchmarks run separately), `npm run gpu:check`, `npm run mcp:test`, `npm run mcp:editor:test`, and `npm run mcp:check`. Direct `luma_ui` inspection confirmed RAW exposure, toolbar history, 3200% zoom, and the 1100 × 700 console layout with no renderer errors. On the Radeon RX 7900 XTX, warmed exposure presentation measured p95 7.1 ms. Uncorrected GPU first display measured 742 ms against the saved 707 ms baseline (+4.9%); CPU measured 1832 ms against 2701 ms. Cached GPU presentation measured 34.6 ms against 33.4 ms for the legacy path. Both 15% regression gates passed. Benchmark JSON, logs, and screenshots remain under ignored `artifacts/verification/` and `artifacts/mcp/`. These measurements do not establish Windows/macOS behavior.

## Contrast and settings v2

Catalog schema 5 migrates the current settings document and **every** history snapshot from settings v1 to v2, adding `contrast: 0`. The migration runs in one transaction, including the catalog version. It preserves photo revisions, timestamps, history cursor, and redo entries. Earlier catalogs still receive their initial lens snapshot before entering the current schema.

`src/shared/contrast.ts` defines Luma's version-1 smooth luminance curve. Processing order is **Exposure → Contrast → SDR clipping/encoding**. RGB is exposed first; negative channels follow the existing display path's zero clamp. Luminance is `(0.2126 R + 0.7152 G + 0.0722 B) / displayWhite`. For `p = 0.18` and `s = 2^(contrast / 100)`:

```text
Y <= p: Y′ = p × (Y / p)^s
Y >  p: Y′ = 1 − (1 − p) × ((1 − Y) / (1 − p))^s
```

For `0 < Y < 1`, RGB scales together by `Y′ / Y`; black and luminance at or above white pass through to SDR conversion. Alpha is unchanged. Contrast 0 explicitly bypasses the curve, including the existing neutral RAW fast path and quantization. RAW automatic brightness remains derived from the neutral image. The 0.18 pivot follows the linear middle-gray convention described by [OpenColorIO](https://opencolorio.readthedocs.io/en/stable/api/transforms.html#PyOpenColorIO.ExposureContrastTransform.setPivot); the piecewise curve is Luma's own operator, not an implementation of OpenColorIO's contrast transform.

CPU, GLSL, and WGSL implementations share the module's version and constants. `AdjustmentParameters` carries all supported adjustments through committed preview generation and interactive presentation. Cache v6 includes all adjustment values and adjustment module versions in downstream frame identities while upstream float assets remain independent of adjustments. All existing allocation limits and eviction leases remain in force.

Contrast uses `AdjustmentInput` with −100…+100, step 1, integer formatting, and no unit. Typed draft patches share gesture grouping, cancellation, conflict handling, photo switching, shutdown flush, and toolbar Undo/Redo with exposure and lens edits. `luma_update_edits` accepts an integer `contrast` patch, optionally combined with exposure/lens changes in one history entry. Thumbnails, export, other unfinished adjustments, and HDR retain their previous scope.

Contrast verification on September 17, 2026 passed `npm run check` (89 tests, three opt-in benchmarks), `npm run gpu:check`, `npm run mcp:test`, and `npm run mcp:check`. The suite includes the dedicated editing MCP protocol. All three opt-in benchmarks passed separately against a saved pre-contrast baseline: uncorrected CPU first presentation was 1847 ms versus 1885 ms, and GPU was 746 ms versus 772 ms. Both 15% regression gates passed. Warmed exposure and contrast presentation each measured p95 7.1 ms on the Radeon RX 7900 XTX, below the 33 ms target. Direct `luma_ui` inspection confirmed combined RAW adjustments, toolbar Undo/Redo, and 1100 × 700 content with the console open and no renderer errors. Repeated history tests also verify that cancelled, superseded renders never flash a preview error. Logs, benchmark JSON, and screenshots are under ignored `artifacts/verification/contrast/`. Windows/macOS remain unverified.

## Highlights — September 2026

Highlights is a version-1 adjustment module with integer values from −100 to +100 and neutral 0. Every backend explicitly executes **Exposure → Contrast → Highlights → SDR conversion**. It uses a Luma-specific adaptation of the rational luminance mapping in [Reinhard et al., Photographic Tone Reproduction (2002)](https://www-old.cs.utah.edu/docs/techreports/2002/pdf/UUCS-02-001.pdf), not the paper's complete photographic operator.

After exposure and contrast, clamp linear RGB to nonnegative values and compute `Y = dot(rgb, [0.2126, 0.7152, 0.0722]) / displayWhite`. Bypass Highlights at 0 or `Y ≤ 0.18`. Otherwise, `h = highlights / 100`, `d = Y − 0.18`, `S = 0.18 + 0.82 × d / (0.82 + d)`, and `Y′ = (1 + h) × Y − h × S`. Multiply RGB together by `Y′ / Y` and preserve alpha. The curve has a continuous slope of 1 at middle gray. Negative values compress highlights, with −100 approaching display white asymptotically; positive values brighten them. This reveals detail already retained in working pixels and does not reconstruct clipped sensor channels.

CPU, GLSL and WGSL implementations live in `src/shared/highlights.ts`. Zero Highlights preserves existing exposure/contrast bytes, including the neutral fast path and RAW quantization. Nonzero Highlights activates linear rendering in CPU RAW fallback. Interactive WebGL passes Highlights as a uniform; native Dawn uses the previously reserved fourth adjustment component. Canvas2D requests and stale-result comparisons include the complete adjustment state.

Catalog schema **6** and settings **v3** transactionally add `highlights: 0` to current settings and every snapshot, preserving contrast, revisions, timestamps, cursor and redo entries. Earlier settings-v1 migration still runs first. A failure rolls back the entire migration. Preview cache **v6** includes the Highlights value and module version in rendered identities; upstream working assets remain independent of downstream adjustments.

Highlights uses `AdjustmentInput`, the shared controller, and photo-wide history. The same revision-checked service accepts MCP patches such as `{ "exposureEv": 1.25, "contrast": 35, "highlights": -60, "lens": { "distortion": false } }` as one history entry. Unsupported light and color controls remain disabled.

### Highlights verification — September 18, 2026

Linux/Radeon RX 7900 XTX, bundled Node 24, checked-in Sony ZV-1 fixture: `npm run check` passed 100 tests with four opt-in benchmarks skipped. `npm run gpu:check` verified native hardware computation. Synthetic native GPU and real RAW adjustment comparisons stayed within one RGBA level; combined adjusted lens-correction comparisons passed the existing mean/fraction tolerances. The minimum native 1100 × 700 layout keeps Highlights usable with the console open.

The saved pre-change benchmark measured uncorrected CPU/GPU first presentation at 1998/737 ms; the Highlights build measured 1804/744 ms (−9.7%/+1.0%), passing the 15% gate. Warmed Highlights presentation was 7.1 ms p95 against the ≤33 ms target. The initial Highlights benchmark launch timed out before importing; its isolated rerun passed. Exposure/contrast p95 were 7.1/7.5 ms, and cached GPU presentation was 13.85 ms versus 13.90 ms for the legacy PNG path. These local fixture measurements are not guarantees for other hardware. Evidence is stored under ignored `artifacts/verification/highlights/`; Windows/macOS remain unverified.

`npm run mcp:test` and `npm run mcp:check` passed. Direct `luma_ui` inspection verified −65 Highlights on the isolated Sony RAW profile, shared Undo/Redo, native 1100 × 700 content with the console open, and zero renderer errors. The development launcher now forwards explicit Electron profile arguments; see [isolated development inspection](testing.md#test-through-mcp).

## Shadows, Whites, and Blacks — September 2026

All six light controls use the shared edit service and photo-wide history. The processing order is **Exposure → Contrast → Highlights → Shadows → Whites → Blacks → SDR conversion**. The new version-1 Luma modules use integer values from −100 to +100, neutral 0, and nonnegative linear RGB. Their CPU, GLSL, and WGSL implementations live in `src/shared/shadows.ts`, `whites.ts`, and `blacks.ts`.

For each stage, recompute luminance normalized to display white: `Y = dot(RGB, [0.2126, 0.7152, 0.0722]) / displayWhite`, with pivot `p = 0.18`. Divide each control by 100 to obtain `s`, `w`, or `b`.

- Shadows adjusts dark detail below the pivot: `Y′ = Y × 2^(2s × (1 − Y/p)²)`. It preserves pure black and tones at or above the pivot.
- Whites adjusts the bright endpoint: `t = clamp((Y − p)/(1 − p), 0, 1)`, then `Y′ = Y × 2^(w × t² × (3 − 2t))`. Above-white data remains available until SDR conversion.
- Blacks adjusts the dark endpoint: `d = 0.04b × max(1 − Y/p, 0)³`. Positive values add `d × displayWhite` equally to RGB, including pure black. Negative values scale to `max(0, Y + d)`, safely bypassing division at zero luminance.

Shadows and Whites scale RGB together by `Y′/Y`; every stage preserves alpha. Neutral controls bypass processing explicitly, preserving previous exposure/contrast/highlights bytes and RAW quantization. Each nonzero control independently enables linear CPU RAW fallback. Native GPU uniforms add an aligned 16-byte vector (192 bytes total); WebGL uniforms and Canvas2D stale-result comparisons include all six values.

Catalog schema **7**, settings **v4**, transactionally migrate current settings and every history snapshot with three zero values. Sequential v1 → v2 → v3 → v4 migrations preserve revisions, timestamps, cursor, and redo entries; failures roll back all rows and the schema version. Downstream rendered identities include all module versions and values. The cache container stays at v6 so adjustment-independent working assets remain reusable; the existing 2 GiB disk and 256 MiB bitmap limits are unchanged.

A combined MCP patch such as `{ "exposureEv": 0.5, "highlights": -65, "shadows": 80, "whites": -40, "blacks": 25 }` creates one revision-checked history entry. `AdjustmentInput` handles numeric and slider gestures, while the shared controller handles drafts, cancellation, persistence, conflicts, and photo changes. Other unfinished controls stay disabled.

`npm run verify -- adjustments` covers curves, invalid values, legacy migration and rollback, combined history, renderer gestures at native 1100 × 700 with the console, MCP, raster and Sony RAW agreement, native GPU/WebGL/Canvas2D output, cache variants, and working-texture reuse. Sony import and embedded-preview failure remain in `import-raw.spec.ts` and `library-raw.spec.ts`. Benchmarks remain opt-in: `npm run benchmark:adjustments -- shadows` (also `whites` or `blacks`), under the existing warmed-presentation and uncorrected regression gates.

### Shadows, Whites, and Blacks verification — September 20, 2026

The selected adjustment scope, Sony import/embedded-preview-failure specs, and legacy deletion migration check passed **84 distinct tests, with no skips**, after targeted reruns. Type checking, lint, formatting, and the Electron build passed. Native GPU comparisons ran on Linux/Radeon RX 7900 XTX (Mesa 26.2.2); CPU/native GPU/WebGL agreement, Canvas2D fallback, working-texture reuse, mixed history, revision conflicts, and editing MCP passed. Native 1100 × 700 screenshots with the console open confirm accessible controls and independent inspector scrolling.

Verification took approximately 6 minutes 50 seconds including failed attempts and reruns. A black-lift test expectation was corrected, the local-port harness required execution outside the restricted sandbox, and the expanded RAW test switched from deep buffer equality to byte comparison to avoid exhausting the test runner's heap. Its four cold decodes also required increasing the test timeout; the successful case took about 50 seconds. Application rendering required no changes during these reruns. Evidence and the complete attempt list are in `artifacts/verification/2026-09-20T14-30-16.400Z-check-ocekqw/completion.json`; failed evidence remains intact. Benchmarks were not run. Windows/macOS and direct MCP client integration remain unverified.

## White balance, statistics, and comparison

Settings v5 and catalog schema 8 transactionally add `{ "mode": "as-shot" }` to current settings and every historical snapshot. Earlier migrations run sequentially. Revisions, timestamps, history cursor and redo branches are preserved. Processing metadata v2 is refreshed lazily for existing RAW imports without changing edit revisions or original files.

The versioned white-balance provider receives LibRaw's original `cam_mul`, `cam_xyz` (XYZ-to-camera characterization), and `rgb_cam` (camera-to-working conversion). See [LibRaw color data](https://www.libraw.org/docs/API-datastruct.html). Camera matching belongs in profile modules. Sony ZV-1/ZV-1A is the initial enabled family; invalid matrices or gains leave white balance unavailable. `src/shared/white-balance.ts` resolves gains once for CPU, GLSL and WGSL. Native uniforms allocate and pack 240 bytes together.

Luma temperature model `luma-kang2002-ucs-1` uses the [Kang 2002 Planckian locus](https://colour.readthedocs.io/en/latest/generated/colour.temperature.CCT_to_xy_Kang2002.html). Tint offsets its perpendicular CIE 1960 UCS normal by 0.0001 per unit toward green illuminants, making positive editor Tint a magenta correction. XYZ-to-camera response yields reciprocal positive gains normalized to the original green gain. Estimated As Shot readouts find the nearest locus temperature and signed normal distance; they are not camera Kelvin values. As Shot bypasses transformation exactly.

Custom white balance precedes Exposure and all other light controls, before negative working RGB is clamped. The equivalent working-space operation is `M × diag(customGains / asShotGains) × inverse(M)`. No RAW decode or texture upload occurs during a white-balance gesture. Rendered identities include white-balance provider/model versions and values; working assets include provider identity but exclude adjustment values. The cache container remains v6, with versioned downstream render identities.

The live histogram processes a deterministic sample of at most 65,536 pixels in a presentation analysis worker, coalesced to 10 Hz, with a final request on gesture completion. Tagged generations and asset identities reject obsolete replies. Exact committed statistics are computed on demand in the processing worker from a validated, leased RGBA frame and cached with its variant. Ordinary preview generation does not scan the full image for statistics. Requests for missing variants use the serialized preview scheduler without replacing its foreground consumer. Foreground requests preempt background work; revision checks and deletion reject stale statistics. A leased frame prevents eviction during analysis.

Clipping masks are allocated only when needed. One byte per source pixel plus an OR reduction pyramid preserves isolated clipped pixels in Fit and native classification when magnified. Viewport-sized overlay canvases consume these masks; filtering and pixel-grid decoration never feed the histogram. The source mask and pyramid occupy at most approximately 4/3 of source pixel count in bytes, within the float-worker allocation limit. Canvas2D uses the same processing and masks.

Before uses the existing working texture with neutral light and As Shot white balance. WebGL renders a split in one pass; Canvas2D retains a neutral bitmap and an edited bitmap with reservations against the existing bitmap cache. Current lens correction, orientation, crop, zoom and pan apply equally to both sides. Comparison does not write edit history.

### White balance, histogram, and comparison verification — September 20, 2026

The combined `ui adjustments preview mcp` selection, Sony import/embedded-preview failure, and legacy v1 catalog/removal check passed **112 distinct functional tests**, with no unresolved failures or skips, after focused reruns. Functional attempts took approximately 9.5 minutes, excluding manual inspection and standalone static/build checks. Type checking, lint, formatting, production build, isolated MCP acceptance, and direct `luma_ui` inspection passed. Native 1100 × 700 inspection with the console confirmed Sony Temperature/Tint, As Shot reset, split, histogram keyboard access, and clipping controls with no renderer errors.

On Linux/Radeon RX 7900 XTX (Mesa 26.2.2), warmed Temperature presentation with histogram and both overlays enabled measured **7.1 ms p95**, below 33 ms. This measures presentation, not completion of asynchronous full-image clipping masks. The final uncorrected CPU/GPU first-presentation medians were **1900/829 ms**, versus **1821/781 ms** at baseline (+4.3%/+6.2%). Both 15% gates passed; cached GPU presentation remained 13.9 ms. All eight benchmark cases passed after the focused preview rerun. Baseline, initial post-change attempt, and focused rerun took 93.8, 110.1, and 58.7 seconds respectively.

An initial 21% GPU regression identified eager exact histogram scanning on ordinary renders; exact statistics now run only when requested. Other resolved findings included Canvas2D bitmap leasing during rapid edits and alpha compositing on the Before half. Failed evidence is retained alongside successful reruns. The consolidated report is `artifacts/verification/2026-09-20T18-13-47.654Z-check-oGHIHU/completion.json`; direct inspection screenshots and error-free console logs are under `artifacts/mcp/`. Temporary inspection and automated profiles were removed. Windows/macOS remain unverified; no additional camera support or RAW highlight reconstruction is claimed.

## Current RAW rendering pipeline

Supported Sony RAWs and merge masters now use the automatic [ACES 2 rendering pipeline](display-rendering.md). Capture exposure uses nominal sensor saturation and a fixed input scale of 1, with As Shot gains applied once; no scene histogram sets brightness. Signed Rec.2020/D65 working values precede white balance, Light edits and scene-to-display rendering. Raster inputs remain color-managed display images and bypass that transform. Settings v7/catalog schema 12 preserve numeric history during automatic cutover, and cache v9 rebuilds RAW sources and derived previews while preserving originals and composite-master bytes. The earlier sections retain historical implementation and performance evidence; legacy RAW rendering is no longer selectable. See [HDR contracts, resource bounds and verification](hdr-processing.md).
