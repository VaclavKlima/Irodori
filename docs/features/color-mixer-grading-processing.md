# Color mixer and three-way grading processing

## Status

**Contract established 2026-10-25; functional adoption verified through 2026-10-27; full acceptance pending.**
This is the Goal 1 operator-specific decision record under
[professional editing](professional-editing.md). Independent scalar, native C++, WebGPU
and hidden WebGL checks pass. CPU, GPU export, HDR cache/first-surface/histogram and
actual SDR presenter adapters have focused synthetic coverage. The shipping native
helper consumes validated color packets with a rebuilt provenance identity. Versioned
history, inspector controls and typed API/MCP are implemented; focused hidden and
small-raster evidence is recorded below. Full HDR application lifecycle,
photographic, native visual/input and performance acceptance remain unfinished.
Existing numerical and performance thresholds stay fixed. Settings 10/catalog 20
add complete neutral groups to every current and historical snapshot.

## Source, order and intended behavior

Use the established CIE Lab/D65 model with explicit linear sRGB or Rec.2020 primaries.
Do not use clipped display HSL for processing. The proposed order is corrected native
source → committed geometry → white balance → Light → curves (Goal 2) → mixer →
Saturation/Vibrance → three-way grading → existing output transform. Raster and
authored HDR adapters retain their own output semantics. Denoise/detail placement
remains its separate decision. Input hue determines mixer weights once; downstream
hue changes never select a second range. Grade weights use luminance entering grading,
before that operator's brightness adjustment.

The mixer precedes global intensity, so global desaturation still produces a neutral
image. Grading follows intensity, allowing a deliberate toned monochrome look. An
all-zero mixer/grade must retain the existing intensity path exactly, without an
extra image pass, decode or source upload. Compile control constants once per edit;
GPU uniforms carry small constants while the existing working source stays resident.

## Range definition and mixer candidate

Stable IDs are red, orange, yellow, green, aqua, blue, purple and magenta. Their
reference encoded-sRGB colors have nominal wheel hues 0, 30, 60, 120, 180, 240, 270
and 300 degrees, full saturation and value 1. Decode the sRGB transfer, derive XYZ
from primary/white chromaticities, then derive CIE Lab/D65 unit opponent vectors.
Pin these vectors and resulting Lab angles in independent fixtures/capabilities;
never tune them by camera model or silently change old range definitions.

For selection, divide input RGB by its largest absolute channel before calculating
Lab opponent coordinates. This removes positive exposure scale without division by
luminance, and bounds the signed input to the selection transform. Exact black and
neutrals have no selected hue. Adjacent reference directions form circular arcs shorter
than 180 degrees. The barycentric coordinate of the input ray on that chord gives
`t` in 0…1; use `t²(3−2t)` for the second range and its complement for the first.
Only those two neighbors contribute, with weights summing to one. No pixel `atan2`
is needed. The actual chroma edit uses the original, unnormalized working color.
Evaluate each anchor cross product once and reuse its sign on both neighboring
intervals, including the wrap. Independent reversed products can round asymmetrically
at an exact anchor and leave a gap; no epsilon or expanded influence range is needed.

Near-neutral protection uses normalized Lab `r²=C²/(L²+4C²)`, or zero at a zero
denominator. A cubic smoothstep between `r²=0.0004` and `0.0064` gives protection
`p`. Below the lower endpoint all mixer controls bypass exactly; above the upper
endpoint they have full influence. This is color-strength protection, not skin
classification or an exposure threshold.

Each range has integer Hue/Saturation/Luminance amounts −100…+100, neutral zero:

- Hue amount maps to a maximum ±30 CIE Lab degrees. Compile each range's complex
  rotation once. Blend its real/imaginary components with the two input weights
  and protection, then normalize the complex rotation. Its real part stays at least
  cos(30°), so normalization cannot encounter an opposite-vector singularity.
- Saturation gain is `1 + p*sum(weight*amount)/100`, bounded to 0…2. Complete selected
  desaturation yields the working neutral at the resulting linear luminance.
