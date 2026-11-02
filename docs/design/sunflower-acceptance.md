# Sunflower application adoption — 2026-11-02

The application adopts the approved [prototype](prototype.html) through the
[design system](../design-system.md), checkout-discoverable
[Irodori UI skill](../../.agents/skills/irodori-ui/SKILL.md), shared tokens and
presentation controls. The prototype and historical handoff remain unchanged.
This is focused macOS migration acceptance for #33/#34, with desktop identity
limits retained under #21. It is not a comprehensive processing checkpoint.

## Delivered behavior

- Bundled, licensed Lato 400/600/700 and Sunflower semantic colors, borders,
  focus, disabled/busy/error states and reduced motion across Editor, Library,
  import/device review, export, merge, paste/delete/resource dialogs, menus,
  task feedback, empty/loading/error states and the disconnected xterm Console.
- Light, Color, Detail, Geometry and Info rail; Basic/Mixer/Grading inside Color;
  crop/straighten and lens corrections inside Geometry; resizing stays in Export.
  Inactive panels stay mounted. Navigation flushes valid drafts and creates no
  photo history. Invalid text, external revisions and crop guards retain their
  existing ownership. Light/Basic/persistent controls are checkpoint defaults.
- Pinned collapsible histogram with a graph at least 240 × 96px. Photos is 224px;
  inspector is 368px or 344px at the native minimum; the labelled rail is 52px.
  At 1100 × 700 with Console open the photograph stage is 500 × 429px and its viewport is 474 × 403 CSS pixels.
  Panel scrollers remain independent and every rail label stays reachable.
- 56px photo rows with 60 × 44px thumbnails and two-column expanded-group tiles.
  Revision-bound group spans come from the cached catalog projection. Source
  indices still own fetching, selection and anchors; visual rows/pixels own
  directional navigation and paging. Show current expands/reveals the active
  photograph without replacing selection or overriding later navigation.
- Compact floating photograph actions/navigation/view controls retain the existing
  canvas and processing owner. Pointer hover, keyboard focus, menus and dialogs
  preserve access; coarse pointers keep controls visible. Footer feedback shares the right capsule; long errors ellipsize with a full
  accessible description while Retry remains visible, without changing the photograph's viewport.
- Light, Color, Detail and Geometry resets use one existing edit-service patch
  per committed reset and share Undo/Redo. Supported As Shot/reference white
  balance, automatic available lens settings and fixed merge corrections are
  preserved. Delayed resets cannot affect a newly selected photo. Mixer/Grading
  retain their scoped resets.
- Little Jizō originals/provenance are preserved; deterministic PNG/ICNS/ICO
  derivatives, runtime window/Dock identity, unsigned host-native packaging and
  an optional user-local Linux launcher are implemented. See
  [desktop integration](../desktop-integration.md).

## Literal prototype fidelity correction

The initial migration checks below established functional behavior, but the
owner's visual review found that the first implementation did not reproduce the
prototype's composition. The corrective pass treated the final rendered
Sunflower cascade as the authority and updated the design guide **after** the
application was matched and visually compared.

The correction includes the 48px header, 10px/8px gutters, bordered photograph
stage with 12px padding, 157px pinned histogram, fixed 40px rail buttons, group
titles with top-right resets, exact Light/Basic/Mixer/Grading/Detail/Geometry/Info
composition, one Photos group border and bottom selection controls. Preview
commands use the filename/badge/Undo/Redo/Toggle hover/More menu and two 26px
bottom capsules. Display mode, crop and comparisons remain reachable through
the badge. Dialogs use the prototype's 460px/22px/5px primitives; larger import
and merge review layouts retain their necessary grids and workflows. Console
uses the compact heading, canvas background, monospace output and leftmost
status-bar action. Superseded App presentation rules were removed.

The application uses the selected bundled Lato weights. CDP inspection showed
that the unmodified prototype falls back to `.SF NS` on this Mac. Matching
screenshots temporarily load the same committed Lato files into the reference
page and hide only the 44px study toolbar; the retained HTML is unchanged.
Photographs, ordering, real histogram data, supported controls and task feedback
remain production data rather than the prototype's static sample state.

