# Tone mapping and output rendering

## Status

The automatic ACES 2 default is implemented for supported Sony RAWs and merge masters; see [the versioned implementation contract](../hdr-processing.md). This brief retains the broader destination and acceptance criteria, including work deferred beyond the Linux preview milestone.

## Goal

Render smooth highlights, deep but usable shadows, and stable hues from retained HDR data into separate SDR and HDR targets. Preserve the master regardless of the selected display.

## User workflow

Edit once, compare SDR and HDR renditions, inspect target clipping, and select a deliberate rendition for export. Moving to an SDR monitor changes presentation without rewriting photo edits.

## Controls

Provide a neutral default rendering policy and a compact advanced section for supported highlight roll-off and output brightness parameters. Numeric controls follow `AdjustmentInput`. Distinguish saved creative rendering choices from transient monitor headroom. Define ranges and units in the algorithm decision record before exposing controls.

## Processing approach

The default uses the complete pinned ACES 2 transform described in [the rendering decision](../display-rendering.md). Future creative or spatial operators require separate research and a versioned design. Compare candidates on HDR ramps, bright colored lights, backlit faces, dark gradients, and specular highlights. Measure monotonicity, derivative continuity, hue/chroma change, and gamut boundary behavior. Local contrast halos and scene-dependent pumping are unacceptable defaults.

Specify the order between existing light controls, new creative operators, gamut mapping, target brightness mapping, and output encoding. SDR maps to its reference white and bounded output gamut; HDR uses an explicit diffuse-white/peak relation and available headroom. Separate luminance compression from gamut compression, with defined treatment of negative channels, zero luminance, and alpha. Do not independently clip RGB channels before hue-preserving mapping is evaluated.

Research the appropriate HDR color appearance model and gamut mapping method with fixed reference images and numerical tolerances. Preview and export share the chosen transform and version. Display changes may select another target descriptor but never renormalize exposure from edited pixels. No operator can reconstruct clipped sensor information.

## API/MCP implications

Add typed rendition settings and target descriptors with reference white, target peak, primaries, and transfer function. Saved parameters use expected revisions; transient display targets use generation checks. Return which transform produced each frame/statistic/export.

## Persistence

Persist creative tone/gamut policy and version in shared history. Keep monitor capabilities in workspace state. The current default applies automatically and preserves numeric history, originals and master bytes. There is no previous-look branch or per-photo upgrade. Include all output parameters in downstream render identities and exact placeholders.

## Dependencies

Requires [HDR processing](hdr-processing.md) and [camera color profiles](camera-color-profiles.md) for RAW. Synthetic characterized inputs support early research. [HDR display](hdr-display.md), [analysis](hdr-analysis.md), and [export](export.md) consume the transforms without defining competing algorithms.

## Failure handling

Reject invalid target peaks or missing color descriptors. If HDR presentation fails, render the controlled SDR target and report the mode change. Unsupported saved transforms must not silently substitute a new look.

## Acceptance criteria

- Neutral and colored ramps through 16× reference white remain finite; the neutral ramp is monotonic with no shoulder discontinuity or unintended shadow plateau.
- Freeze measurable hue, gamut, and gradient-error limits in the research record; pass them on independent references for SDR and at least two HDR headrooms.
- Verify neutral defaults, extreme combined adjustments, alpha, CPU/GPU agreement, history/restart, and byte preservation of originals and masters.
- Preview and export agree for the same target within the codec's declared tolerance; switching monitors does not change master bytes or edit revisions.
- Publish comparison images and brightness plots showing preserved shadow separation and smooth highlights, with no unreported channel clipping.

## References

- [Existing SDR operators and order](../raw-processing.md), [adjustment parameters](../../src/shared/adjustments.ts), and [HDR processing](hdr-processing.md).
- [HDR presentation target](hdr-display.md) and [export rendition contract](export.md).
