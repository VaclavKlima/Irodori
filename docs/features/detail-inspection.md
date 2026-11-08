# Flexible detail inspection — TODO #55

The shared photo API and Console MCP expose coordinate-bound inspection of the
complete photograph or a region. Editor, Merge and Output preview retain their
existing display controls. This adds no photo-settings migration.

## Requests and coordinates

Read `irodori_get_preview_context(photoId, expectedRevision)` before a region
request. It returns authoritative oriented, lens-corrected, cropped dimensions,
a geometry grid identity, formats, source dynamic range, HDR availability and
payload limits. Coordinates address that complete photograph independently of
screen zoom/pan. The grid identity includes crop, lens mapping and orientation;
an equal-sized rotation still invalidates old coordinates. Tonal changes do not
change the grid, but each request must use a confirmed current revision.

Both `irodori_get_photo_preview` and `irodori_get_output_proof` accept optional
`inspection`:

```json
{
  "region": {
    "units": "pixels",
    "gridIdentity": "identity returned by preview context",
    "x": 100,
    "y": 200,
    "width": 512,
    "height": 512
  },
  "resolutionPercent": 100,
  "encoding": { "format": "png" },
  "comparison": "pair",
  "hdr": false
}
```

Omit `region` for the whole photograph. Normalized bounds use `units: normalized`
and fractions of the complete grid; resolve outward to integer pixel boundaries.
Invalid, out-of-bounds or stale regions fail explicitly. Output proof regions map
from the same photo grid into the decoded export grid, with actual bounds reported.

`resolutionPercent` is greater than zero through 100 and is independent of
compression. 100 means no additional resizing: **photo-native** for photographs,
**export-native** for output proofs. Enlarged exports can have a different native
size. Omitted resolution fits the selected extent within 1024 pixels without
enlargement. Encoding is JPEG with integer quality 1–100 (default 80), or lossless
SDR PNG without a quality field. JPEG quality 100 remains lossy. Export JPEG
quality in `options.quality` and inspection transfer quality are separate.

Omitting `inspection` preserves legacy whole-image SDR JPEG, longest edge at most
1024, quality 80 and at most 1 MiB. Extended responses contain labelled image
members with revision, rendering/grid identity, dimensions, native-grid and photo
bounds, encoding and requested/effective rendition. MCP returns a separate image
block and matching metadata for each member. Limits are 8 MiB encoded per image
and 16 MiB per pair, in addition to normal processing admission. Oversized requests
fail with guidance to reduce region, resolution or quality explicitly. The service
never silently reduces a requested extended image. Entries exceeding the existing
encoded cache budget are returned uncached.

## Matched comparisons and processing

`comparison` selects `after` (default), `before`, or `pair`. Before is a neutral
rendition derived from the same confirmed revision, with current crop/lens geometry
preserved and tonal/color/local edits, denoising and saved detail sharpening
neutralized. It is not a historical revision. Pair members share source, extent,
resolution, encoding and rendition, and publish only after both pass final
source/revision validation.

Source preparation, GPU rendering/resizing and isolated encoders remain shared
with production processing. Regions retain complete-image coordinates and spatial
filter context; cold RAW inspection can require full-source preparation. No ROI-only
RAW decoder is promised. Output proofs separately encode and decode both complete
JPEGs using identical export settings, including output sharpening, before region
extraction. Members run sequentially and release decoded assets between them.
Normal proof ownership and an independently open Output preview remain supported.

## Editor region context

**Inspect region** beside zoom enters a temporary selection tool. Drag to create,
move or resize; use numeric X, Y, Width and Height for exact coordinates,
**Locate at 100%** to navigate to it, or **Clear** to remove it. Drawing and hit
testing follow committed presentation geometry. Middle-button panning remains
available; crop, mask brushes and pickers own mutually exclusive tools. Escape,
window blur or lost capture cancels unfinished input while retaining the last
committed rectangle.

