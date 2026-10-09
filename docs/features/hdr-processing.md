# HDR processing foundation

## Status

A limited experimental Sony RAW implementation now exists; see [the versioned implementation contract](../hdr-processing.md). This brief retains the broader destination and acceptance criteria, including work deferred beyond the Linux preview milestone.

## Goal

Retain usable highlight range through the same nondestructive pipeline for a single RAW, a merged photograph, and a supported imported HDR file. SDR and HDR outputs must be derived from that data without baking a display transform into the master.

## User workflow

Open an eligible asset, edit it, switch between SDR and HDR renditions, restart, and export from the same saved state. Existing photographs retain their processing version; an explicit upgrade previews the change and commits one undoable history entry.

## Controls

Expose processing version and input limitations in photo information, with an upgrade action when available. Display-mode controls belong to the display brief. No manual memory management controls are required.

## Processing approach

Introduce a distinct master descriptor with dimensions, orientation, alpha convention, channel layout, float precision, named primaries, white point, transfer function, and brightness reference. Candidate working spaces and Float16 versus Float32 storage remain research tasks: compare out-of-gamut colors, extreme exposure, precision, decoder clipping, and memory against an independent Float64 reference before selecting them.

Use scene-linear relative RGB for RAW/merge data, with explicitly defined exposure normalization. Retain values above 1 and valid negative conversion values until a documented operator requires special handling. Import display-referred PQ/HLG or gain-map data through an adapter that records its original reference and conversion; do not pretend it is recoverable scene radiance. Define diffuse white and target peak separately. Stops are `log2(Y / referenceY)` only for positive Y; zero and negative values need separate handling. Nits are cd/m² and require an explicit absolute mapping, never a guessed camera calibration.

Version the stage graph: decode/characterize → linear preparation and lens geometry → ordered nondestructive edits → output transform → encoding/presentation. Research noise-reduction and merge placement with their briefs before freezing order. Use the automatic current scene-rendering graph; preserve numeric history during catalog cutover. The current CPU decoder's 16-bit linear output must be audited for upstream clipping; float conversion cannot restore discarded values. Keep native decoders, sharp, and Dawn outside Electron.

Start from current 384 MiB retained CPU, 1 GiB native GPU, 512 MiB float-asset and renderer allocation limits, and 2 GiB preview disk LRU. Account for masks, mipmaps, tile overlap, and streams. Research tiled processing and cancellation with peak allocation measurements; reject inputs safely when no bounded path exists. Durable merged data is never evicted as preview cache.

## API/MCP implications

Extend typed asset and render descriptors with processing version, dynamic range, color/brightness reference, supported operations, and target identity. Keep photo IDs and expected revisions; never expose worker paths. UI and MCP obtain the same capabilities and errors. A future master cannot be mislabeled as the existing RGBA8 frame contract.

## Persistence

Store processing version and source interpretation with edits; migrate all snapshots transactionally while preserving numeric edits and revisions. Cache identities include master schema, decoder/profile versions, stage order, and output policy. Bump rendering versions for changed pixels and rebuild disposable assets. Originals and durable merge masters remain readable even if a newer renderer is unavailable.

## Dependencies

Requires the stage-1 [display feasibility](hdr-display.md) findings and current worker/history contracts. Production color profiles, tone mapping, merge, and format adapters build on this foundation; synthetic float inputs permit foundation testing first.

## Failure handling

Reject malformed descriptors, nonfinite samples, resource overflow, and unsupported transforms explicitly. Cancel obsolete jobs and release leases on device loss, deletion, and shutdown. CPU fallback must preserve HDR data even when presentation falls back to SDR. Never substitute an SDR cache for a missing HDR master.

## Acceptance criteria

- Preserve distinct synthetic values at 0, 0.18, 1, 2, 4, and 16 through edit/save/reload; exposure +1 then −1 recovers inputs within the recorded precision tolerance before output conversion.
- Validate a single RAW, a merged fixture, and imported HDR against independent linear references; report any source clipping separately from display clipping.
- CPU/GPU results pass fixed absolute/relative float tolerances, including negative channels and alpha; define tolerances and precision choice in the foundation decision record before acceptance.
- Existing numeric histories remain intact through automatic rendering cutover; Undo/Redo, migration rollback, cache invalidation, stale requests, and crash recovery pass.
- Peak allocations stay within declared bounds on maximum supported dimensions and concurrent import; cancellation releases resources. Preserve the roadmap's SDR performance gates and record separate HDR timings.

## References

- [Current processing contracts](../../src/main/processing/contracts.ts), [RAW pipeline and budgets](../raw-processing.md), and [edit settings](../../src/shared/edits.ts).
- [Tone mapping](tone-mapping.md) and [HDR file interpretation](hdr-file-support.md) define downstream color and format decisions.
