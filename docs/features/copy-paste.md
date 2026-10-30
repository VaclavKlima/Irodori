# Selective copy/paste and batch edits

Goal 1 provides a session-local copy of confirmed edits and a bounded application
job. Named presets remain Goal 2 work. The shared Actions/context menu serves
Editor and Library; Library uses browser focus without changing the active Editor
photo. Selection paste includes unloaded, folded and filtered-out selected photos.

## User workflow

1. Choose **Copy edits** on the source photo. Pending numeric edits must finish
   saving; finish or cancel an active crop before continuing.
2. Select destinations and choose **Paste edits…**. The chooser identifies the
   copied source, complete destination count, selected groups and known
   incompatibilities. Cancel changes no photos.
3. Choose **Apply edits**. Task details retain progress, issue filenames and
   per-photo outcomes. Each changed photo gets one ordinary Undo/Redo step;
   unchanged photos get no new history entry.

Light, Saturation/Vibrance, the eight-range mixer, three-way grading, noise
reduction and detail sharpening are selected by default. Crop/straighten, white
balance and lens corrections require an explicit choice. White balance needs the
same verified single-RAW camera-profile identity; merged/gain-map sources are not
eligible. Lens transfer copies supported on/off choices into the destination's
own verified profiles, never calibration tables. Crop/lens geometry passes the
existing authoritative validation before a history change is published.

Copying freezes settings at that moment. Later source edits, source deletion or
another copy cannot change an already prepared job. The clipboard survives a
renderer reload, and clears on application restart. Accepted job results and
applied photo histories survive restart independently.

## Ownership and execution

`src/shared/edit-transfer-controls.ts` defines explicit groups/defaults and the
capabilities exposed through `getEditCapabilities`. The main process owns copied
settings and camera compatibility facts; the renderer receives source metadata
and preparation IDs. Requests use managed photo IDs, never paths.

Preparation flushes destination edits and freezes ordered IDs and committed
revisions. A later destination change is a per-photo conflict and is not
overwritten. Unsupported or missing targets remain in the frozen list and report
an explicit result. Source processing identity, originals, durable masters and
unselected setting groups stay destination-owned.

One job applies one photo at a time through the existing foreground scheduler,
with interactive work taking priority between photos. Default groups are metadata
operations; they do not render every destination. Optional geometry uses the
normal source-validation path. Preview refresh and image computation keep the
existing processing backends, GPU support, resource admission and caches.

For a changed photo, the catalog writer commits history, the success marker and
progress counts in one transaction. A rejected or duplicate marker rolls back the
history too. No-op markers revalidate the destination revision and settings without
adding a snapshot. Per-photo result pages use the shared collection chunk size.
Cancellation drains an admitted photo and stops later admissions. Shutdown stops
admission immediately and awaits durable task completion before closing workers
and the catalog. Interrupted jobs retain completed results and identify unfinished
photos; they are not replayed automatically after restart.

Limits are explicit: 100,000 destinations per job, one active/admitting job, two
concurrent preparations, eight retained preparations, at most 100,000 prepared
targets across retained grants, and a 15-minute preparation lifetime. Job targets
are stored by ordinal, so each publication does not parse or rewrite the complete
selection. The additive application journal has its own version; photo settings
remain v11 and catalog schema 21. Startup checks unsupported job formats before
migration/recovery writes.

## API and menus

The typed preload operations and corresponding `irodori_` MCP tools are:

| Application operation       | MCP tool                               |
| --------------------------- | -------------------------------------- |
| `getEditClipboard`          | `irodori_get_edit_clipboard`           |
| `copyEdits`                 | `irodori_copy_edits`                   |
| `preparePasteEdits`         | `irodori_prepare_paste_edits`          |
| `disposePastePreparation`   | `irodori_dispose_paste_preparation`    |
| `startPasteEdits`           | `irodori_start_paste_edits`            |
| `getEditApplicationResults` | `irodori_get_edit_application_results` |

Existing task list/cancel/dismiss/error APIs handle edit-application jobs. Outcomes
include applied, unchanged, conflict, unavailable, failed and unfinished states.
The same main-owned service handles UI and MCP; neither transport accepts an
arbitrary settings snapshot as a copied-edit capability.

Menu commands are `photo-copy-edits`, `photo-paste-edits` and
`selection-paste-edits`. Copy targets focus; photo paste targets that one photo;
selection paste awaits the shared pending-selection queue and freezes the full
selection. Equal photo/selection paste targets retain the selection command.
Paste is hidden until a copy exists and explains temporary recovery/admission
blockers. Generation guards prevent late actions from opening a dismissed chooser.

## Verification boundary

Registered targets are `edit-transfer-model` (Node), `edit-transfer` (service),
`edit-transfer-ui` (hidden Electron) and `edit-transfer-visual` (exclusive
Electron). The visual target requires foreground on Wayland because hidden native
captures remain pending there; captures retain their assertions and never use an
automatic visible fallback.

The [local ledger](../../artifacts/edit-transfer/20261029T072040Z/summary.md)
retains tests, failures, fixes, source hashes and launch cleanup. Focused evidence
covers generated PNGs, frozen settings/selections, conflicts, one-step history,
Undo/Redo, cancellation, atomic publication, restart, bounded result chunks,
UI/MCP parity and native minimum-size Console-open composition. The later
[combined real-source checkpoint](professional-editing-processing.md#goal-1-combined-real-source-correctness--2026-10-29)
adds actual Sony RAW, photographic raster, encoded ISO gain-map and genuine v4
merge copy/paste, history, frozen enlarged export and restart checks. Photographic,
full-size resource and performance gates remain open. Both editing goals remain
active; masking is outside this milestone.
