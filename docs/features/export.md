# SDR and HDR JPEG export

## Status and scope

Individual and batch **JPEG export** is implemented for the current managed-library sources. Quick presets produce ISO 21496-1 HDR JPEG for verified HDR Sony RAWs and durable merge masters and supported ISO HDR JPEGs, and SDR JPEG for ordinary raster photographs. Platform and reader evidence is recorded in [testing](../testing.md#jpeg-export). This bounded delivery does not complete the [full HDR roadmap](README.md#full-hdr-completion-checklist).

Additional formats, broader HDR file import, output sharpening, watermarks and named user presets remain planned. Disabled edit controls do not acquire export behavior.

## User workflow

Use **Export** in Editor or Library, or **Export this photo…** / **Export selected photos…** in the shared photo menu. Header export waits for pending selection operations and uses the entire selection, including unloaded and filtered-out records. With no selection, it uses Editor's active photograph or Library's focused photograph. Equivalent menu targets are deduplicated.

The chooser displays the photo count, expected HDR/SDR counts and remembered destination. Choose a destination the first time. Later quick exports start immediately in the displayed folder. **Change folder…** replaces that grant; cancelling the picker preserves the previous one. Missing, inaccessible or replaced folders require another explicit choice and never redirect automatically.

| Action          |                JPEG quality | Size         | Output         |
| --------------- | --------------------------: | ------------ | -------------- |
| Maximum quality |                         100 | Original     | Auto per photo |
| High quality    |                          90 | Original     | Auto per photo |
| Smaller file    |                          80 | Original     | Auto per photo |
| Last custom     |                       Saved | Saved        | Saved          |
| Custom…         | Integer 1–100; initially 90 | Configurable | Configurable   |

JPEG quality 100 is lossy. Quick presets retain original basenames, rename collisions automatically, and keep camera/copyright metadata without location or private camera identifiers. Last custom is saved atomically with acceptance of a Custom job; cancelling the dialog or picker and using quick presets do not replace it.

Custom offers Auto, SDR JPEG, or HDR JPEG (gain map); Original, Longest edge, or Fit within width/height; original names with an optional suffix, or a prefix with a sequence starting at 1 in frozen target order; Camera and copyright, Copyright only, or None; and Rename automatically or Skip. Aspect ratio is preserved and images are never enlarged. Explicit HDR refuses a selection containing unsupported sources with a counted explanation. Existing files are never replaced.

Progress and retained results use Background tasks: exported, skipped, failed and cancelled counts, per-file errors, cancellation, dismissal and **Show in folder**. Accepted jobs protect their sources from Trash until each file finishes. Editing, browsing, organization and background import remain available. Cancelling preserves completed output and waits for publication in progress. Quit uses the existing task confirmation and cleanup.

## Rendering and metadata

Export reads managed originals or durable merge masters with immutable committed processing settings. It has a separate Node worker and temporary working directory, independent of preview requests, display headroom and preview caches. Metadata, source identity, revisions, output settings and processing/codec versions belong to the accepted manifest. Export makes no history entries or browsing revisions.

HDR sources use the existing white balance, lens preparation, Light operators and versioned ACES 2 direct SDR / fixed Rec.2020 HDR renditions. The HDR rendition is applied once. Raster inputs use their authored color-managed SDR appearance with the implemented Light operators. Orientation is normalized once. Transparency is flattened onto white in linear light. Renditions are resized with separable Lanczos3 in linear light, preserving identical output geometry. The gain map is generated after resizing; no 8-bit preview supplies HDR values.

SDR is baseline JPEG, sRGB ICC and 4:4:4 chroma. HDR uses the same controlled SDR JPEG as its primary plus a full-resolution three-channel gain map, with alternate Rec.2020 color signaling. The supplied SDR primary must decode identically before and after HDR packaging. Color/reconstruction information survives every metadata policy. ISO-aware readers can reconstruct HDR; ordinary readers display the supplied SDR image. Gain-map XMP is disabled: the pinned encoder cannot represent both alternate gamut and independent channel metadata in that mode. See the [format matrix](hdr-file-support.md#enabled-export-variants).

The bundled encoder is **libultrahdr 2.0.2**, linked with libjpeg-turbo 3.1.0, compiled with Emscripten 4.0.20 into single-threaded Node-only WASM. Luma checks executable SHA-256 hashes before loading. RAW preparation exits before the encoder is loaded. Linear Rec.2020 binary16 input preserves values relative to SDR white. Luma's nominal 100-nit reference describes its renderer, while gain-map reconstruction is relative to the primary's white. The codec uses 203-nit units. Its target argument is 203 times the actual maximum HDR channel after resizing (bounded to 1.01×–10× white). This metadata lets a capable reader apply the full gain map whenever the content fits its display. It does not alter pixel values, normalize exposure, depend on a monitor, or change Luma's fixed nominal 1000/100 renderer. Scaling pixels by `100/203` incorrectly dims the exported HDR rendition and is no longer used. The WASM heap is capped at 2 GiB and the existing 512 MiB floating-point source bound remains. Unsupported allocations fail explicitly without changing requested dimensions. Reproducible build instructions and full notices are in [vendor/ultrahdr](../../vendor/ultrahdr/README.md).

Metadata is constructed from an allowlist before HDR packaging, never copied wholesale. Camera/copyright keeps Make, Model, LensModel, capture date, aperture, shutter time, ISO, focal length, Artist and Copyright when present. Copyright only retains Artist/Copyright. None retains required color/reconstruction information. GPS, serial numbers, camera thumbnails, MakerNotes, descriptions and internal paths are excluded. Derived merges do not fabricate camera/exposure EXIF or infer copyright from unrelated sources.

## Persistence, admission and recovery

Catalog migration **17** creates versioned preferences, persistent opaque destination grants, immutable accepted jobs, and per-file publication records transactionally. The renderer and editing MCP pass photo/preparation/destination IDs and validated options; they cannot grant arbitrary write paths. Only the main-owned native folder picker creates grants. Directory realpath, device/inode identity and access are revalidated before writing/publication and after restart.

Preparation captures target order and committed revisions without long-lived leases. Before acceptance, pending editor changes are flushed, every target/revision is revalidated and the manifest plus accepted Custom preferences are committed atomically. Subsequent edits cannot change output. One exporter processes one photograph at a time. Scheduler admission drains import preparation before expensive export work; foreground preview/edit/merge demand cancels and retries unfinished isolated rendering. Normal import preparation parallelism is unchanged when export is inactive.

Each destination file begins as a uniquely named, exclusively created owned partial in that filesystem. Luma validates, hashes and syncs the bytes, records publication intent, then uses an exclusive hard link for atomic publication without replacement. Filesystems that cannot support this operation fail explicitly. Directory synchronization is performed on Unix; Node does not provide equivalent directory fsync on Windows. Cancellation does not interrupt publication already in progress.

After an abrupt exit, running jobs are retained as interrupted. Publication intent is reconciled only when the recorded output inode and content hash match. Cleanup removes recorded partials only when their file identity still matches; foreign replacements and completed files are preserved. Missing destinations retain the interrupted evidence. Encoding and unfinished publication never resume automatically. Installer durability, network filesystems and platform-specific power-loss guarantees require separate verification.

## API and verification

The typed bridge exposes capabilities, preferences, destination choice, prepare/dispose/start, results and Show in folder. Editing MCP exposes `luma_get_export_capabilities`, `luma_get_export_preferences`, `luma_prepare_export`, `luma_dispose_export_preparation`, `luma_start_export` and `luma_get_export_results`; existing task tools cancel/status/dismiss. UI and MCP use the same application validator and job service. An application-authorized destination ID is required; MCP cannot supply a new path.

Targets are `export-model` (Node), `export-context` (service), `export-rendering` (RAW/processing) and `export-ui` (hidden Electron). Coverage includes complete selection, settings persistence, source leases, revisions, collisions, failures, cancellation/publication boundaries, restart reconciliation, metadata, orientation/alpha, linear resize, real Sony decoding, durable master input and independent gain-map reconstruction. The Float64 oracle and ISO parser use a separate JPEG reader and licensed synthetic vectors. Chart interiors require relative errors within 3% / 5% / 10% at quality 100 / 90 / 80. File correctness does not certify physical HDR display brightness. Keep broader HDR import, all-platform reader and full-roadmap acceptance open.
