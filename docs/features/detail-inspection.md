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

### Managed Console HDR delivery checkpoint — issue #82

A focused background check used the built Irodori 0.2.0 application on an Apple
M4 Pro with macOS 26.7 (25G229), Electron 44.3.0 and an isolated temporary
library. The tracked CC0 Sony ZV-1 RAW was presented by `webgpu-hdr` in Display
P3 at a reported target headroom of 1.0625×. The managed presentation context
identified the same confirmed revision and display generation before and after
the image requests.

The real compiled MCP and managed prompt gate returned a matched 192 × 128
Before/After pair for that revision. Independent decoding verified two distinct
8-bit sRGB JPEGs with matching geometry and no supported ISO gain maps. The
strict HDR pair request returned the unqualified-client reason and zero images.
The single check passed in 9.7 seconds. It used an MCP SDK client and a Codex PTY
stand-in. The [diagnostic receipt](../../artifacts/issue-82-hdr-console/summary.md)
records exact bundle and fixture hashes, display reports and profile cleanup.

An independent loopback control gave Codex CLI 0.170.0 a synthetic ISO gain-map
JPEG and an SDR-only JPEG with identical decoded SDR primary pixels over MCP
stdio. With `gpt-5.4` configured for a fake Responses endpoint, the CLI
forwarded both JPEGs byte for byte, including the ISO gain map. The
`gpt-6.2-sol` configuration did not expose the MCP tool to the fake endpoint,
so only the `gpt-5.4` loopback route has this byte-preservation evidence. The
[loopback receipt](../../artifacts/issue-82-hdr/cli-controls/receipt.json) covers
local serialization. Provider decoding and live model interpretation require
an isolated authenticated qualification with controlled gain-map images. Keep
strict HDR gated under [#82](https://github.com/VaclavKlima/Irodori/issues/82).

### Signed-in gain-map control — issue #82

The two blinded orders ran in fresh conversations through the authenticated
Irodori Console, Codex CLI 0.170.0, the OpenAI provider and `gpt-6.2-sol`. The
test-only copy of the MCP bridge emitted the synthetic controls after the
normal hook, managed request and revision checks. Each order contained two
ISO gain-map JPEGs with independently verified above-white shapes and an SDR
blank. All three decoded to identical SDR pixels. The app used a separate
temporary profile and a synthetic managed photo.

The Codex tool-result events retained all six JPEGs in order with matching
hashes, and both turns completed in 17.19 seconds combined. The model called
all six images blank, scoring **0/4 hidden shapes and 2/2 blank controls**.
This route fails visual qualification. The evidence identifies what reached
the client and what the model reported. The provider's image preprocessing
step remains unobserved. See the [blinded score](../../artifacts/issue-82-hdr/live/score.json).

Managed photo preview and output proof attach `displayMismatch` when the same
photo and revision have a reported presented HDR frame. The notice describes
the HDR frame and the delivered SDR image, with the display generation for
attribution. Console instructions require disclosing this mismatch and using
revision-bound HDR statistics or pixels for highlight and clipping judgment.
The export format stays independent of the proof image's SDR transfer rendition.
The [focused Mac run](../../artifacts/verification/2026-11-18T11-37-20.195Z-check-QKQLGq/summary.md)
reported 1,089 passes, zero failures, and 34 skips in the shared checks. A
[rebuilt-app check](../../artifacts/issue-82-hdr-console/run-notice-01/managed-hdr-pair-managed-M-9b1f0--for-the-current-HDR-source/receipt.json)
passed in 9.4 seconds. Both rendered SDR members matched the original test
bytes, and the notice accompanied each image for the matched HDR frame.

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
