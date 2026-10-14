# HDR exposure merge

## Status

**Experimental bounded implementation.** The [Sony HDR/noise merge milestone](../merge-processing.md) implements review, processing and permanent derived masters for verified Sony inputs. Supplied handheld portraits and local 2/3/5/9-frame noise-stack timing gates pass; the broader workflow and remaining real-sequence gates below are incomplete. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Combine compatible RAW brackets into a durable, editable HDR asset, retaining highlight and shadow information while handling camera motion separately from moving subjects.

## User workflow

1. Select brackets across loaded and unloaded records. Await pending range selection, freeze source IDs, and open merge review without changing the active-preview contract.
2. Review exposure order, compatibility, missing metadata, and source thumbnails; choose a reference frame.
3. Preview alignment and deghosting independently, inspect confidence/motion overlays, correct problematic regions, and choose the valid-area crop.
4. Start a background merge with fixed input totals and phase progress. Continue browsing, cancel if needed, and open the new asset after publication.

## Controls

Provide ordered source selection, reference-frame choice, validated exposure-offset overrides in EV, alignment enable, deghost strength, reference-source corrections for motion regions, and crop choice. Overlays distinguish alignment residuals, excluded areas, and deghosted regions with labels as well as color. Make reference selection, geometry refinement, and correction regions keyboard accessible. A source-only fallback requires an explicit user choice and must be labeled as such.

## Processing approach

Merge linear decoded data, never embedded JPEGs or rendered SDR previews. Validate camera/mode, dimensions, orientation, focal length, aperture/focus changes, saturation coverage, and exposure differences. Normalize black levels, exposure, white balance, lens correction, and characterization consistently before weighting. Freeze whether existing source edits are used: initial scope uses originals and explicit merge preparation, not arbitrary creative source edits. Display that choice in review.

Research shutter/ISO/aperture-based normalization plus robust overlap estimates when metadata is incomplete. Record confidence; manual offsets are explicit, persistent overrides. Bracket weighting must distinguish clipped highlights from noisy shadows. More files do not guarantee recoverable range.

Alignment estimates camera translation and rotation independently of deghosting. Research a pyramid registration model, resampling, confidence metric, and supported transform range using known transforms and real handheld captures. Parallax, focus changes, rolling-shutter distortion, or insufficient overlap may invalidate a global model; either validate a bounded local method or reject the case with a specific reason. Do not stretch unreliable regions into apparent agreement.

Deghosting detects subject changes after exposure normalization and alignment: moving people, foliage, water, and occlusion require region-level source decisions. Use the selected reference to resolve motion where possible, with saved correction regions allowing another source. Report highlight/noise tradeoffs when a region uses one exposure. Research detection thresholds and temporal consistency with annotated real sequences; simple averaging is not acceptance evidence.

Compute a valid coverage crop in merged coordinates, record every source transform, and preserve native pixel scale without resizing to an original frame's dimensions. Tile decoding, alignment pyramids, masks, and accumulation within the foundation budget; choose a maximum bracket count from measurements, not unbounded allocation. Freeze algorithms, licenses, confidence/error thresholds, and reference metrics in a decision record.

## API/MCP implications

Design typed review/start/cancel/status operations using source photo IDs and revisions, merge settings, and bounded correction geometry. Return confidence, warnings, task phases, and the resulting asset ID. UI/MCP share validation and explicit fallback choices. Main owns source leases and scheduling; serialize merge publication with import/deletion mutations and make conflicting source deletion wait or cancel safely. Preview jobs remain outside that task lock.

## Persistence

Publish a self-contained, immutable float merged master as a new library asset with its own edit history. Persist source IDs and content hashes, available capture metadata, normalization offsets, reference choice, transforms, crop, motion masks/corrections, algorithm/profile/decoder versions, precision, and deterministic seeds where used. Master bytes and provenance live outside disposable preview caches.

With source originals available, the manifest must reproduce the merge within a fixed tolerance. Deleting a source does not cascade to or break the merged master; retain hash provenance and mark exact re-merge unavailable if required bytes are gone. Explain this consequence in source deletion review. Do not secretly retain undeletable originals or pretend a hash is a recoverable source. Deleting a merge trashes only its managed bundle, leaving bracket sources intact.

Use a journaled staged write, checksum validation, durable master/manifest publication, then one catalog transaction. Startup recovery handles crashes before/after each boundary, publishing only complete assets or retaining recoverable evidence. Never place committed masters in startup-disposable staging. Re-merging initially creates another asset; editing its recipe does not overwrite an existing master.

## Dependencies

Requires [HDR processing](hdr-processing.md), [camera profiles](camera-color-profiles.md), [tone mapping](tone-mapping.md), and current library/tasks/history. Integrate [HDR analysis](hdr-analysis.md), [noise reduction](noise-reduction.md), and [sharpening](sharpening.md) against final merged data. General crop editing is not required for the valid-area merge crop.

## Failure handling

Reject unsupported/missing sources, unreliable alignment, inadequate coverage, or unrecoverable motion with per-source/region reasons. Cancellation stops new work, waits for in-flight durable operations, and leaves originals and completed assets intact. Disk-full, worker crash, failed catalog commit, and application quit leave no partial published photo. Preserve cancelled/error task results until dismissed. Use system Trash for published asset deletion with no permanent-delete fallback.

## Acceptance criteria

- Licensed stationary brackets recover known exposure ratios and highlight/shadow detail unavailable in a single middle exposure, within frozen radiometric tolerances.
- Synthetic translations/rotations and real handheld brackets meet a recorded registration residual threshold; parallax and low-overlap sequences are either corrected within that threshold or explicitly rejected.
- Annotated foliage, people, water, occlusion, and clipped-reference sequences verify deghosting, reference selection, correction overlays, and source override behavior with region error measurements.
- Rebuilding from retained sources and manifest reproduces the master within the recorded deterministic tolerance; a source deletion preserves normal merged editing/export but accurately reports re-merge limitations.
- Cancellation and injected crashes at every publication boundary, disk-full, source deletion races, system Trash failure, and restart recovery leave no incomplete catalog assets or lost originals.
- Merge review is keyboard accessible; UI/MCP recipes agree; inherited edits/history/export and cache eviction work. Measure peak memory and time by dimensions/bracket count without weakening preview gates.

## References

- [Managed library and deletion](../../README.md#select-and-delete-photographs), [library implementation](../../src/main/library.ts), and [RAW contracts](../raw-processing.md).
- [HDR master storage](hdr-processing.md), [local mask coordinates](local-adjustments.md), and [verification policy](README.md#evidence-and-acceptance-policy).