The registered `sunflower-fidelity` target checks measured stage/viewport sizes,
header/panel/rail/histogram dimensions, reset placement, 28px menu icons, 24px
hover toggle, the native compact zoom selector and the first Light slider's
position. It captures all seven tool views at 1100 × 700 and 1440 × 1000 with
Console open. Reduced motion and settled frames make these screenshots suitable
for comparison. Reference render scripts and screenshots are ignored under
`artifacts/verification/sunflower-fidelity/`.

Focused checks also exposed and corrected xterm measuring its padded container,
a presenter clearing the canvas's hidden state before a source existed, and the
Photos reveal calculation omitting its 9px scroll inset. The canvas remains
mounted, numeric rendering and processing APIs are unchanged, and source/error,
Retry, selection and history assertions remain intact. Preview tests now choose
a genuinely height-constrained Fit scenario, a pannable zoom before testing
queued pan cancellation, integral native wheel coordinates, and renderer
activation when preserving held Control across loading. These setup corrections
retain the original geometry and recovery assertions.

## Evidence and limits

All application tests used verified disposable profiles. Original fixture bytes,
photo-edit schemas, processing APIs, user-library paths, sandboxing and the typed
bridge were preserved. No processing benchmark or comprehensive suite ran.

| Selection                                                                                                                                            | Result                                                                                                                                                                        | Local evidence                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adjustment-wiring`, `gallery-layout`, initial `inspector-navigation`                                                                                | 850 passed, zero failed, 52 platform-gated skips; 49.94s                                                                                                                      | `artifacts/verification/2026-11-02T08-02-56.658Z-check-WpmRC0/summary.md`                                                                                                                                                                                                                |
| Inspector disclosures, workspace recovery, collection/context scrolling, stacks, creative color, decimal input, lens UI, desktop assets              | 868 passed; one asynchronous group assertion corrected, then that case passed in 9.4s; 52 platform skips                                                                      | `artifacts/verification/2026-11-02T08-08-11.813Z-check-nMQvnx/summary.md`; corrected rerun under `artifacts/verification/playwright-1793607006526-ff7d5c53-1cf2-4b59-adf5-a546b653f26c/`; canonical case is `stack-ui: separate keyboard expansion preserves active photo and selection` |
| Import/device review, export, merge, paste/delete, menus, resource settings, comparison                                                              | 35 cases passed initially; four failures were corrected and individually passed on rerun (three in 34.2s together with the still-failing comparison, then comparison in 4.4s) | `artifacts/verification/2026-11-02T08-11-19.543Z-check-iDkgEY/summary.md`; `playwright-1793607335510-79f9262e-a970-4f34-bc8e-3569a280bd15`; `playwright-1793607438437-c988bb4c-f6f4-4018-8c8d-4cb311645b08`                                                                              |
| Final `inspector-navigation`, `mixed-collection-ui`, `all-photos-ui`, `white-balance-ui`, `detail-application-ui`, `workspace`                       | 871 passed, zero failed, 52 platform-gated skips; 108.07s; all eight stages passed                                                                                            | `artifacts/verification/2026-11-02T08-33-34.455Z-check-0Aei6S/summary.md`                                                                                                                                                                                                                |
| Actual unsigned packaged macOS startup, offline Lato FontFace, Sony embedded import, exact shipped worker/Node decoder fallback, restart and cleanup | One foreground case passed in 16.4s (16.9s invocation)                                                                                                                        | `artifacts/verification/playwright-1793609048232-888d14b6-1e09-4157-b3e2-37df645a5b4e/`                                                                                                                                                                                                  |
| Final shared-button cleanup: `merge-ui`, `resource-settings-ui`                                                                                      | 10 cases passed; 34.7s                                                                                                                                                        | `artifacts/verification/playwright-1793609462384-f3a85b08-3eb5-421a-936e-59c646ab2b40/`                                                                                                                                                                                                  |
| Final fast stages plus `desktop-package --foreground`                                                                                                | 843 passed, zero failed, 52 platform-gated skips; 49.98s; all six stages passed                                                                                               | `artifacts/verification/2026-11-02T08-52-21.693Z-check-59Cpcf/summary.md`                                                                                                                                                                                                                |

### Corrective checkpoint evidence

| Selection                                                                                                                        | Result                                                                                                                                                                                                         | Evidence                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Editor core: `adjustment-wiring`, `comparison-ui`, `full-preview-ui`, `inspector-navigation`, `mixed-collection-ui`, `workspace` | Normal Electron stage passed; three preview test-setup failures in the same invocation were corrected and covered by the final foreground run below                                                            | `artifacts/verification/2026-11-02T09-46-25.344Z-check-rX33sv/summary.md` |
| `export-ui`, `merge-ui`, `edit-transfer-ui`, `photo-actions`, `import`, `resource-settings-ui`, `sunflower-fidelity`             | 870 passed, zero failed, 54 skipped; 102.22s; all seven stages passed. Two native deletion cases deferred here passed in the next foreground stage                                                             | `artifacts/verification/2026-11-02T09-57-08.233Z-check-pHaZQg/summary.md` |
| Native `photo-actions`                                                                                                           | All six cases passed, including Delete/Backspace and protected form/Console focus. The invocation's independent pointer-coordinate assertion was corrected and passed on exact rerun and in the final run      | `artifacts/verification/2026-11-02T10-08-02.244Z-check-p7OL3A/summary.md` |
| Final `preview`, `sunflower-fidelity`, `desktop-package --foreground` plus fast checks                                           | **851 passed, zero failed, 52 platform skips; 80.17s; all seven stages passed.** Native zoom/pan/capture/keyboard, both layout sizes, offline packaged RAW import, shipped decoder fallback and restart passed | `artifacts/verification/2026-11-02T10-13-05.107Z-check-RAvA79/summary.md` |

Final screenshots for all seven tool views at both sizes are in the final run's
`functional/electron-exclusive/results/sunflower-fidelity-matches-00d4b-um-and-larger-content-sizes-electron/`
directory. The unsigned rebuilt application is
`dist/Irodori-darwin-arm64/Irodori.app`. These artifacts remain ignored. The
corrective multi-family batches exceed the routine 60-second warning budget;
individual checks retain their full assertions and the runner records the slow
cases. No comprehensive suite or processing benchmark was added.

The 52 routine skips are platform-gated fast contracts, including Linux native
helper resolution. The runner correctly reports **incomplete / exit 2** even when
all selected stages pass; these runs are not described as complete cross-platform
passes. The 108-second batch exceeds the routine 60-second warning budget because
it selected several UI families; its slowest case was 7.22s. Assertions were not
removed or cut short. Earlier failures and diagnostic runs remain in artifacts.

The initial review inspected production Editor/RAW layouts, custom export and
deletion screenshots; it did not establish literal prototype fidelity. The
corrective comparison above supersedes that visual conclusion. Native minimum-size and Console checks
also passed at 1280 × 800, 1440 × 900 and 1920 × 1080. A separate packaged visual
session verified its profile path before importing an existing photograph, exposed
all five rail labels through native accessibility, then closed and removed its
profile. Its evidence is `artifacts/verification/sunflower-desktop-visual/`.

Finder showed the packaged Little Jizō icon and Irodori name. Native Dock and
application-switcher visual acceptance remain incomplete: computer-use screenshot
inspection timed out. Runtime Dock icon configuration and embedded ICNS bytes are
verified separately; they do not substitute for that visual acceptance. Bazzite
launcher/dock and Windows runtime presentation are unavailable on this host.
Keep these criteria open under #21. The local `.app` is unsigned; public installers
and signing remain outside this migration.

## Cleanup before publication

Removed unmatched and superseded presentation rules, unused token aliases and
slider properties, the ignored `InspectorSection.icon` API, redundant Console
state styling, and the duplicate Detail hint stylesheet. Library checkboxes and
white-balance sample-size selection now inherit Sunflower colors rather than
old local overrides. Current testing and asset guidance reflects the implemented
design; the approved prototype, dated evidence and original asset provenance
remain intact.

The picker and crop component fixtures now bundle the actual global stylesheet,
tokens and local fonts through their existing esbuild path. The focus-loss case
waits for asynchronous picker activation before dispatching blur. Existing edit,
cancellation and history assertions remain unchanged.

Final cleanup selection: `sunflower-fidelity`, `all-photos-ui`,
`white-balance-picker-ui`, `crop-editor-ui`, plus fast checks. All seven stages
passed: **860 passed, zero failed, 52 platform skips in 70.8s**. The runner marks
this incomplete because the platform-only contracts remain unavailable on this
Mac. The routine budget warning reflects the selected UI families; assertions
were neither removed nor cut short. Evidence:
`artifacts/verification/2026-11-02T11-04-58.324Z-check-YDbJMR/summary.md`.
