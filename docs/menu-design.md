# Photo menu design standard

This is the authoritative standard for toolbar **Actions** and photo context menus in Editor and Library. Extend `src/shared/photo-actions.ts` and the shared `PhotoContextMenu` renderer. Every new command must declare its stable ID, target, eligibility, temporary blockers, execution behavior, and verification coverage. Do not add an independent menu implementation or per-selected-photo IPC reads.

## Hierarchy and targets

Use a compact flat menu, ordered **Photo**, **Selection**, **Photo group**, **Library operations** (toolbar only), then **Trash**. Omit empty sections. Headings are quiet, non-interactive text, never keyboard stops. Photo shows the focused filename; Selection shows its photo count; Photo group shows total membership and original count. A photo group is a persisted stack, independent of Library's date/month/year sections. Truncate long headings visually with their full accessible text and title intact.

Editor Actions uses the active editor photo. Library Actions uses browser focus, which does not change the editor's active photo. Resolve pending selection before reading the focused photo. Context invocation on a selected photo preserves selection and its anchor; invocation on an unselected photo selects it alone. Keep focus, selection, and range anchor separate.

| Stable action ID                   | Target                                                             | Early eligibility                        | Execution                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `photo-export`                     | Focused photo                                                      | Photo exists                             | Await pending selection and editor saves, open the shared JPEG chooser for this photo       |
| `selection-export`                 | Complete ordered selection, including unloaded/filtered-out photos | Nonempty selection                       | Await pending selection and editor saves, open the same JPEG chooser for all selected IDs   |
| `photo-cover`                      | Focused member                                                     | In a group and not already its cover     | Set cover with group revision                                                               |
| `photo-remove`                     | Focused member                                                     | In a group                               | Remove membership with group revision                                                       |
| `selection-group`                  | Ordered selection                                                  | At least two photos, all ungrouped       | Group using gallery revision and a selected cover                                           |
| `selection-hdr`, `selection-noise` | Ordered selection                                                  | 2–32 original ARWs                       | Open merge review                                                                           |
| `group-select`                     | Every current group member                                         | Group differs from the selected ID set   | Replace selection through its queue, preserve anchor                                        |
| `group-hdr`, `group-noise`         | Current group originals, persisted order                           | 2–32 originals, every original ARW       | Revalidate group revision, open merge review                                                |
| `group-ungroup`                    | Current group                                                      | Persisted group exists                   | Ungroup with group revision                                                                 |
| `library-scan`                     | Managed catalog                                                    | At least two original ARWs; toolbar only | Start existing capture-sequence scan                                                        |
| `photo-trash`                      | Focused photo                                                      | Photo exists                             | Freeze filename, confirm, use system Trash                                                  |
| `selection-trash`                  | Complete shared selection, including unloaded photos               | Nonempty selection                       | Await selection, freeze all filenames, confirm, use system Trash                            |
| `group-trash`                      | Every group member, including previous results                     | Group exists                             | Await selection, revalidate group revision, freeze all filenames, confirm, use system Trash |

## Eligibility and equivalence

Hide structural mismatches and no-ops: unsupported merge formats, derived selection inputs, merges below two or above 32 original inputs, invalid manual grouping, current cover, and exactly selected groups. Never silently omit unsupported originals from a group merge. Detailed camera, exposure, capture and compatibility checks belong to merge review.

Deduplicate photo/selection Export by equal ID sets, retaining selection. Export commands open the same chooser and remain available during background import or export; source leases only block Trash. Deduplicate photo/selection and group/selection Trash by equal ID sets, retaining selection. Deduplicate merges only when their ordered original inputs and behavior match; the shared review has identical defaults for both scopes. A differently ordered selection or a selection containing earlier results keeps the originals-only group merge distinct. Photo/selection Trash and group merge equivalence are independent.

Keep applicable commands temporarily blocked by task admission, recovery or source leases visible and keyboard-focusable with `aria-disabled`. Show each distinct reason once in subdued status text; affected commands reference it through `aria-describedby`. Main uses the same admission checks as mutations. Background import blocks organization but permits requested foreground merge and Trash work. Merge review/source leases block new review creation and Trash of leased sources. Pending menu work shows one “Working…” status and rejects repeated activation.

## Labels and presentation

Use sentence case, 16-pixel Lucide icons, 12-pixel command text, at least 32-pixel rows, neutral hover/focus feedback, restrained separators, and subdued destructive color. Keep width between 270 and 350 pixels, scrollable height within the native window, and eight-pixel margins. Focused items scroll into view. Only commands requiring further input or confirmation end in an ellipsis. The existing scan starts immediately: **Group capture sequences**.

All Trash commands occupy the separate bottom section:

- **Move this photo to Trash…**
- **Move selected photo to Trash…** or **Move N selected photos to Trash…**
- **Move entire group to Trash (N photos)…** (use “photo” for one)