- Luminance uses gain `2**(p*sum(weight*amount)/100)`, a maximum ±1 EV. Multiply linear
  Y by that gain and preserve Lab hue/relative `a/L,b/L`. Both-toe lightness ratios
  use the gain directly, including zero and signed Y; other ratios have a nonzero
  denominator. No output channel or above-white value is clipped by the operator.

Hue units are an amount in the UI, not nominal RGB-wheel degrees. Saturation and
luminance are amounts with the definitions above. Gray pixels remain unchanged.
The eight reference colors are selection anchors; Lab is not claimed perceptually
uniform over scene HDR, and its especially narrow blue/purple arc needs photographic
inspection before acceptance.

## Three-way grading candidate

Shadows, midtones and highlights each have Hue 0…359.9 nominal wheel degrees in
0.1-degree steps, Saturation 0…100 and Luminance −100…+100 integer amounts.
Hue maps through the same reference-color chord wheel, giving familiar red at 0,
green at 120 and blue at 240. Compile the unit Lab direction, not pixel RGB, once
per tone. Saturation at zero makes Hue powerless. Neutral defaults are zero hue,
saturation and luminance, Blending 50 and Balance 0.

For positive entering linear Y, let `z=log2(Y/0.18)+Balance/50`; nonpositive Y takes
the shadow endpoint. Let `b=0.5+3.5*Blending/100` stops and `F(x)=smoothstep(-b,b,x)`.
Weights are `S=1−F(z+2)`, `H=F(z−2)`, `M=1−S−H`. They are nonnegative, normalized
and C1 at the transition endpoints. Blending 0…100 widens overlap; positive Balance
shifts influence toward highlights. Freeze these original Irodori weights rather than
claiming they reproduce Adobe's proprietary implementation.

Grade luminance gain is `2**(sum(weight*amount)/100)`; apply it to linear Y and scale
existing Lab opponents by the same lightness-ratio rule. Add the weighted tone vectors
to `a,b`, at maximum chroma `0.5*max(L,0)` for Saturation 100. Identical tone settings
produce a global grade independent of blending/balance. Zero strength/luminance
bypasses regardless of unused hue, blending or balance. Black stays black; nonpositive
lightness receives no added tint. Diffuse white is not a scene-HDR ceiling: highlights
above white remain eligible rather than introducing an SDR white anchor.

## Numerical policy and predeclared gates

Use stable Lab differences in the linear toe and stable inverse deltas when applying
small edits. Zero/unused operators bypass exactly. Preserve signed/HDR values and
leave alpha untouched when integrating frame adapters. No external model or code
dependency is introduced; the independent oracle and generated synthetic data are CC0.

- Decimal80 scalar reference: per RGB channel `2e-12 + 2e-11*abs(reference)`, matching
  the established color-intensity scalar limit. GPU/native ports retain canonical
  `2e-6 + 2e-5*abs(reference)`; do not relax it for new color controls.
- Weight sums within 2e-14; no negative weight below −2e-14. At reference centers,
  nonselected range weight below 1e-12 in Float64. Nonadjacent range influence is zero.
- Weight changes across a center/wrap at ±1e-7 radians remain below 1e-10. Check dense
  circular sweeps and finite differences of the C1 weights; finite values alone are
  insufficient.
- Hue/saturation-only mixer and chroma-only grade preserve linear Y within
  `2e-12*max(1,max(abs(outputRGB)))` in Float64. Explicit luminance gain agrees to that
  same conditioned bound; image color-channel agreement remains the independent gate.
- For meaningful positive L/chroma, mixer chroma/relative-lightness and hue follow the
  documented rotation/gain to 1e-10 relative and 1e-9 radians. Near zero, use absolute
  RGB bounds rather than dividing an undefined hue or zero luminance.
- Cover both primaries, exact neutrals/black, signed channels, mixed-sign/zero Y,
  1e-12…16× exposure, reference hues, all arc boundaries, single-range/overlapping
  extremes, tone transitions, both balance endpoints and every blend endpoint.
