# Named per-photo edit checkpoints

[Issue #61](https://github.com/VaclavKlima/Irodori/issues/61) owns saved editing
versions and matched inspection of earlier passes. Checkpoints belong to one
managed photograph. Cross-photo presets and temporary edit variants retain their
separate owners.

## Save, compare and restore

Open **Versions** between Presets and Info. **Save checkpoint…** captures every
confirmed setting, including crop, lens corrections, white balance, curves,
denoising, sharpening and the complete local mask stack. Finish or cancel an
unfinished crop or mask creation first. Valid pending adjustments flush through
the normal edit owner before capture.

Names contain 1–100 trimmed characters without control characters and are unique
per photograph using normalized, case-insensitive comparison. A saved version's
contents are immutable. Rename changes only metadata; save another name to retain
a later pass. Selecting a row does not apply its settings.

Choose A and B explicitly from saved checkpoints or **Current edits**, then use
**Compare**. Current is frozen at comparison start. A/B switching and a draggable
split share one native coordinate grid, zoom and pan. Comparison starts at 100%
around the existing center; one decoded photograph pixel equals one CSS pixel.
Fit and the existing zoom controls remain available. Different crop, rotation or
geometric lens corrections produce an explicit incompatibility message.

Comparison is read-only and does not add history. Editing, Undo/Redo, pickers,
mask overlays, clipping and histogram analysis remain unavailable while it owns
the preview. The preview's `\` switches A/B and `Y` toggles split; forms, native
pickers and Console retain their input owners. **End comparison** restores the
live preview and its previous view. Navigation or source changes retire the
session. Comparison does not reopen after restart.

**Restore selected** publishes the entire saved settings document as one ordinary
Undo step. Undo returns to the preceding complete edit; identical settings add
none. Restore creates no automatic checkpoint and never overwrites a saved one.
The row menu provides Rename and confirmed Delete. Deleting a checkpoint leaves
current settings, Undo/Redo and already restored edits intact.

## Ownership and persistence

The catalog writer owns the independently versioned checkpoint store. Each record
contains its photo ID, stable checkpoint ID, name, metadata revision, timestamps,
captured photo revision and complete settings. Checkpoint management does not
increment the photograph's edit revision. Photo revisions are freshness checks
and provenance, not historical lookup keys.

Save captures authoritative settings and checks the expected photo revision in
one writer transaction. Restore checks both the checkpoint and photo revision
with edit publication. Failed writes preserve the previous store. Startup
validates existing records before migration/recovery writes; future settings
migrations include checkpoint settings without changing historical provenance.

Mask content remains in the existing photo-scoped, immutable store. Checkpoints
retain brush chains, generated bases and compound references independently of
Undo branching. No preview images are copied into records, no checkpoints are
automatically evicted, and this feature introduces no mask garbage collection.
Successful photo removal deletes its checkpoint rows; interrupted Trash recovery
preserves them with the owning photo.

## Typed API and Console

The typed application bridge and MCP expose list/get/create/rename/delete/restore
operations. MCP names use `irodori_*_edit_checkpoint`, with
`irodori_list_edit_checkpoints` for listing. Mutations use explicit photo IDs;
checkpoint metadata revisions remain separate from `expectedRevision`.

`prepareEditComparison` / `irodori_prepare_edit_comparison` receives explicit
`baseline` and `target` sources:

```json
{
  "baseline": {
    "kind": "checkpoint",
    "checkpointId": "saved checkpoint UUID",
    "expectedCheckpointRevision": 1
  },
  "target": { "kind": "current", "expectedRevision": 4 }
}
```

Preparation returns an opaque comparison ID, labelled exact snapshot identities
and a common native-grid context. `irodori_get_edit_comparison_preview` receives
that ID, the photo ID and normal inspection region/resolution/encoding options.
It returns two labelled image members, A and B, with their exact checkpoint or
frozen-Current identities. `irodori_dispose_edit_comparison` releases the session.
Managed handles belong to the frozen request and cannot be reused in later turns
or for another photograph. Identified checkpoint deletion follows the same
explicit user-instruction/agreement rule as preset deletion.

Pairs share region, resolution, encoding and rendition and publish only after
both pass final validation. Existing native inspection retains full spatial
filter context and 8 MiB/image, 16 MiB/pair limits without silent reduction.
Deleted/renamed checkpoints, changed frozen Current, unavailable originals and
missing immutable mask data fail explicitly. Neutral Before remains its existing
neutral rendition and never substitutes for an earlier editing pass.

Desktop comparison uses two ordinary production presenter surfaces with frozen
per-member settings and one shared view/display target. Pair resource accounting
includes both surfaces and retiring assets; sequential preparation does not
admit each side against an independent full budget. Mismatched or pending
presentation receipts remain behind the neutral loading state. GPU failure
reports its reason and uses the existing Retry GPU/disposal path.

MCP delivers explicitly labelled SDR renditions. True HDR client qualification
remains in [#82](https://github.com/VaclavKlima/Irodori/issues/82); native image
transport and HDR metadata do not establish physical luminance or model vision.

## Verification

The [focused acceptance record](../../artifacts/verification/2026-11-16-checkpoints-acceptance/summary.md)
reconciles **89 distinct passing cases across 19 affected targets** on Apple M4
Pro/macOS arm64, with per-case source reports and corrected failures retained.
Coverage includes complete masks through branching/restart, atomic restore and
Undo, conflicts/rollback, MCP schemas/ownership, native-region pixel equality,
two-slot alpha compositing, memory refusal/drain, HDR/SDR canvas transitions and
the native 1100 × 700 Console-open layout. Native screenshots were visually
inspected; Sunflower fidelity passes.

The real raster case uses defaults. Full-size Sony RAW plus Texture explicitly
refuses the Automatic 2 GiB GPU allowance; photographic qualification passes with
the isolated profile's recorded 4 GiB GPU allowance and Automatic 6 GiB RAM.
Both saved PNG regions reproduce their respective earlier rendered pixels while
Current differs. This verifies version fidelity, not a stronger grade's aesthetic
quality or a performance benchmark. Production resource limits remain enforced.

Integration checks corrected a cold Detail-source cache match that skipped
Texture preparation, shared HDR accounting/failure cleanup, display-context
replacement, paired-source publication and confirmed-edit flushing during
comparison. No numerical algorithm or history-format migration was introduced.

`npm run check` reports 1,078 passed, zero failed and 34 Linux-only skips in
42.97 seconds. Type checking, lint and formatting pass; the command exits 2 for
the unavailable Linux checks and retains its fast-budget warning. Foreground
HDR composition uses actual extended float canvases with harness-supplied display
capability, not measured luminance. Live-model behavior remains unverified.

Bazzite qualification remains [#126](https://github.com/VaclavKlima/Irodori/issues/126)
and Windows x64 remains [#127](https://github.com/VaclavKlima/Irodori/issues/127).
Physical HDR remains #83 and true HDR agent transport remains #82. No comprehensive
checkpoint or processing benchmark is claimed. Default-branch delivery and issue
completion are recorded in [#61](https://github.com/VaclavKlima/Irodori/issues/61).
