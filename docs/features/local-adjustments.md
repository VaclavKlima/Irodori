# Local adjustments

## Status

**Implemented for #56 with focused macOS acceptance, November 7, 2026.** The first delivery establishes multiple independent brush masks, real processing order and six local Light controls. The subsequent [linear/radial gradients](mask-gradients.md) are scoped to GitHub #84. Automatic subjects (#54), sky/background/object selection (#66), range masks (#67), and optional depth research (#65) remain separate. The subsequent [masked Color implementation](#masked-color--issue-64) extends this core for [GitHub #64](https://github.com/VaclavKlima/Irodori/issues/64). [Shared requirements](README.md#shared-implementation-requirements) apply.

The [November 8 object-selection extension](object-selection.md) enables SAM 2 point/box proposals on Mac, with immutable generated R8 bases underneath separate Paint/Erase corrections. Settings 14/catalog 24 preserve the delivered brush history while adding these references and shared GPU coverage. Bazzite verification is [TODO 69](README.md#task-69); fine-edge matting, automatic sky/background and additional local operators remain separate. The [research record](object-selection-research.md) retains original measurements and known quality failures.

The subsequent [whole-mask edge implementation](mask-edges.md) adds settings
15/catalog 25 with neutral Feather and Expand/Contract modifiers. Focused Mac
integration checks pass; their exact scope is recorded in the edge brief,
separately from the earlier brush/selection passes below. Image-guided matting and
recovered fine hair/fur/feather coverage remain separate research.

## Masked Color — issue #64

Each mask has a separate Color group below Light in **Masks → Adjustments**.
Color starts collapsed and retains its disclosure choice while the workspace is
mounted. Local Temperature, Tint and Saturation use integer relative units from
−100 to +100, with zero neutral. Positive Temperature warms; positive Tint adds
magenta. Temperature is not Kelvin, an illuminant measurement or a replacement
for camera-aware global white balance. Reset mask Color resets all three values
in one photo-wide history action; Light and coverage remain independently owned.

The common GLSL/WGSL point stage applies **relative balance → local Light → local
Saturation → one coverage blend**, in the existing bottom-to-top mask order after
global point edits and before tone mapping/output conversion. Each neutral
operator bypasses exactly, including the authored Light substage's nonnegative
domain conversion. Color-only masks therefore retain signed working channels.
Saturation reuses the existing CIE Lab/D65 operator with Vibrance zero, preserving
its hue/luminance semantics. Balance can change colored-pixel luminance.

Relative balance is frozen as `relative-d65-bradford-half-mired-ucs-lab-v1`.
For Temperature `t`, the internal locus coordinate is
`K = 1e6 / (1e6 / 6500 + 0.5 * t)`. In CIE 1960 uv, the target is
`uv(D65) + locusUv(K) - locusUv(6500) - whiteBalanceNormal(K) * tint * 0.0001`.
The normal is the existing Kang-2002 locus normal toward green; subtraction makes
positive Tint magenta. Anchoring the relative locus displacement to actual D65
avoids a neutral daylight/black-body offset. A bounded CPU coefficient operation
prepares linear Bradford D65-to-target matrices in linear sRGB and Rec.2020;
all image samples execute through the existing GPU owners. This creative relative
transform does not infer the photographed illuminant or alter camera gains.

RAW and merge sources apply the operators in scene-linear Rec.2020. Raster
sources use their authored linear sRGB domain. Authored HDR and its independent
SDR primary apply the same frozen mask settings in their respective primaries,
retaining each rendition's white normalization and existing output handling.
Balance adds no clipping, gamut mapping or alpha change. Local gestures reuse the
prepared source rather than decoding RAW again. Pixel identities include Color
and its operator version, while prepared coverage remains independent of Color.
GPU/resource/nonfinite failures remain explicit and never restart equivalent CPU
pixel processing. Mask-aware histograms include Color; exact masked clipping and
full HDR statistics retain their separate availability limits.

Settings 16/catalog 26 add neutral `color: { temperature, tint, saturation }` to
all existing masks in current settings and every history snapshot, preserving
settings-15 Feather/Expand values, IDs, immutable assets, revisions, cursors,
branches and timestamps. Typed UI/API/MCP mutations accept partial Color groups;
duplication and object refinement retain Color. Accepted older preset and frozen
application settings remain readable. Global presets and copy/paste preserve the
destination masks rather than transferring spatial masks between photographs.

The user selected a stationary warm-colored pot beside foliage instead of a
handheld human-skin capture, to avoid holding a hand in place during remote
operation. Existing anonymous skin and the bird/water/reflected-leg fixtures
qualify their own photographic cases separately. The attempted new pot capture
returned no original and remains uncertain; no automatic shutter retry was made,
and camera settings were restored. The first plant-only private-room frame stays
outside Git and acceptance. Same-frame skin/foliage and new pot/foliage evidence
therefore remain unverified and are owned by
[combined-scene photographic follow-up #96](https://github.com/VaclavKlima/Irodori/issues/96).

Focused Bazzite acceptance reconciles **1059 distinct passing cases** (991 Node,
36 service, 17 Electron and 15 RAW/GPU) across the selected targets and exact
corrective reruns. The [bounded summary](../../artifacts/mask-color/2026-11-10-acceptance/summary.md)
and [details](../../artifacts/mask-color/2026-11-10-acceptance/details.md) preserve
original failed receipts, current passing cases and reuse provenance; this is not
one comprehensive checkpoint or performance benchmark. Selected latest case
runtimes total 187.825 s, which is not a single-run workflow time.

The RX 7900 XTX / Navi31 passes WGSL/GLSL references, overflow/histogram recovery,
manual/MCP edits, migration/history/restart, real source frozen output, native
keyboard and 1100 × 700 Console-open layout. The common GPU tests use 50
independent Decimal80 coefficient matrices and 351 pipeline reference vectors,
retaining existing tolerances. Fit and native bird/skin comparisons show no new
ringing or color halos in those bounded authored-SDR examples. Manual masks have
a protection margin and do not qualify automatic selection or physical alpha.

Four focused WGSL/reference/export cases also pass on Radeon 610M / RADV
RAPHAEL_MENDOCINO, Mesa 26.2.6. Actual adapter receipts identify the executing
hardware; both attempted Mesa GL selectors still produced a Navi31 WebGL
context. Integrated-GPU WebGL presentation, macOS, Windows, live signed-in
Console and physical true-HDR appearance/luminance remain unverified, with
[other-device follow-up #95](https://github.com/VaclavKlima/Irodori/issues/95).

The renderer integration checks exposed implicit low-precision photograph
samplers in the GLSL presenter. Photograph and Before samplers now explicitly
request high precision, including the comparison shader's replacement anchor.
The [ESSL 3.00 specification](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf)
sections 4.5.4 and 8 define the default sampler precision and texture return
precision. Correct Float32 input/coefficient uploads were recorded before the
fix; all four original overflow/histogram cases pass without changing their
assertions or numeric gates. Existing ACES and global color algorithms are
unchanged. Diagnostic text identifies Local adjustment failures so Color errors
are not incorrectly attributed only to Light.

The recorded checks qualify the bounded current-device implementation. Remaining
combined-scene photographic acceptance is owned by
[follow-up #96](https://github.com/VaclavKlima/Irodori/issues/96); other-device
verification is owned by #95. GitHub records publication and completion separately
from these retained acceptance limits.

Camera captures and downloaded fixtures undergo full image/embedded-preview/metadata
review and retain original bytes, hashes and permission/credit notices. Fixture
intake alone does not establish a photographic quality pass or true HDR visual
acceptance. Texture, Clarity, local Vibrance/mixer/grading and masked clipping
remain separately scoped.

## Goal

Apply local light and color corrections nondestructively, using the same HDR-compatible operators and history as global edits.

## User workflow

Open **Masks → Create mask → Brush** for an empty mask, or choose **Select object…** for an explicit object-selection proposal. Brush creation opens **Coverage** with Paint active; accepting an object proposal opens **Adjustments**. Select a named row to edit that mask. Use the row's **⋯** menu to rename, duplicate, invert, move up/down or delete, and use its visibility toggle to enable or disable it. Dragging also reorders masks. The **top mask applies last**: overlapping tonal changes may change appearance when reordered. New masks begin empty, enabled and neutral, at the top of the list. A duplicate has an independent identity and initially shares immutable geometry with its source.

Each completed stroke, parameter gesture, reorder or management action is one photo-wide Undo step. Coverage visibility, selected mask, detail tab and brush preferences belong to workspace recovery rather than photo history. Older mask-workspace checkpoints retain their stored selection and brush preferences and default the new detail tab to Adjustments. Cancel unfinished strokes/reorders on Escape, lost capture, application blur, source revision changes, photo navigation or tool switching. Flush valid numeric drafts before mask navigation. Preserve middle-button panning and keep crop/picker/brush tools mutually exclusive.

## Controls

Use one **Create mask** command menu rather than adding a header button for every mask type. The renderer-owned tool registry offers Brush, Select object, Linear gradient and Radial gradient; future automatic selections and ranges join the same menu. Unimplemented tools are hidden. Temporarily blocked tools retain a readable reason.

The mask list shows each name, type/status, visibility toggle, drag handle and **⋯** menu. Names use 12px text and metadata 11px; long names retain accessible full text. The list is bounded to two visible rows at content heights of 760px or less and four above that, with its own scrolling. Header controls and detail tabs remain visible while the selected-mask details scroll independently. **Show overlay** is available above both tabs.

**Coverage** contains the selected mask's object-refinement action and Paint/Erase tools. Brush size and feather appear while Paint or Erase is active and remain fixed for a stroke; pressure/flow accumulation is deferred. Object guides, processing, errors and proposals remain inside Coverage until explicit Use mask or Cancel selection. **Adjustments** groups the six local tonal controls in Light and the three local color controls in Color disclosures; later implemented operators use the same group structure. Hidden tab/disclosure bodies remain mounted. Numeric adjustments use `AdjustmentInput`.

**Coverage → Mask edges** shapes the completed selected coverage, including
Paint/Erase and inversion. Feather is 0–64 canonical native pixels in 0.5-pixel
steps; Expand/Contract is −16…+16 integer pixels, with positive values growing
the visible selected area even when inverted. Reset restores both values to zero
in one history step. These modifiers preserve source base/stroke content while
reshaping its combined result. Exact coverage prepares on commit; edge-enabled
brush gestures retain cursor/path feedback until stroke completion. The
[edge contract](mask-edges.md) defines loading, errors, units and ownership.

Creation and per-mask actions share the photo menu's reusable command-menu behavior: keyboard navigation/typeahead, window-bounded placement, Escape/focus restoration and outside dismissal. Actions retain their invoked photo/mask targets and revalidate before execution. Keyboard brush control belongs to the focused photograph, leaving forms, photo navigation and Console shortcuts independent. The minimum 1100 × 700 Console-open layout must keep every editing group reachable.

## Processing approach

Store brush polylines in normalized, oriented, uncorrected native source coordinates. Radius is relative to the canonical short edge. Use the existing crop affine and RAW green-channel distortion mapping, including lens crop and decoder flip, to pull each displayed/output pixel into that grid. Lateral chromatic correction does not create separate mask geometry for RGB. Raster/HDR-JPEG use the once-oriented decoded grid; merges use their immutable published master grid. Geometry metadata is path-free and prepared with the working image, rather than inferred from provisional catalog dimensions.

Evaluate fixed-radius polyline distance with smoothstep feathering, independently of event rate and zoom. Paint combines coverage with `max`; Erase multiplies existing coverage by `1 - strokeCoverage`. Apply inversion after the complete stroke sequence. Preserve zero and full coverage exactly. GPU geometry candidate indexing bounds work to relevant image regions; TypeScript owns validation, indexing and orchestration rather than per-pixel processing.

Evaluate enabled masks bottom-to-top, after the existing global point adjustments and before output/display conversion. Each mask applies its relative balance, six Light operators and local Saturation to the previous result, in that order, then blends `previous + coverage * (local - previous)`. Do not repeat global white balance, curves or creative color. Retain existing scene-linear Rec.2020 versus authored-image semantics and alpha. Apply the same frozen geometry/order independently to authored HDR and its SDR primary. A geometry or local-control edit must not decode RAW again.

Use shared GPU numeric modules in the existing GLSL/WGSL frontends and native point renderer on both platforms. Include geometry/index buffers in admission, retain cancellation and explicit GPU retry, and never restart equivalent CPU image work on failure. Analysis that cannot include active local edits reports an explicit unavailable reason rather than pre-mask values.

Active Mask edges use one common native Dawn preparation stage after base,
ordered brush and inversion composition. Existing consumers sample its prepared
native R8 coverage without repeating those operations. Zero/zero bypasses that
stage. Canonical full-source borders replicate independently of crop and screen
view, and preparation retains strip halos. Derived coverage is disposable,
revision/source validated and excluded from durable mask content.

## API/MCP implications

Expose capabilities, current masks and typed atomic create/update/duplicate/delete/reorder/stroke operations through the existing photo service. Every mutation identifies a photo, expected photo revision and mask IDs. UI and MCP use the same service; geometry never exposes file paths or shader code. Limits are policy defaults: 32 masks, 4096 points per stroke, 65536 active points per photo, 256 KiB per mutation and 32 MiB retained geometry per photo, additionally bounded by managed image budgets. Refuse excessive work before publishing a changed history.

## Persistence

Settings 13/catalog 23 add a top-first `maskStack` of lightweight descriptors. Immutable content-addressed stroke chunks live in SQLite, outside preview caches; commit new content and history atomically. Duplicates share geometry until further editing. Initially retain content append-only within the declared budget, protecting current/undo/redo and accepted jobs without unsafe eager cleanup.

Settings 14/catalog 24 subsequently add generated bases, and settings 15/catalog
25 add `edge: { featherPx, shiftPx }` with neutral defaults to every existing mask
and historical snapshot. Preserve mask IDs, immutable content, history branches,
revisions, cursors and timestamps. The edge implementation and focused Mac
acceptance are tracked in the [edge brief](mask-edges.md).

Migrate all legacy current/history settings to empty mask stacks while retaining existing curves, revisions, cursors, branches and timestamps. Handle independent preset definitions and legacy frozen job formats explicitly. Cross-photo mask copy/preset inclusion is deferred; applying global presets or Copy/Paste preserves destination masks. Pixel identities include effective geometry, enabled/invert state, parameters, order and algorithm versions; names and workspace selection do not affect pixels.

## Dependencies

Requires [HDR processing](hdr-processing.md), coordinate contracts, and implemented global operators including [vibrance/saturation](vibrance-saturation.md) for local color intensity. [Tone mapping](tone-mapping.md) follows the local stage. Future geometry changes must preserve mask placement; automatic masking is separate.

## Failure handling

Bound stroke count and tile memory; report complexity limits before accepting an unrenderable edit. Cancel interrupted gestures without orphaning durable mask data. Missing historical mask content is an explicit render error. Resolve concurrent edits through expected revisions, not silent mask replacement.

## Acceptance criteria

- Zero coverage and neutral local settings preserve baseline output; full coverage equals the corresponding global operator at the defined stage.
- Synthetic brush/gradient references verify feather falloff, inversion, add/subtract, overlap, and tile seams within fixed tolerances.
- Masks remain registered after zoom, pan, orientation, lens toggles, and merge crop; test edges at Fit and 100%.
- Multiple masks, Undo/Redo, redo branching, restart, migration, deletion, cancellation, and missing-content recovery retain valid durable references.
- Keyboard-only creation/refinement and UI/MCP equivalence pass; enforce memory bounds and measure interaction latency separately for complex masks.

## References

- [Geometry conventions](../raw-processing.md), [preview geometry](../../src/renderer/src/preview/geometry.ts), and [input design](../input-design.md).
- [HDR processing and allocation policy](hdr-processing.md).

## Focused acceptance — November 7, 2026

Local scope: macOS arm64 on Apple M4 Pro, host Node 24.8.0, the accepted bundled
processing workers, isolated libraries and the shared hidden launcher. The
foreground case alone used a visible temporary application window. This is
feature acceptance rather than a comprehensive platform/performance checkpoint.

The affected selection and corrective runs retain **989 distinct passing cases**,
including **24 masking-specific cases**. Another 36 platform-specific RAW/native
controller cases were skipped. Passed evidence is reused; original failed runs
remain failed in their own receipts.

| Evidence                                                                                                                                                                                                               | Result and limits                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Affected selection](../../artifacts/verification/2026-11-07T21-00-51.623Z-check-VtqZHv/summary.md)                                                                                                                    | 979 passes in 75.06 s; model, source coordinates, immutable storage, migration, workspace recovery and actual MCP transport pass. Two UI failures were subsequently corrected, as below. This original receipt is not a complete pass.                                                                                                                         |
| [Mask management](../../artifacts/verification/2026-11-07T21-04-29.728Z-check-Voxw2a/summary.md) and [exact drag/history/restart rerun](../../artifacts/verification/2026-11-07T21-10-27.501Z-check-LTAs0u/summary.md) | Both UI cases pass in their final applicable runs. Pointer-captured reordering uses frozen row centers, previews without history and commits once on release; keyboard strokes, cancellation, independent masks, Undo/Redo and restart pass.                                                                                                                   |
| [Native GPU and real sources](../../artifacts/verification/2026-11-07T21-11-11.315Z-check-3PYJ6Y/summary.md)                                                                                                           | Seven passes in 18.47 s: independent signed/HDR coverage and six-Light references, strip offsets, numerical overflow refusal, actual Sony RAW presentation, real RAW/raster/authored-HDR/v4-merge proof/export agreement and Before/history restoration.                                                                                                       |
| [Native input/minimum layout](../../artifacts/verification/2026-11-07T21-13-33.940Z-check-i5VnKE/summary.md)                                                                                                           | One pass in 3.31 s with 1100 × 700 content and Console open. Electron native keyboard/pointer routing, focus, capture cleanup, one-stroke history and independent panel geometry pass. Physical input devices are not certified.                                                                                                                               |
| [Gentle photographic review](../../artifacts/verification/2026-11-07T21-17-08.301Z-check-DUR4xY/summary.md)                                                                                                            | Exact forest proof/export case passes in 2.84 s after choosing Exposure +0.35 EV, Shadows +5, brush diameter 3% of the canonical short edge and feather 85%. Native before/after crops show a gentle trunk lift with no outward halo; independent lower-right darkening and sampled unmasked pixels remain consistent. Proofs/crops stay in ignored artifacts. |

The unadopted HDR first-surface optimization explicitly declines active local
masks; settled GPU presentation reuses the prepared source. The initial delivery
reported masked histograms unavailable; the follow-up below replaces that
limitation with mask-aware GPU histograms. Exact clipping overlays and full HDR
statistics/pixel analysis still report unavailable instead of unmasked results.

Bazzite/Windows acceptance, physical HDR luminance, sustained masking performance,
cross-photo mask transfer, advanced brush dynamics and automatic/range/gradient
mask types remain unverified or planned. No algorithms, numeric gates or resize
policy were weakened. The automatic cheap checks also exposed unchanged
development-launcher timeouts under the bundled Node 24.20 runner; the same
launcher cases pass under the supported host Node 24.8 runtime. The receipts
retain that runtime distinction.

## Mask-aware histogram follow-up — November 7, 2026

An open-app report reproduced **Histogram unavailable** with an enabled mask at
Exposure +1.83 EV and a healthy WebGPU HDR preview. The initial masking delivery
had deliberately disabled analysis that could not apply local edits.

The existing HDR GPU histogram now applies the same ordered masks and canonical
crop/lens mapping as presentation before converting to HDR content. Raster
histograms use the existing GLSL point program, sampled over the complete native
photograph, with a bounded asynchronous readback and byte-bin aggregation. Both
retain the established 65536-sample bound and remain independent of pan/zoom.
Each queued histogram owns its input snapshot; stale source/settings results are
rejected and non-finite mask output produces an explicit analysis error.

Empty or erase-only uninverted masks have provably zero coverage and no longer
activate pixel processing or suppress analysis, even with nonzero Light values.
Statistics ownership is explicit: inactive SDR/CPU hooks do not clear a histogram
owned by GPU presentation. Clipping overlays, exact full HDR statistics and HDR
pixel sampling with active masks remain unavailable. Regional/mask-only analysis
remains #61; the normal histogram still describes the entire photograph.

Histogram errors follow the same source and pixel-key ownership as successful
results. A superseded invalid readback cannot disable newer healthy HDR editing
or overwrite a raster Before histogram. The HDR midpoint index also carries the
odd half-integer remainder correctly; independent 257-sample references exercise
the boundary instead of changing the expected bins. View-only navigation may
reuse an older histogram serial when its complete pixel key still matches.

Focused macOS evidence uses isolated libraries and the hidden launcher:

- [Exact corrective rerun](../../artifacts/verification/2026-11-07T21-57-25.922Z-check-d9FfmS/summary.md):
  two passes in 12.42 s, including the independent masked HDR histogram and actual
  Sony RAW mask/Before/history workflow; build passed.
- [Final affected checks](../../artifacts/verification/2026-11-07T21-58-05.746Z-check-4TsWlm/summary.md):
  ten passes in 28.78 s across `hdr-histogram-lifecycle`, `masks-webgl`, `masks-ui`
  and the two affected `hdr-content-gpu` cases. Type checking, lint and formatting
  passed. Tests cover full-photo counts, ordering, pan/zoom and Split independence,
  stale success/error readbacks, non-finite rejection, cleanup and queue reuse.

Read-only inspection of the user's already-open app confirmed three histogram
curves, **After / Rec.2020 · HDR content**, a settled WebGPU HDR preview and the
existing +1.83 EV local exposure. No user photo, mask or preference was changed
for that inspection. Physical HDR output and Bazzite/Windows were not qualified.

The [additional regression selection](../../artifacts/verification/2026-11-07T21-43-31.911Z-check-1PX54t/summary.md)
and its [exact rerun](../../artifacts/verification/2026-11-07T21-46-39.099Z-check-SGIhrZ/summary.md)
retain a separate failure in the unchanged streamed SDR-proof alpha assertion:
GPU Float32 rounding produces 179 while its JavaScript Float64 expectation is 178. That test and pixel policy were not changed or weakened. The two histogram
and primaries cases from that file pass in the final affected checks above; the
alpha case remains a separate verification boundary.

## Mask overlay and displayed geometry — November 7, 2026

The colored coverage overlay and brush coordinates follow the photograph's
committed presentation geometry, rather than the latest requested zoom or pan.
Each presenter publishes a captured image size, viewport, view, canonical mask
mapping and source identity only when that photograph has been drawn. Pending
navigation keeps the previous geometry while those pixels remain visible.
Coverage redraws from the presentation callback before the browser can paint the
completed photograph; brush drafts can still update coverage within that frame.

The brush cursor and pointer/keyboard hit testing share the same geometry. During
a viewport resize, pointer coordinates scale into the committed viewport so they
match the temporarily stretched photograph. A source replacement with no valid
presented mapping clears coverage and the cursor and cancels an unfinished brush
draft. Ordinary presentation serial changes do not cancel strokes. This changes
view synchronization, not saved mask geometry, processing algorithms or history.

The [deterministic reproduction](../../artifacts/verification/2026-11-07T22-06-31.118Z-check-7xaAGG/summary.md)
held a genuinely completed HDR offscreen render before its canvas blit: the
photograph remained at scale 1 while the overlay advanced to scale 2. The
[corrected exact rerun](../../artifacts/verification/2026-11-07T22-13-43.033Z-check-PTufaz/summary.md)
passes in 7.04 s including the build. It covers two queued zoom/pan requests,
actual overlay GPU uniforms, brush cursor dimensions/position, an off-center
draft placed against the visible frame, cancellation and unchanged edit history.

The [expanded preview selection](../../artifacts/verification/2026-11-07T22-14-39.390Z-check-7To6Q3/summary.md)
also exposed a stale test expectation for automatic Canvas2D fallback after
WebGL loss. That test now requires the existing explicit GPU failure and Retry
GPU behavior, preserved source/view/history and the original exact pixel
references after recovery. Its [exact rerun](../../artifacts/verification/2026-11-07T22-17-41.811Z-check-U20zW3/summary.md)
passes in 2.29 s; fractional-pan pixel-grid verification passed in the expanded
selection. Production recovery policy and numeric references were unchanged.

The [affected selection](../../artifacts/verification/2026-11-07T22-18-25.776Z-check-djOU5J/summary.md)
retains 33 passes in 38.88 s across verification-plan checks, raster mask controls
and rendering, and actual RAW mask/history/histogram workflows. Type checking,
lint and formatting passed. Its remaining source-replacement test initially read
stroke chunks from the compact history response; the corrected test reads the
hydrated edits response instead.

That [exact source-replacement rerun](../../artifacts/verification/2026-11-07T22-20-07.448Z-check-bUzpmz/summary.md)
passes in 6.10 s. It verifies an equal-sized 180-degree RAW rotation, actual
coverage alpha moving to the rotated location, changed presented source identity,
unchanged stored strokes and exactly one crop history entry. The saved screenshot
was visually inspected. The affected selection and corrective runs retain **37
distinct passing cases**; original failed receipts remain failed. No additional
comprehensive checkpoint or performance benchmark was run. Native Bazzite/Windows
and their cached-presentation branches remain unqualified by this macOS check.

## Expandable Masks panel — November 8, 2026

The layout portion of #58 replaces separate creation buttons with one **Create
mask** menu, readable mask rows with **⋯** actions, **Show overlay** and
**Coverage / Adjustments** tabs. Brush and object selection retain their existing
edit owners; this changes presentation and workspace preferences rather than
photo settings or processing. Old seven-field mask-workspace checkpoints retain
selection, overlay and brush values and default the new detail tab to Adjustments.

The [selected functional run](../../artifacts/verification/2026-11-08T17-48-55.253Z-check-7eqAdL/summary.md)
passes **25 cases in 93.38 s** across `masks-ui`, `object-selection-ui`,
`object-selection-presentation-ui`, `masks-presentation-ui`, `photo-menu-ui`,
`sunflower-fidelity` and `workspace-recovery`. The
[final native/UI run](../../artifacts/verification/2026-11-08T17-53-31.592Z-check-7pzO2i/summary.md)
passes **six cases in 40.03 s**, including native pointer/keyboard masking at
1100 × 700 with Console open and rename-blur focus retention. Type checking,
lint and formatting pass. Explicit foreground captures were used after hidden
captures were partial; those screenshots were visually inspected, and pinned
header/independent-scrolling assertions pass. These runs are focused macOS
acceptance; [Bazzite TODO 69](README.md#task-69) retains native Wayland and other
device checks.

The [final proposal-overlay check](../../artifacts/verification/2026-11-08T17-54-51.633Z-check-UFlwbz/summary.md)
passes in 8.98 seconds: the overlay indicator reflects the temporarily forced
selection coverage, with the normal workspace preference retained afterward.
The development app was restarted through normal save/shutdown; local readback
confirmed the same active photograph, revision and mask IDs, the recovered
Adjustments preference, the new Create mask menu and no preview GPU errors.

The [original prerequisite sweep](../../artifacts/verification/2026-11-08T17-45-33.789Z-check-jlVBK1/summary.md)
remains failed: 940 passes, three development-launcher timeouts and 34 platform
skips. The [first exact host-Node rerun](../../artifacts/verification/2026-11-08T17-47-16.943Z-check-XXrQzH/summary.md)
and [remaining two host-Node reruns](../../artifacts/verification/2026-11-08T17-47-54.292Z-check-wRgH3Q/summary.md)
pass without launcher changes. The bundled-Node shutdown issue remains: the
supervisor matches `Irodori` anywhere in an executable path and consequently
counts bundled Node descendants as live applications. That separate runtime
limitation is not a clean prerequisite pass. No comprehensive checkpoint or
processing benchmark was run for this layout.

## Compound coverage — November 10, 2026

[Compound masks](mask-compounds.md) extend coverage with owned Add, Subtract and
Intersect parts, editable independent copies, fixed starting coverage and separate
result corrections. [Issue #85](https://github.com/VaclavKlima/Irodori/issues/85)
owns implementation and acceptance; [#99](https://github.com/VaclavKlima/Irodori/issues/99)
tracks other-device verification. This tree order supersedes the earlier single
source/brush coverage description above; root Light/Color still apply once.