- Compare independent photographic crops/ramps including skin, foliage, blue/purple
  lights, near-neutral highlights and noisy shadows before acceptance. Match HDR/SDR,
  preview/export, alpha, CPU fallback, history/MCP/migration and retained-source behavior.
  Source-matched latency/presentation/resource gates remain separate; defer heavy RAW,
  full-size GPU and foreground measurements while the user is playing.

## Implemented arithmetic and focused evidence

[The scalar core](../../src/shared/creative-color.ts) compiles bounded settings once
and evaluates mixer, intensity and grading with one Lab reconstruction. The standalone
operators remain available for stage-reference comparisons. When the new controls have
no influence, the old intensity function runs directly and retains its exact result.
Both working primaries share the same declared color semantics.

The [Decimal80 generator](../../scripts/research/creative-color-reference.py) imports
no application processing code. It independently solves primary matrices, finds hue
intervals by angle, solves chord coordinates, and reconstructs complete XYZ/RGB.
[The CC0 fixture](../../tests/fixtures/creative-color-reference.json) contains 2,520
binary64-input and 2,520 Float32-input cases with every stage result, input selection,
tone weights and generator hashes. Float32 rounding precedes reference evaluation;
input quantization is not charged to kernel error.

The [WebGPU core](../../src/shared/creative-color-precision-wgsl.ts) uses compensated
two-component arithmetic for active creative controls. Plain Float32 arithmetic
exceeded the unchanged color limit on signed HDR cases; the failed experimental
receipts remain under
[8562169](../../artifacts/verification/playwright-1793028562169-e952c162-4398-4861-8975-94c7235dbf70/playwright/summary.json),
[8640602](../../artifacts/verification/playwright-1793028640602-37f3aa5c-c4e0-4cfe-b30c-4b38373f72cf/playwright/summary.json),
[8708080](../../artifacts/verification/playwright-1793028708080-4ccacff7-690e-48b2-914f-dd180d46d038/playwright/summary.json)
and [8748299](../../artifacts/verification/playwright-1793028748299-78cf5070-ff2c-41d1-8101-59f6fe422ebd/playwright/summary.json).
The final port retains the original tolerance. Shader parameters occupy 416 bytes per
configuration, including high/low components; the core needs no extra image plane.
It is installed in the active creative preview/export point pass. Inactive controls
retain the preceding shader source and omit the added storage binding.

[The WebGL port](../../src/shared/creative-color-glsl.ts) translates only the explicitly
typed pure color functions from that same core. Backend arithmetic and old-intensity
adapters remain explicit. A reserved positive-zero uniform word forces Float32 rounding
through a bitwise operation; logarithm normalization uses GLSL ES 3.00 bit operations.
The independently tested old SDR intensity shader remains unchanged by default.
The initial hidden WebGL failures at exact green anchors are retained under
[9851720](../../artifacts/verification/playwright-1793029851720-ce0d3c67-a3e4-4e04-80ff-ca787999c0d0/playwright/summary.json)
and [9942098](../../artifacts/verification/playwright-1793029942098-7549913f-671c-417e-a155-a5ddc50b325e/playwright/summary.json).
Sharing cross-product results closed the interval gap without changing the mathematical
weights or acceptance limits. The earlier passing decomposition-based rounding shader
took 40.52 seconds for the complete hidden test; the bounded rounding-word version
took 3.53 seconds in its first successful probe. Those invocation times include shader
compilation and harness work, not full-image processing or presentation measurements.

[The native Float64 header](../../native/irodori-cpu-render/creative-color.h) passes the
same independent references through an actual compiled
[bounded numerical probe](../../scripts/research/creative-color-native.cpp).
Its neutral path delegates to the caller's existing intensity operator. This verifies
native arithmetic independently of the shipping helper. The version 3 helper integration
below adds immutable serialization, C ABI validation and build provenance; it does not
establish complete photographic/application acceptance or enable controls.

