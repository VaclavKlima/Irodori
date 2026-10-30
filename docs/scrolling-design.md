# Continuous scrolling and workspace recovery

Continuous scrolling is the default for collections in Irodori. Future collections must use the shared collection controller and declare their identity and ordering, availability, selection semantics, loading and retry behavior, recovery state, and focused verification. Do not add page-number controls or a separate pagination engine. Bounded transport chunks are not UI pages.

## Collection behavior

Editor Photos, grouped Library, import review, and task errors have independent native scrollbars. Their scroll extents represent the entire known collection. Discovery increases the import extent as records become known. Virtual rows render the viewport plus two overscan rows, with stable placeholders for records still being read. Card dimensions never grow to accommodate a cache limit. Task errors use measured, fully readable rows in a separate area capped at 240 pixels; measurements of hidden rows are ignored.

Scrolling never changes selection, browser focus, or the active preview. Explicit navigation reveals its destination at the nearest edge. Selected IDs, the range anchor, Editor active photo, browser focus, and pending selection operations are independent of the record cache. Eviction changes none of them. Whole-group and range operations resolve all current members across loaded and unloaded records.

Editor arrows select and preview immediately after the destination record is available. Shift extends the inclusive range; Ctrl/Cmd navigation moves focus without replacing selection, and Space toggles the focused item without changing the preview. Home, End, PageUp, and PageDown work across unloaded records. Library retains focus-first navigation, Enter to edit, and Space to toggle selection. Import navigation moves checkbox focus; Space retains native checkbox behavior. Forms, menus, Console, and preview gestures retain their own shortcut scope.

Capture scroll anchors as stable IDs, pixel insets, and lightweight neighboring IDs. Imports, stack mutations, discovery prepends, regrouping, and viewport changes relocate the anchor before restoring its inset. A removed Editor member resolves through its cover; otherwise use the closest surviving neighbor or bounded former index. Folded Library sections retain their heading identity. Delayed restoration checks a scroll generation so it cannot replace newer user scrolling. Follow arrivals only at the top when no item has been focused. Task-error scroll positions and disclosure state survive closing and reopening details within the session.

## Shared machinery and resource policy

`collections/controller.ts` provides bounded record caching, request deduplication, priority upgrades, cancellation, generations, and serialized refreshes. `collections/layout.ts` provides grid and measured-row adapters, viewport windows, nearest-edge reveal, and ID anchoring. Library uses its grouped layout adapter; Editor and import review keep their existing card proportions. `collections/thumbnails.ts` owns shared decoded thumbnail references and the decode queue. Effect setup resumes refreshes and checkpoints after cleanup, including development Strict Mode's lifecycle checks. No dependencies are added.

Main chooses one policy from physical memory and logical CPU count and exposes it through `getCollectionPolicy`:

| Tier         | Qualification                                           | Cached records per collection | Decoded references | Concurrent reads/decodes | Forward lookahead |
| ------------ | ------------------------------------------------------- | ----------------------------: | -----------------: | -----------------------: | ----------------: |
| Conservative | Below 8 GiB or 4 CPUs; resource information unavailable |                           300 |             32 MiB |                        2 |        1 viewport |
| Standard     | Remaining systems                                       |                           600 |             64 MiB |                        3 |       2 viewports |
| Capable      | At least 16 GiB and 8 CPUs                              |                         1,200 |            128 MiB |                        4 |       3 viewports |

Visible, overscan, and keyboard-pinned records establish the minimum capacity. Visible thumbnail references establish the decoded-memory minimum. Unpinned references use their decoded width × height × 4 byte estimate and are released in least-recently-used order. This budget counts app-owned references; Chromium's DOM, textures, internal decoded cache, and total process memory remain outside it.

Visible records and thumbnails outrank overscan and directional lookahead. A queued speculative chunk can be promoted without starting a duplicate read. Reversal replaces the demand set and cancels obsolete queued or decoding work. Query changes, closing, hiding, and covering a collection stop speculation. Synchronous main-process metadata reads already admitted to IPC finish, but cancelled generations cannot publish their responses. Record failures retain placeholders and a keyboard-accessible Retry action. Thumbnail failures expose Retry thumbnail without disabling the photograph or import checkbox.

Review thumbnail priority replaces one bounded visible/lookahead set with a monotonically increasing generation. Delayed priority messages cannot replace newer demand. Closing cancels outstanding work and drains the existing lightweight/RAW workers before staging removal. Their worker counts and import foreground admission remain unchanged.

## Typed coherent reads

Transport chunks contain at most 60 records, using `COLLECTION_CHUNK_SIZE`. Metadata/window reads do not decode originals.