The rectangle changes no edit history and sends no message. It remains across
zoom/pan and tonal edits while the grid is valid; changing photo or geometry
clears it. Console shows pending context. Prompt capture flushes edits and
revalidates photo/grid before freezing an immutable region for that turn. Stale
context fails rather than inspecting the whole photo. The assistant chooses
resolution and encoding for each request.

## HDR capability and remaining acceptance

Extended images explicitly identify source dynamic range and delivered SDR
rendition, including HDR sources. Available source metadata is reported without
invented luminance measurements. Strict HDR image delivery is unavailable until
an exact client/version/model/transport combination is qualified. There is no
qualified combination in this delivery. HDR plus lossless encoding is unsupported.
The accepted ISO gain-map JPEG codec remains the production HDR codec; enabling
HDR transport requires its separate qualification, not a fallback conversion.

The [official OpenAI image documentation](https://developers.openai.com/api/docs/guides/images-vision)
checked on November 8, 2026 describes image preprocessing and metadata limitations;
it does not establish preservation of HDR values or gain maps through vision.
This absence is why the client capability remains unqualified. Native SDR image
delivery does not establish how a model preprocesses pixels or prove physical
HDR brightness. True HDR client/physical-display acceptance remains in
[#57](README.md#task-57); regional histograms/clipping remain in
[#61](README.md#task-61).

Focused verification targets and local evidence are recorded below. Historical
Console/output-proof evidence retains its original scope; transport stand-ins do
not establish authenticated live-model visual quality or HDR capability.

## Focused verification

Targets: `inspection-model`, `inspection-preview-service`,
`inspection-preview-gpu`, `inspection-proof`, `inspection-proof-gpu`,
`inspection-mcp`, `inspection-region-model`, `inspection-region-ui` and
`inspection-region-presentation-ui`. Existing `agent-policy`,
`agent-photo-preview`, `export-proof-service`, `export-proof-rendering`,
`export-proof-mcp` and `sunflower-fidelity` cover affected ownership and legacy
behavior. No comprehensive checkpoint or processing benchmark was requested.

Local acceptance uses isolated macOS profiles, committed raster and Sony RAW
photographs, a generated authored gain-map HDR input and synthetic merge working
assets. The merge region case includes masks, curves, denoising/sharpening and
more than 64 KiB of geometry to exercise actual worker IPC delivery. It compares
region pixels against the corresponding complete render. The export worker waits
for terminal IPC delivery before disconnecting; this prevents dropping large RAW
lens geometry results. No alternate processing backend or numerical gate is added.

Editor checks cover rectangle creation/move/resize, numeric validation,
Escape/window blur/capture cancellation, middle-button panning, post-flush prompt
freezing, photo/grid invalidation and the 1100 × 700 Console-open layout. A delayed
RAW GPU submission holds zoom/pan pending while region drawing stays on committed
presentation geometry. The minimum-size screenshot was visually inspected.

These are local macOS checks. Bazzite/Linux, Windows, native foreground pointer
lock/focus acceptance, authenticated live-model image interpretation and physical
HDR display assessment were not repeated. Managed MCP transport and trusted-hook
stand-ins verify image delivery and immutable context without establishing how a
live model preprocesses image pixels. No luminance measurements or regional
analysis from #61 are claimed.

### Local acceptance — November 8, 2026

**56 distinct focused and affected legacy cases pass** across the recorded runs.
Type checking, lint, formatting and the production build pass. The final follow-up
has **24 passed, zero failures/skips, 63.11 seconds**; slowest cases are real RAW
preview (13.53 s), two-source RAW memory ownership (9.06 s) and original-size
RAW/HDR output proof (8.70 s). No assertions or numerical tolerances were removed.
The independent reduced-proof reference uses direct scalar linear-light Lanczos3;
it preserves the existing maximum-three-byte small integration gate.

The [consolidated evidence](../../artifacts/verification/inspection-acceptance-2026-11-08/summary.md)
links exact invocations and limitations. Broad cheap Node selection additionally
has 917 passes and 34 platform/capability skips; three unchanged development-launcher
lifecycle cases time out locally, including a focused rerun outside the sandbox.
Those failures remain recorded and no comprehensive checkpoint pass is claimed.