The arithmetic [focused invocation](../../artifacts/verification/2026-10-26T16-00-47.366Z-check-GZxkJX/summary.md)
selected `creative-color`, `creative-color-gpu`, `creative-color-native` and
`creative-color-webgl`, plus required static/fast checks: **728 passed, 0 failed/skipped,
45.22 seconds**. Scalar/native cover all 5,040 vectors; WebGPU and actual hidden
Electron WebGL each cover all 2,520 Float32-input vectors. Both primaries retain fixed
color/selection limits, neutral bypass and unchanged alpha in the numerical harness.
The native probe compiles without fast math or floating-point contraction. WebGL
reports the workstation's AMD/ANGLE backend. No full-size image, RAW decode,
foreground run, benchmark or comprehensive checkpoint was added.

The Node stage took 18.31 seconds, above its 15-second aim; all assertions remain.
The initial combined invocation stopped at a new-test formatting issue, retained in
[Hon0x0](../../artifacts/verification/2026-10-26T15-57-32.190Z-check-Hon0x0/summary.md).
The failed formatting stage passed before the final selected invocation.

## CPU adapters and native transport preparation

The [CPU adapter target](../../tests/creative-color-adapters.spec.ts) checks all 1,260
Rec.2020 Float32-input references through `adjustHdr`, and more than 900 nonnegative
sRGB references through raster export and SDR preview conversion. It verifies the
existing raster input/output clamps, alpha, working HDR histogram counts and matching
prepared settings. Frame/band callers prepare controls outside their pixel loops;
single-pixel inspection can prepare its own snapshot. Equality includes persisted
powerless Hue/Blending/Balance controls while treating absent groups as neutral.

Internal `AdjustmentParameters` now accepts optional prototype groups. The current
edit API still rejects them, and settings 9 validation refuses histories carrying
undeclared operators. No public edit, history migration or UI control is enabled by
these adapter changes. Complete versioned persistence and application wiring must
replace that guard before any saved edit can use the new groups.

[Canonical compiled values](../../src/shared/creative-color.ts) provide one 52-component
Float64 logical packet for native transport and GPU high/low packing. The
[C ABI structure](../../native/irodori-cpu-render/creative-color-params.h) owns 368 fixed
bytes with integer activity flags and no heap allocations. Native packet validation
checks finite/bounded controls, unit rotations, tone strength, matching activity and
positive-zero padding. Fourteen malformed packet probes fail before pixel output.
The shipping helper now consumes this packet through the version 3 transport below.

The latest [combined focused receipt](../../artifacts/verification/2026-10-26T16-31-52.115Z-check-HME1fd/summary.md)
selects the five `creative-color*` targets, `color-export`, `crop-export` and
`catalog-migration`, plus static/fast checks: **751 passed, 0 failed/skipped,
49.65 seconds**. The Node stage took 19.65 seconds, above its 15-second aim. Existing
color/export and transactional crop/history migration regressions pass with the
prototype CPU adapters. This remains small synthetic and hidden Linux evidence.

For GPU application integration, retain the existing shader/pipeline path when the
new operators are inactive. Prepare the larger creative kernel only when required;
the measured shader compilation cost must not be added to ordinary uncorrected
preview startup. Account for parameter buffers and retiring owners, keep the source
resident across color gestures, and preserve the existing 15% uncorrected-preview gate.
Full-size computation/presentation measurements remain deferred, not passed.

## GPU and presenter integration

The [GPU export adapter](../../src/main/export/gpu.ts) snapshots controls and white
balance before its first await, prepares the active creative program only when needed,
and includes its 416-byte storage buffer in admission/cleanup. Independent references
cover all 1,260 Rec.2020 cases composed with the independent SDR/HDR CTL, alpha and
packed/deferred export. Neutral controls preserve existing bytes and peak ownership.