Gallery summary, chunk, and location reads use both catalog and stack revisions. Main caches a lightweight ID/order/membership projection under this pair and bulk-loads full Photo records only for requested chunks. `listGallery`, bounded flat MCP lists, and stack member reads remain compatible. Complete ranges and group snapshots retain their existing transaction and revision semantics. The unused flat `locatePhoto` and `getPhotoRange` bridge operations are removed. Editing MCP adds `irodori_get_gallery_summary` and `irodori_get_gallery_chunk`.

Import review has separate ordering, content, and selection revisions. Indexed chunk and location reads require the ordering revision. Content revisions are accepted monotonically, without requiring equality with a concurrently updating global summary. Discovery changes ordering; thumbnail and selection updates do not. Events coalesce into serialized summary and current-window refreshes, with one follow-up when a read is dirtied. Optimistic selection applies once to summary totals and separately to each row's selection revision.

## Restart and crash recovery

Catalog migration 16 creates versioned workspace scalar state and normalized selected-photo rows transactionally. `getWorkspaceState` revalidates references against current catalog metadata and prunes deleted IDs. `saveWorkspaceState` commits scalar changes and selection deltas together and acknowledges only after commit. Scrolling does not rewrite the selection, create photo-history entries, or advance catalog/stack browsing revisions.

The renderer hydrates before initial defaults or persistence can overwrite recovery. A fixed, coalesced 500ms interaction throttle checkpoints changes without postponing saves during continuous input. Normal shutdown flushes pending selections and workspace changes. Recovery starts from the last completed checkpoint, normally within one second under normal operation; abrupt termination during a pending save can lose changes since the previous commit. Storage failures remain nonblocking and show a concise Retry status. A failed or unavailable renderer cannot guarantee a shutdown flush.

Recovery includes Editor/Library mode, independent active and focused photo IDs, intentionally empty or populated selection, range anchor, Library search/grouping/folds, independent photo-list ID/inset anchors, Console visibility, and the active photo's view. Fit/manual scale and normalized image center are restored after authoritative decoded dimensions arrive and constrained to the current viewport. Navigating to a different photograph still starts in Fit.

Menus, dialogs, pointer gestures, comparison overlays, import review, and task details start closed or reset after restart. Import operations are not resumed automatically. Task-error positions are session-local. Physical display output, OS file pickers, other platforms, and processing performance are separate verification boundaries.

## Verification

Register and select `continuous-scroll-model` (Node), `continuous-scroll-context` and `workspace-recovery` (service), and `continuous-scroll-ui` and `workspace-recovery-ui` (Electron). Cover policy boundaries, deduplication/priorities, reversal, jumps, cache eviction/revisits, pins, decoded references, cancellation/failure/retry, stale responses, discovery prepends, optimistic selection, complete groups/ranges, deletions, focus, and over 60 measured errors.

Recovery coverage includes migration rollback/idempotence, large incremental selections, checkpoint cadence, startup hydration, normal and abrupt exit, deleted anchors, independent workspaces, and authoritative zoom dimensions. Run affected Library, stack/group/range, action, merge reveal, import/device/missing/progressive review, thumbnail, background import, deletion, workspace, migration, and editing MCP targets in focused groups. Inspect an isolated `dev:mcp` profile at native 1100 × 700 with Console open and at larger sizes, and remove its processes/profile afterwards. This feature does not select a full checkpoint, processing benchmarks, or new HDR certification.

## Local acceptance — 2026-10-14

[Focused acceptance evidence](../artifacts/verification/2026-10-14T11-02-13.798Z-scrolling-acceptance-r0ftwx5d/summary.md) consolidates 437 distinct passing cases across 68 registered targets, including cheap Node coverage. The five new targets contribute 20 model, 2 collection service, 3 recovery service, 3 scrolling UI and 3 recovery UI cases. The final affected model/UI group passes 240 cases in 58.14 seconds; the service/migration group passes 319 in 28.00 seconds. Earlier desktop groups retain their routine budget warnings and all assertions. Latest selected-file results pass for every affected target.

[Isolated `dev:mcp` inspection](../artifacts/verification/2026-10-14T10-58-14.343Z-continuous-scroll-inspection-QSVBF8/summary.md) verified native 1100 × 700, 1280 × 800 and 1440 × 900 with Console open. Visually reviewed screenshots cover Editor/Library scrolling, loaded import thumbnails, keyboard navigation, 125 real failed-import errors in the independent 240px scroller, and restart with a deep ID/inset anchor, selected photograph, Console and 200% zoom. Development Strict Mode inspection also verified refresh and automatic checkpoint resumption after cleanup. The actual profile path was checked before interaction; temporary profiles and owned processes were removed.

This is local macOS evidence. Native picker responses were supplied by the harness; physical device/native picker/real Trash integration and Windows/Linux clients remain separate boundaries. The native display constrained the 1920 × 1080 inspection, so larger manual sizes used 1280 × 800 and 1440 × 900; automated workspace regressions retain larger-window coverage. No comprehensive checkpoint, processing benchmark or new HDR certification was selected.
