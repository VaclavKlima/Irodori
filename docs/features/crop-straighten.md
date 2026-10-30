# Crop and straighten

## Status

**Goal 1 functional implementation; acceptance in progress, 2026-10-25.** Crop is
available through the UI and shared revision-checked edit API/MCP. Transient controls,
native geometry validation, history/migration, prepared variants, production resource
admission and frozen export policies have focused checks. A small oriented PNG passes
independent pixel comparison, histogram, export, Undo/Redo and restart; the actual
hidden application passes Apply/Cancel and view restoration. HDR adapters and CPU/GPU
filtering retain synthetic/native-kernel evidence. Real RAW/gain-map/merge round trips,
native visual/input and source-matched performance acceptance remain open.
[Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Reframe, rotate and level a photograph without changing its original or durable
master. Preview, native zoom, white-balance sampling and export must agree about
the geometry and output dimensions.

## User workflow

Open Crop, choose free/original/fixed aspect ratio, adjust framing, rotate by quarter
turns or set Straighten, inspect and apply. Reset restores identity. Escape/Cancel
discards the draft. Undo/Redo and restart restore the accepted crop with the other edits.

The toolbar opens the Crop inspector section and prepares an uncropped native source.
Framing currently shows that source with a crop quadrilateral and thirds grid; Apply
shows the resampled, leveled output. Native acceptance must evaluate this source-oriented
framing interaction. Cancel restores the committed crop and previous zoom/pan.

## Controls

Pointer handles and equivalent numeric position/size/angle controls use
`AdjustmentInput`. Offer free/original, 1:1, 4:3, 3:2, 16:9 and custom numeric ratios.
Straighten is −45…+45 clockwise degrees in 0.01-degree steps. Quarter turns rotate
the current framing and invert a locked aspect. Show resulting pixel dimensions.

Center and size controls use native pixels. Custom aspect is a numeric X:1 ratio.
Angle, size and aspect commands explicitly fit the shown draft inside the photograph;
translation retains its size, and corner dragging keeps the opposite corner fixed
while stopping at source edges. A focused handle moves by one native pixel with
arrow keys, or ten with Shift. Capture loss cancels that gesture. Numeric Escape
uses the shared input cancellation; Escape outside an input or Cancel crop closes
the draft. An Apply already sent to main finishes before Cancel becomes available.

Flush other pending edits before opening the tool; use a transient crop draft and
one revision-checked history entry on Apply. Photo/revision changes cannot apply a
stale draft. Coordinate pan, split comparison and picker modes, pointer capture,
focus loss and cancellation. Preserve keyboard/minimum-size/Console-open usability.
Photo-wide history shortcuts, other adjustments, comparison and neutral picking pause
while framing; controls remain mounted when their inspector section collapses.

## Processing approach

The model is `native-center-quarter-straighten-v1` in
[crop.ts](../../src/shared/crop.ts). It starts with the already oriented, lens-corrected
native working image; source axes are bounded to 1…32768 pixels. Store clockwise
quarter turns, straighten angle, normalized center/extents in the quarter-turned
unstraightened source, and a nullable numeric aspect constraint. Screen coordinates
and EXIF orientation are not stored again.

Compile output-to-source and source-to-output affine maps in pixel-edge units;
sampling uses pixel centers. Native output dimensions are the floor of requested
source extents, snapping only values within 1e-9 pixels of an integer. Each output
pixel remains one native unit apart; there is no hidden scale-to-fit. A locked
ratio constrains continuous extents; output integer rounding loses less than one
pixel per axis. Retain at least one native pixel on each axis.

All output corners must lie in the source rectangle, with only the 1e-9-pixel
representation allowance. Rendering rejects an outside crop. Explicit authoring
Fit first shrinks to a chosen aspect, then uniformly shrinks as far as needed at
the same center. It never expands or moves framing. Show that change before Apply;
export never fits silently. Existing source-alpha holes remain meaningful.

Identity bypasses resampling. Integer crops and exact quarter turns select/permute
Float32 channel bits, including alpha. Fractional origins and straighten use the
[Catmull-Rom/alpha policy and comparison](crop-filter-processing.md), with independent
numeric and small native GPU evidence. Support, premultiplied-alpha behavior,
texture/ringing gates and CPU/GPU tolerance are frozen; photographic acceptance remains open. Keep the existing
signed/HDR numerical requirements. Scalar affine error is bounded to 2e-9 native
pixels against the independent oracle, and fitted normalized extents to 2e-14.

Integrate a reusable geometry variant of prepared linear data before nonlinear
Light/color/output mapping. Retain the uncropped source under its own lease/identity
for source-space picking. Crop changes reuse prepared pixels rather than decoding
RAW again; authored HDR and its preserved SDR primary receive equivalent geometry.
Never bake display transforms into a replacement working master. Later denoise/detail
placement still requires its own quality decision.

Framing reuses existing GPU source/viewport resources and inverse native-coordinate
mapping, without preparing another full-size image on each drag. Committed geometry
uses bounded GPU preparation tiles with equivalent worker/native CPU paths.
Identity adds no upload/pass, and color-only edits, pan/zoom and monitor changes reuse
committed geometry. Charge all source/destination/overlap/in-flight memory to existing
admission; do not retain an unmanaged second full-size image. No GPU/RAW-heavy acceptance
runs while the user is playing.

## API/MCP implications

The existing edit service accepts a bounded crop object. Main validates settings and photo-dependent aspect, dimensions
and corner containment before history writes, using authoritative prepared dimensions
through existing leases. Provisional catalog dimensions cannot authorize an invalid crop.
Combined crop/lens patches prepare the proposed lens variant before validation, without
publishing it to history. A later concurrent edit still fails the writer revision check.
Caller patches are copied before asynchronous work.

UI and MCP use photo IDs, expected revisions and the same crop settings/capabilities.
A crop context supplies authoritative source/output geometry and rendering identity.
Map picker coordinates to the uncropped native source; the patch diameter remains
7/15/31 native source pixels. Project its corners as a rotated quadrilateral rather
than sampling a screen-sized box or reading displayed pixels.

## Persistence

Settings 9/catalog 19 migrate supported settings 7/catalog 17 and settings 8/catalog 18.
Exact identity geometry is added to current and every historical snapshot in one
transaction, preserving revisions, redo, cursor, timestamps and source/master bytes.
Startup rejects unsupported or malformed geometry before migration/recovery writes.
Persist geometry/version, not generated pixels; leave unapplied drafts transient.

Variant keys include uncropped source, crop and geometry/filter versions. Identity
retains the established fast path. Frozen exports retain accepted crop/dimensions.
Copy/paste excludes geometry by default; explicit inclusion validates destinations.

The export worker now consumes frozen internal geometry before sizing, Light/color,
output mapping and alpha flattening. Prepared HDR and authored SDR-primary inputs use
the same geometry while retaining their distinct color semantics. Identity keeps
the established bytes and creates no crop file. The source decoder explicitly
prepares uncropped data; later geometry changes do not change its source identity.
Main settings/admission and manifest versions are connected. The ordinary preview worker rejects an unprepared crop instead
of displaying an uncropped frame under cropped settings.

The existing preview cache now keeps uncropped and cropped sources under separate
identities and leases. Compiled sampling maps, geometry/filter versions and source
identity determine a variant; an aspect lock that leaves pixels unchanged does not
make another variant. Color edits reuse cropped Float32 data. Identity/reset reuses
the uncropped path, and first-surface handoff declines a nonidentity crop until its
complete working source exists. CPU references revalidate the current crop identity.
Histogram/pixel analysis uses the crop; neutral picking leases the uncropped source.
Picker clicks and native sample rectangles map through the inverse crop geometry.

`getCropContext(photoId, expectedRevision)` and `irodori_get_crop_context` return native
oriented/corrected dimensions and geometry without trusting catalog dimensions,
changing history or exposing a file path. Revision checks bracket preparation. The
crop editor consumes this context and commits one photo-wide history entry. UI and MCP
share `updateEdits({ crop }, expectedRevision)`; invalid geometry creates no snapshot.
A specific revision-checked `requestCropPreview` bridge operation leases uncropped
native data for the transient tool through the existing preview cache. Returning to confirmed geometry
reuses the base source. Native CPU access to that uncropped frame requires the
active framing owner and expires when the owner is released or replaced.

## Dependencies

Reuse [preview geometry](../../src/renderer/src/preview/geometry.ts),
[working assets](../../src/main/working-assets.ts),
[picker contracts](white-balance-picker.md),
[lens preparation](../../src/main/processing/lens-correction.ts),
[export sizing](../../src/shared/export.ts) and [inputs](../input-design.md).
Ordinary enlargement later in Goal 1 uses crop dimensions; final-size proof/output
sharpening remains Goal 2.

### Remaining acceptance checkpoint

1. Complete real RAW/gain-map/merge preview, analysis, inverse picker and frozen
   individual/batch export round trips, with original/master preservation and native
   100% comparison. Small-PNG and synthetic HDR evidence do not close those gates.
2. Verify actual GPU/native CPU fallback, full-size RAM/VRAM, cancellation and source
   reuse under the existing saved performance gates. Production admission queries
   active/retiring renderer owners and current policy before crop work and each export
   attempt. Counts remain conservative model bounds, not process RSS or physical VRAM.
   Unknown native adapter capacity retains bounded CPU fallback.
3. Inspect framing, quarter turns, straighten, keyboard/pointer capture and dropdowns
   at native 1100 × 700 with Console open. Keep source-oriented draft framing explicit
   and evaluate its usability before calling the feature accepted.
4. Keep these gates open while the user is playing. Continue other light Goal 1 work;
   complete combined workflow acceptance before advancing to masking.

## Failure handling

Invalid/outside/too-small/ratio-incompatible settings preserve the confirmed edit
and explain the reason. Failed/cancelled preparation cannot publish partial assets
or mutate originals/masters. Preserve leases, source identity, stale-result rejection,
deletion/shutdown coordination and bounded CPU fallback. Never silently ignore a crop.

## Acceptance criteria

- Independent Decimal80 corner-search/rotation references cover all quarter turns,
  both angle limits, fractional centers, aspect locks, non-square and 32768-pixel sources.
  Uniform Fit is maximal at its center and never expands.
- Identity and integer crops/quarter turns preserve all channel/alpha bits. Geometry,
  authoritative dimensions, reset and inverse coordinates survive Undo/Redo/restart.
- Freeze and satisfy filter texture/ringing/alpha/numeric limits on ramps, diagonal
  and repeating detail, signed/HDR inputs and real photos. Check boundary support,
  CPU/GPU agreement and tile seams without an SDR intermediate or hidden enlargement.
- Preview, exact 100%, histogram/analysis, picker and independently decoded exports
  use matching geometry. Authored HDR and SDR-primary color semantics remain distinct.
- Handles, numeric edits, aspect/rotate/angle/Apply/Cancel support keyboard, focus,
  capture loss, photo/revision changes and native minimum-size layout.
- Migration, frozen individual/batch export, typed UI/MCP parity, source reuse,
  destination checks, cache identity, RAM/VRAM, cancellation and recovery pass.
- Real RAW/native/performance gates remain required when the desktop is available;
  scalar/component evidence alone cannot close this feature.

## References

- [Accepted delivery plan](professional-editing.md) and [priority evaluation](lightroom-comparison.md).
- [Adobe crop workflow](https://helpx.adobe.com/uk/lightroom-classic/desktop/help/crop-rotate-straighten.html)
  is interaction inspiration; Irodori's mathematical model is original.
- [Independent Decimal80 generator](../../scripts/research/crop-reference.py) and
  [geometry checks](../../tests/crop-geometry.spec.ts): Taylor sine/cosine, binary-search
  corner containment and repeated quarter rotations, without production imports.