The [HDR pipeline cache](../../src/renderer/src/preview/hdr-pipelines.ts) prepares the
creative variant lazily, reusing the base mip, presentation and blit programs. Both
interactive policies and the canonical tile program pass all 1,260 independent cases,
including Before pixels and alpha, from one resident synthetic source. The live
presenter uses separate preview/histogram color buffers so overlapping requests retain
their own settings. New buffer reservations participate in existing admission and
fence-based retirement. First-surface rendering also freezes and charges its packet;
program proof hashes distinguish creative and base kernels. Numeric first-surface
checks use the original Float32 limit before presentation and separately account for
binary16 format conversion. WGSL permits either adjacent binary16 value; the initial
new test incorrectly assumed nearest rounding. Its two failed receipts are retained
under [6788728](../../artifacts/verification/playwright-1793036788728-28eec33d-46cb-4782-ae4b-99fb40cb8be2/playwright/summary.json)
and [6839745](../../artifacts/verification/playwright-1793036839745-cc10bdcb-2fb6-4279-be1c-a8142a44da9a/playwright/summary.json).
The Float32 color limit remains unchanged.

The actual [SDR presenter](../../src/renderer/src/preview/presenter.ts) also compiles
creative GLSL only on demand. With `KHR_parallel_shader_compile`, completion polling
keeps the previous canvas extent/pixels until the latest captured edit can render.
Failure signals the existing CPU replacement; disposal cancels pending publication.
The isolated hidden test exercises real WebGL pixels, one source upload across edits,
Before/Split comparison, delayed replacement, failed/disposed preparation and the
actual CPU worker. It supplies the same neutral proof bitmap that the application
provides. File-based isolated workers preserve the application's CSP; earlier Blob
worker/setup failures remain retained. CPU requests clone nested settings before
worker dispatch. Gesture snapshots freeze nested groups; first-surface/completed-frame
identities include every authored control, including powerless Hue.

The [focused frame receipt](../../artifacts/verification/2026-10-27T14-51-42.032Z-check-tIonsa/summary.md)
selects `creative-color-frame-identity`, `creative-color-frame-gpu`,
`creative-color-presenter`, `creative-color-export`, `creative-color-gpu`,
`creative-color-webgl` and `hdr-first-surface-service`, plus static/fast checks:
**759 passed, 0 failed/skipped, 57.43 seconds**. All five captured base adjustment,
cache and export shader hashes remain identical; this is structural evidence, not
the 15% performance gate. The Node stage took 18.37 seconds, above its 15-second aim.

## Shipping native helper integration

`IRODCPU3` appends the 52-f64 color packet at offset 416, giving an 832-byte request.
The existing HDR range-analysis mode uses `MASKCPU3`, appending it at offset 432 for
848 bytes. Earlier offsets, including mask Saturation/Vibrance at 416/424, remain
unchanged. Header echoes cover every packet byte. Internal preview/mask API versions
advance to 3; this is the existing diagnostic mask, not local editing/masking.

Rust decodes exact spans and requires packet intensity to match the existing request
fields. The C++ validator checks bounds, activity, rotation, tone strength and padding
once before image allocation/output. C++/Rust assert the 368-byte creative and 520-byte
complete ABI sizes. The existing point pass applies fused color; inactive operators
call the old intensity function exactly. Constant metadata fits the existing bounded
native/transport allowances; no additional image plane is introduced.

The [offline build](../../artifacts/native-cpu-render-build/build-qffxct/build-manifest.json)
used one Cargo job. Both creative headers and the Rust validator join source/watch
inventories and the canonical version 3 Electron LLVM arithmetic receipt. The staged
binary SHA-256 is `03b7a96b410909c10151476fad3e26bf15c0f44f99a5cc0bfbce487428ccfada`;
the arithmetic SHA-256 is `96cca98ffd40fdf1e41ca57b182ebfee19ae38ad6b35bb08fd975d10fdcf5a6c`.
Staging and startup validate these new provenance fields; missing hashes fail even
when a malformed receipt has a matching canonical hash.

