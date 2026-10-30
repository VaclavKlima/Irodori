# Three-way color grading

## Status

**Functional implementation; photographic/performance acceptance pending.** The
[processing record](color-mixer-grading-processing.md) defines the original Irodori
model and passing independent scalar, native C++, WebGPU and hidden WebGL evidence.
GPU/CPU preview/export and shipping native adapters have focused coverage.
Settings 10/catalog 20, partial API/MCP patches, inspector wheel/numeric controls,
reset, shared history and small-raster frozen export have hidden/service evidence.
Full HDR application, real-photo, native visual/input and source-matched performance
acceptance remain unfinished. This is part of Goal 1 in [professional editing](professional-editing.md).

## Goal

Give shadows, midtones and highlights controlled color and brightness, including
toned monochrome looks, while preserving the source's HDR information and alpha.

## User workflow

Choose a tonal region, set its hue and color strength, then tune overlap and balance
while comparing the photograph. Every wheel has numeric and keyboard equivalents.
Region selection is workspace state; changed settings share photo-wide history.

## Controls

Each of Shadows, Midtones and Highlights has Hue 0…359.9 degrees in 0.1-degree
steps, Saturation 0…100 and Luminance −100…+100 integer amounts. Neutral hue,
saturation and luminance are zero. Blending defaults to 50 within 0…100; Balance
defaults to zero within −100…+100. Use shared numeric inputs. Positive Balance
favors highlights. The wheel and its numeric inputs edit the same settings.

## Processing approach

Apply grading after the mixer and global intensity, before the existing output
transform. This permits colored monochrome output after global desaturation. The
versioned CIE Lab/D65 model uses explicit linear primaries, luminance-based tonal
weights, bounded tint vectors and explicit luminance gain. Exact black stays black;
above-white highlights remain eligible. Equal settings in all three regions produce
a global grade. The processing record defines the full equations and fixed limits.

## API/MCP implications

Extend the existing revision-checked edit API with validated, versioned tonal settings,
Blending and Balance, and report their units/ranges through capabilities. Renderer
and MCP use the same service. Reset and combined changes commit atomically; selecting
a region, comparing or opening the section creates no history entry.

## Persistence

Before enabling the tool, migrate neutral settings into current settings and every
historical snapshot transactionally, preserving cursor, redo branches and timestamps.
Persist algorithm semantics and include all controls in rendered-frame identities and
frozen export jobs. Neutral grading preserves the existing intensity path exactly.

## Dependencies

Reuse the established [global intensity model](vibrance-saturation.md),
[mixer](color-mixer.md), inspector disclosures, shared gesture/history service and
[input conventions](../input-design.md). Goal 1 does not depend on Goal 2 curves or
local adjustments. Source retention, CPU fallback and resource admission remain shared.

## Failure handling

Reject unknown tones, malformed versions and nonfinite/out-of-range controls before
history writes or allocation. Unsupported backend arithmetic cannot silently bypass
a saved grade. Cancel obsolete work and preserve the last matching confirmed frame.

## Acceptance criteria

- Neutral or powerless controls preserve pixels exactly, including unused Hue,
  Blending and Balance; alpha remains unchanged.
- Independent references verify hue directions, normalized continuous tonal weights,
  balance direction, tint/luminance behavior and signed/16×-white values.
- CPU, native, WebGPU, WebGL and exported pixels retain the fixed numerical limits.
  Single-pass integration and retained source reuse meet existing resource gates.
- Each gesture commits once through shared history, including reset, Undo/Redo,
  restart, stale revisions and equivalent typed UI/MCP edits.
- Real photographs and combined RAW/raster/merge workflows verify useful tinting,
  shadow/highlight detail, minimum-size keyboard use and output agreement. Retain
  separate native/foreground and source-matched performance acceptance.

## References

- [Original processing equations and evidence](color-mixer-grading-processing.md).
- [Adobe tonal/color workflow](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/image-tone-color.html),
  reviewed 2026-10-25 as workflow inspiration; Irodori does not copy Adobe's algorithm.