Confirmation titles are **Move photo to Trash?** and **Move N photos to Trash?**. Disclose every frozen filename in the bounded keyboard-scrollable list. Focus Cancel initially. Preserve the managed-bundle/system Trash flow, removal journals, foreground scheduling, cancellation, and recovery. Delete/Backspace always targets shared selection, including while a group command is focused or awaiting resolution.

## Keyboard and asynchronous behavior

Follow the [W3C menu pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) and [menu-button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). On ordinary opening, focus the first enabled non-destructive command; fall back to enabled Trash, then a disabled command or the empty menu. Actions exposes `aria-haspopup`, expanded, controls, and busy states. Down opens at the first command; Up opens at the last.

Use one roving tab stop, wrapping Up/Down, Home/End, Enter/Space activation, and case-insensitive prefix typeahead with a one-second reset. Repeated single letters cycle matching commands. Disabled commands remain focusable and cannot run. Escape restores invocation focus. Tab/Shift+Tab closes and continues normal traversal from that invocation point. Outside pointer presses close without moving focus away from the clicked control.

`getPhotoActionsContext(photoId: string | null, selectedIds: string[])` and editing MCP `luma_get_photo_actions_context` read canonical references, gallery/catalog revisions, counts, target equivalence, and per-operation `applicable`, `blocked` (reason), or `inapplicable` availability. The main-process owner makes at most six bulk catalog reads including recovery admission, regardless of selection size. It uses stored fields only, without decoding originals or loading thumbnails. Large requests use the same 8 MiB transport ceiling as browse summaries. This read grants no mutation permission; existing APIs revalidate targets and revisions.

Library/task events refresh availability. Unrelated imports may change gallery/catalog revisions without changing `targetIdentity`; keep the menu open and retain focused action ID. Close on changed selection/focus, missing photos, or relevant group/membership revisions. Loading reads and pending actions have generation guards: dismissed, superseded, stale, or late results cannot reopen menus or confirmations. An event arriving during initial loading causes a fresh availability read once the menu is current.

## Representative menus

A single ungrouped JPEG has only Trash → **Move selected photo to Trash…**. Two ungrouped ARWs have Selection → **Merge selected photos to HDR…**, **Stack selected photos for noise reduction…**, **Group selected photos**; toolbar Library operations → **Group capture sequences**; Trash → focused-photo and two-selected-photo commands.

A selected non-cover member in a four-member group with one result has Photo → cover/removal commands; Photo group → select entire group, two originals-only merge commands, ungroup; Trash → selected-photo and four-member-group commands. Selecting every member hides Select entire group and group Trash. Selecting the originals in persisted order also removes equivalent group merges. A 125-member JPEG group never lists invalid merge commands or expands into individual filename rows; full filename disclosure belongs to confirmation.

## Verification and evidence

Registered targets: `photo-menu-model` (Node), `photo-menu-context` (service), and `photo-menu-ui` (Electron). Cover empty/single/mixed/derived/complete-group/large unloaded selections, ordered equivalence, bounded bulk reads, no original decoding, mouse and keyboard invocation, disabled explanations, focus/traversal, pending work, task updates, unrelated imports and stale/deleted targets. Preserve affected selection, stack, merge, workspace and editing MCP coverage. Inspect representative menus through isolated `dev:mcp` at native 1100 × 700 with Console open and temporary libraries/Trash adapters.

This change requires no catalog migration, processing change, full checkpoint, or benchmark. Platform evidence must name the verified OS; Linux-specific native select dropdown work remains backlog #10.

## Local acceptance — 2026-10-13

The [acceptance record](../artifacts/verification/2026-10-13T11-23-08.643Z-photo-menu-acceptance-322eb2/summary.md) retains 268 distinct passing cases across the three new menu targets, nine requested affected targets, and included cheap Node checks. The combined run passed 266 cases in 125.33 seconds and retained its routine budget warning. After the stale availability-error and incomplete-group guards, the final menu run passed 212 cases in 27.51 seconds; all static checks and builds passed.

Isolated `dev:mcp` inspection through the actual Playwright MCP stdio server verified Editor/Library menus at native 1100 × 700 with Console open, a complete 65-filename confirmation, Cancel focus, pointer/keyboard behavior, and subdued temporary-block styling. Screenshots were visually reviewed. Temporary-block visuals used an availability contract fixture; actual task/lease admission is covered by service and UI regressions. Temporary profiles and processes were removed. This is local macOS evidence, excluding Linux dropdown #10, Windows, native pickers, real OS Trash, processing and hardware certification. No comprehensive checkpoint or benchmark was run.

JPEG export commands use `export-model`, `export-context` and `export-ui` alongside the menu targets. Header export falls back to the active Editor/focused Library photograph only when the complete shared selection is empty. Preparation and acceptance revalidate targets and committed edits. See [the export contract](features/export.md).