The [native frame target](../../tests/creative-color-native-frame.spec.ts) passes all
1,260 independent Rec.2020 references through the actual application controller and
shipping helper, with independent CTL display conversion, exact alpha, immutable
requests and one retained source lease across edits. Reset drains that lease. Range
analysis includes the confirmed grade across all domains. Sixteen malformed/obsolete
request probes fail before stdout. Existing source-removal, pipe, child-close,
cancellation, capability, preview-file lifecycle and fixed-budget regressions pass.

The [focused native receipt](../../artifacts/verification/2026-10-27T15-11-26.496Z-check-jO1Wrs/summary.md)
selects `creative-color-native-frame`, `native-cpu-controller`,
`native-hdr-mask-controller`, `native-hdr-mask-capability` and `full-previews`, plus
static/fast checks: **791 passed, 0 failed/skipped, 44.69 seconds**. The Node stage took
16.58 seconds, above its 15-second aim. The earlier frame/native counts overlap and must not be summed as
distinct coverage. A sandbox child-process `EPERM` stalled preliminary reference
runs; the successful native invocation ran outside that restriction, with the same
assertions. The first completed native run also exposed an incorrect new test
expectation: ordinary CPU owners deliberately retain the source until explicit reset.
The corrected test checks both retention and final release. Failed/interrupted evidence
remains retained; no numerical tolerance, ownership fence or native timeout was relaxed.

At that adapter checkpoint, history/UI/MCP adoption, the legacy AHD SDR proof and
explicit parameter forwarding remained unfinished. The following adoption closes
those implementation gaps. Full real-photo HDR application lifecycle,
RAW/gain-map/merge, native keyboard/visual and source-matched performance gates
remain required. No foreground, RAW decode, full-size GPU or comprehensive checkpoint
was added.

After the native runtime rebuild, the same two actual hidden SDR presenter cases
passed again in [4.75 seconds](../../artifacts/verification/playwright-1793114140326-d8388b29-15a9-404a-86e8-ec976db48800/playwright/summary.json),
with isolated profiles and the rebuilt application's startup/capability path.

## Versioned application adoption: 2026-10-27

Settings 10/catalog 20 add full version-1 mixer/grading groups. Startup preflight
validates all current, undo and redo snapshots before permitting recovery writes.
Catalogs 17/18/19 migrate transactionally, preserving crop geometry, revisions,
cursor, redo, timestamps, originals and durable masters. Older settings reject
undeclared creative data; malformed current groups reject before any migration.
The dedicated catalog writer also validates complete groups on commit.

`irodori_update_edits` accepts partial range/tone changes, merges into complete owned
groups and commits one shared history entry. No-ops retain redo; stale no-ops still
conflict. `irodori_get_edit_capabilities` and the typed preload API expose algorithm
versions, range definitions, stage order, authored units and bounds from the shared
control contract. Settings carry no filesystem paths. Disposable rendering identities
advance for the newly enabled graph; neutral processing preserves preceding pixels.

The inspector uses shared disclosures and `AdjustmentInput`. Range and tonal-region
selection persist in workspace state and do not alter photo history. The grading
wheel edits the same hue/saturation as numeric controls: Left/Right change hue,
Up/Down saturation, Shift uses larger steps, Home/End select zero/full saturation,
and Escape cancels. Repeated keys or captured pointer movement commit on release;
cancellation releases capture. Section resets preserve other adjustment groups.

`snapshotAdjustments` now forwards the entire nested graph through confirmed,
temporary and worker requests without leaking geometry/history. The legacy AHD SDR
proof lazily prepares only its creative display pipeline; reconstruction and the
neutral display shader remain unchanged. One small 416-byte packet is charged to
existing resource budgets. Independent tiny CFA/native-kernel proof checks pass;
this evidence does not decode or accept a real RAW photograph.

