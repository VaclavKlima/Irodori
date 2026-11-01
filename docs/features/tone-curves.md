# Tone curves

## Status

**Planned.** Master and per-channel curves are not implemented. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Provide precise tonal and channel control across the retained HDR range, including values above reference white.

## User workflow

Choose Master, Red, Green, or Blue; add and move control points; compare the result; undo a gesture or restore the identity curve. Points outside the visible plot range remain inspectable and editable.

## Controls

Provide an accessible graph plus a focusable point list with numeric input/output coordinates, add/delete actions, and keyboard movement. Label the axis encoding and reference-white position. Master affects luminance according to a documented rule; channel curves intentionally may change hue. A reset of the curve is one shared edit, not another history stack. Numeric slider fields use `AdjustmentInput` where applicable.

## Processing approach

Research a scene-linear versus logarithmic/shaper-domain editor. The selected representation must explicitly cover black, negative conversion values, SDR white, and above-white values without clipping them to the graph edge. Store mathematical coordinates separately from graph pixels. Define interpolation, point ordering, minimum spacing, endpoints, and extrapolation across the full supported brightness range.

Compare shape-preserving interpolation candidates on dense ramps; forbid accidental overshoot and document whether nonmonotonic user curves are allowed. Specify Master luminance scaling near zero and per-channel order relative to global light/color operations. Identity curves bypass exactly. LUT acceleration needs an error bound over HDR values and a defined out-of-domain path; no hidden 8-bit lookup limit.

Use one production [GPU path](../gpu-processing.md), with independent scalar references for interpolation and output verification. CPU parameter validation and coefficient construction do not require a second CPU rendering backend.

## API/MCP implications

Expose bounded arrays of typed points, curve domain/version, and channel selector via atomic edit patches. Validate point count, finite coordinates, duplicates, ordering, and extrapolation parameters in main. MCP can create the same curves without manipulating UI coordinates.

## Persistence

Migrate all snapshots with identity curves. Persist domain, points, interpolation version, and extrapolation policy, not generated LUTs. Cache LUTs and rendered variants by content identity. Future interpolation changes require a rendering-version change and a deliberate upgrade path.

## Dependencies

Requires [HDR processing](hdr-processing.md) and [tone mapping](tone-mapping.md). Histogram integration may use [HDR analysis](hdr-analysis.md), but graph editing must work without that overlay.

## Failure handling

Invalid points leave the last confirmed curve intact with a field-level explanation. Reject unsupported curve versions; do not silently replace them with identity. Unsupported GPU capabilities, allocation refusal or device loss preserve saved curves and originals, release resources and expose an appropriate GPU retry. Do not silently execute a CPU renderer. Conflicting revisions reload confirmed settings and discard stale gesture results.

## Acceptance criteria

- Identity curves preserve legacy output; test black, signed inputs, reference white, and values through 16× white without truncating the curve domain.
- Dense-ramp tests establish interpolation continuity, endpoint/extrapolation behavior, and the recorded LUT error limit; monotone point sets do not introduce reversals.
- RGB curves affect only their declared channels before downstream transforms; Master follows its luminance rule and preserves alpha.
- Add/move/delete/reset works with keyboard and numeric entry; one gesture commits once, Escape cancels, and focus remains usable at minimum window size.
- Migration, Undo/Redo, restart, GPU agreement with independent references, maximum point count, capability refusal/retry cleanup and UI/MCP curve equivalence pass.

## References

- [Input design](../input-design.md), [edit snapshots](../../src/shared/edits.ts), and [HDR brightness contract](hdr-processing.md).
- [Tone mapping](tone-mapping.md) defines the output-stage relationship.