The [persistence receipt](../../artifacts/verification/2026-10-27T15-44-38.355Z-check-ghcGFQ/summary.md)
has **770 passed, zero failed/skipped, 44.16 seconds**. It selects creative edits,
history/migration, snapshot/equality and workspace targets with static/fast checks.
The Node stage takes 19.45 seconds, above its 15-second aim; assertions are unchanged.
Small-PNG application checks cover mixed UI/MCP edits, external revision replacement,
reset, Undo/Redo, restart and retained source bytes. The CPU worker workflow compares
independent palette references, histograms and frozen JPEG export, reuses one decoded
source across grades and verifies restoration after restart.

The [inspector/tiny AHD proof receipt](../../artifacts/verification/2026-10-27T16-07-05.151Z-check-Fc2y2W/summary.md)
selects `inspector-ui` and `creative-color-raw-proof`: **746 passed, zero
failed/skipped, 75.94 seconds**, including static/fast checks. The 35.85-second
Electron stage covers all disclosures, pinned minimum-size layout, pending edits,
photo changes and crash/normal recovery; the 1.88-second GPU stage uses tiny synthetic
CFA buffers without RAW decoding. Routine verification exceeds 60 seconds, and Node
takes 18.48 seconds against its 15-second aim; no assertions were cut short.
Earlier light-control wiring and mixed toolbar history cases pass in the retained
[broader run](../../artifacts/verification/2026-10-27T16-02-02.793Z-check-OEoxPG/summary.md),
whose older inspector expectation failed before it was extended to the new sections.
That run is not a fully passing receipt. Both new mixed UI/MCP and wheel cases pass
there; the complete [adoption ledger](../../artifacts/creative-color-application-adoption/summary.md)
also retains their isolated reruns and all failed setup evidence. Counts overlap.

The [small CPU raster workflow](../../artifacts/verification/playwright-1793116298376-635f1b78-73ec-4233-9b89-faaaed946094/playwright/summary.json)
passes in 6.49 seconds. The subsequent registered invocation adds an explicit nonempty
source SHA assertion; its raster stage passes, though missing native-test setup
prevents that invocation from passing overall. The
[explicit-helper native rerun](../../artifacts/verification/playwright-1793116891004-69d2358f-bd81-4671-bd8d-d4c6e227a60a/playwright/summary.json)
passes all three real-helper cases in 3.85 seconds. Its independent numerical,
request identity, retained-source, malformed-packet and no-output assertions are unchanged.

The source-matched native build is refreshed offline with one Cargo job at
[build-8YCN7o](../../artifacts/native-cpu-render-build/build-8YCN7o/build-manifest.json).
Its binary and mask arithmetic hashes equal the preceding build; TypeScript
provenance records the adopted graph. A build alone does not establish acceptance.
Failed format/stability checks remain in ignored verification artifacts. The wheel
test uses direct DOM scrolling after a hidden Wayland resize, with explicit native
content-size bounds; compositor-visible visual/input and performance gates remain
deferred while the user is playing.

## Primary sources and provenance

- [W3C CSS Color 4, 22 October 2026](https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code):
  source conversion mathematics and chromaticities. CSS Lab is D50; Irodori explicitly
  retains its established D65 reference and does not insert a D50 adaptation.
- [Adobe Color Mixer](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/color-mixer.html):
  workflow inspiration for range Hue/Saturation/Luminance; reviewed 2026-10-25.
- [Adobe tonal/color workflow](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/image-tone-color.html):
  shadow/midtone/highlight controls and blending/balance semantics; reviewed 2026-10-25.
  No Adobe processing algorithm or asset is copied.
- [Existing intensity decision](professional-editing-processing.md#implemented-saturationvibrance-decision)
  and [independent primary solver](../../scripts/research/color-reference.py).
- [Khronos GLSL ES 3.00 specification](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf):
  explicitly sized array arguments/returns and high-precision float/integer bit conversion;
  reviewed 2026-10-26. The original Irodori shader port copies no specification program code.
- [Khronos parallel shader compilation](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/):
  completion polling and delayed link-status checks; reviewed 2026-10-26.
- [WGSL floating-point conversion](https://www.w3.org/TR/WGSL/#floating-point-conversion):
  adjacent representable values and binary16 conversion; reviewed 2026-10-26.
