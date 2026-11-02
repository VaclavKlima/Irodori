# Sunflower prototype handoff

This document retains the 2026-11-01 prototype-only handoff. Application adoption
is documented in the [design system](../design-system.md), [desktop integration](../desktop-integration.md)
and [migration acceptance](sunflower-acceptance.md).

On **2026-11-01**, the user selected **Sunflower** and the **Original Little Jizō**
icon. [prototype.html](prototype.html) is the retained design reference. Unused
layout variants and alternative icon studies have been removed from the handoff.

This deliverable contains only the HTML prototype, its notes and the selected
icon asset. Application implementation is deferred to the next session. Backlog
[#34 (shared visual language) and #33 (inspector navigation)](../features/README.md)
remain open; the prototype does not complete either item.

## Selected direction

Irodori is a professional, local photo editor. Keep the photograph dominant,
surround it with neutral surfaces and use compact, readable controls. Lightroom's
simplicity is general inspiration; Irodori keeps its own identity.

Sunflower retains the dark Silver foundation, white/grey text and visible
borders. Yellow identifies actions, focus and selected controls rather than
tinting the whole workspace.

| Role                                   | Value                             |
| -------------------------------------- | --------------------------------- |
| Photograph surround / canvas           | `#161616`                         |
| Panel                                  | `#202020`                         |
| Raised / selected surface              | `#303030`                         |
| Hover surface                          | `#3c3c3c`                         |
| Border / subtle separator              | `#606060` / `#3d3d3d`             |
| Primary / secondary / muted text       | `#f2f2f2` / `#c0c0c0` / `#acacac` |
| Action, selected-control and focus cue | `#e7c75c`                         |
| Text on yellow action                  | `#251e08`                         |

Use Lato where installed, with Segoe UI and system sans-serif fallbacks, and
tabular numbers for adjustment values. The prototype does not download or
bundle a font. Keep restrained 140ms feedback transitions and reduced-motion
support. Hover, focus, selection, busy, disabled and error states must remain
distinct; text, checkmarks and outlines supplement color.

## Workspace and controls

The composition is **Photos at left, photograph in the center, editing tools at
right and a collapsible read-only Console below**. Preserve independent panel
scrolling and usability at **1100 × 700 with Console open**.

- The Photos column is 224px wide. Manual groups retain two-column image tiles;
  individual photographs use compact 56px rows with 60 × 44px thumbnails and
  filenames beside them. Selection checks and the active photograph are separate.
  Show **Current** only for the active item, and use **Show current** to recover
  it after scrolling.
- A large, collapsible histogram stays pinned at the top right, above the tools.
  Its graph remains at least 240 × 96px at the minimum layout. It does not scroll
  away with editing controls.
- A labelled vertical inspector rail contains **Light, Color, Detail, Geometry
  and Info**, with the selected group's tools beside it. Keep Mixer and Grading
  inside Color and lens corrections inside Geometry. Resizing stays in Export.
- The Color Mixer uses **two rows of four larger range buttons**, with complete
  color names. Mixer and Grading share the same control styling as other tools.
- Filename, SDR status and actions occupy a compact floating top-left menu,
  sized to its contents. Group navigation floats at bottom left; dimensions,
  Fit and static-preview status float at bottom right.
- **Toggle hover** hides floating controls away from a desktop pointer. Keyboard
  focus, an open menu or a dialog keeps them visible. Touch/coarse pointers keep
  them visible. Turning the option off restores persistent controls.

Group controls still occupy height at the minimum size; only two complete group
tiles initially fit with the Console open. The individual rows improve scanning
without claiming to eliminate collection scrolling.

## Prototype interactions and limits

The sample collection has **24 entries made from five real photographic
originals**. Repetition is explicitly labelled UI simulation, not 24 distinct
captures. Filenames, source dimensions and image bytes are real. No camera,
capture date, shutter, aperture or ISO metadata is invented.

**Landscape studies** is a manual editorial group of `alpine-lake`,
`mountain-ridge` and `quiet-valley`, not an exposure bracket. It supports
collapse/expand, member navigation, whole-group selection, changing the cover,
ungrouping and regrouping selected photographs. Collapse preserves active and
selected items, including hidden members. Show current reveals the active item
without replacing selection.

Click a photograph to select and view it. Ctrl/Cmd-click toggles selection;
Shift extends a range. Arrow keys navigate the collection, and Home/End move to
its ends. Inspector tabs use Up/Down; ordinary Tab traversal remains available.
Numeric fields accept direct entry, Enter/blur commits and Escape cancels.
Menus support arrows, Home/End, typeahead and Escape.

Local control values, selected tones/ranges, disclosures, group state and
per-photo Undo/Redo live only in this browser session and reset on reload.
Photographs stay unchanged: no processing or export runs, no files are written
and the application library is never accessed. Dimensions and static-image
histograms follow the active source. Busy, error and retry examples in Components
are labelled samples. Unsupported tools remain unavailable; JPEG fixtures do not
pretend to support RAW white balance or verified lens correction. The Console is
disconnected and cannot execute commands.

## Selected icon

**Original Little Jizō** is the selected identity direction: a tactile pale-stone
seated figure, a round smiling face and a vermilion bib. Keep the original PNG
unchanged. Components presents it at 128, 64, 32 and 16 CSS pixels on dark/light
backgrounds. The Editor mark and application/platform packaging are unchanged.

The [original asset](../../assets/app/icons/little-jizo.png),
[provenance notes](../../assets/app/icons/README.md) and
[manifest](../../assets/app/icons/manifest.json) retain its source, generation
prompt, dimensions and SHA-256. It was generated for this project with the
built-in image tool, without supplied reference photographs or third-party
mascot artwork. Fine stone texture and facial detail merge at small sizes;
optical adjustments and platform exports belong to later adoption work.

## Open locally

Open [prototype.html](prototype.html) directly in a browser. The unchanged photo
and icon bytes are embedded, so the HTML works offline even when copied outside
the repository. No framework, hosted service, external script, build step or
application launch is required. Companion Design notes links require the
repository documents.

To serve the repository locally:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Visit <http://127.0.0.1:8765/docs/design/prototype.html>. Switch between **Editor**
and **Components** to inspect the workspace and shared control examples.

## Photograph credits and provenance

Credits belong in these Design notes, not in the editor or Info view. All five
sources are existing, unchanged fixtures covered by the
[Unsplash License](https://unsplash.com/license); the
[repository credits](../../tests/fixtures/photos/CREDITS.md) retain their
permission and source records. They remain in the legacy fixture tree pending
the separate asset migration, backlog #35.

| Fixture                                                              | Photographer and original source                           | Dimensions  | SHA-256                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| [alpine-lake.jpg](../../tests/fixtures/photos/alpine-lake.jpg)       | [Luca Bravo](https://unsplash.com/photos/VowIFDxogG4)      | 1920 × 1280 | `f349334517fad6132a107581a7d524160782b18d97fe423c9d277540e74dd081` |
| [mountain-ridge.jpg](../../tests/fixtures/photos/mountain-ridge.jpg) | [Luca Bravo](https://unsplash.com/photos/aIeukKl3raU)      | 1920 × 1280 | `a2ba3418fefd612a9c1cdc84b60798216535cf60d2f9a2844a738e0be346b7fd` |
| [quiet-valley.jpg](../../tests/fixtures/photos/quiet-valley.jpg)     | [Nathalie Lays](https://unsplash.com/photos/gTQ8U8NbDEc)   | 1920 × 1080 | `2613b18b8178493f32e3538be15f1cd8232ca3c30223bcd6b31ea964f77664d7` |
| [forest-light.jpg](../../tests/fixtures/photos/forest-light.jpg)     | [Sebastian Unrau](https://unsplash.com/photos/sp-p7uuT0tw) | 1920 × 1280 | `50634536a3e64206123d631fb8c43d569cb6c78f89958fb53dc375e720a33fd9` |
| [coastal-dunes.jpg](../../tests/fixtures/photos/coastal-dunes.jpg)   | [Colin Lloyd](https://unsplash.com/photos/-IyFkzVo_7A)     | 1920 × 1278 | `82798c908431a838a0ff51b3f739a1ea2c5cd92515cbb377365c5cfe25033484` |

Complete images and metadata were reviewed before embedding. No EXIF, XMP or
IPTC tags are present; color profiles and original bytes are preserved. The
coastal-dunes fixture name does not establish an ocean setting. These sources
are prototype-only and are not added to the application or a user's library.

## Dependencies and design workflow

Inline Lucide symbols come from the existing project dependency; upstream
license notices remain inside the HTML. The installed Anthropic
[frontend-design skill](https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/frontend-design)
guided the brief, directions, prototype and visual critique. Codex's existing
skill installer installed revision `ca45fc496a3436251f191354091d557da31c15b5`.
The upstream skill remains unchanged, including its Apache-2.0 `LICENSE.txt`,
in `~/.codex/skills/frontend-design/`.

| Installed upstream file | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `SKILL.md`              | `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3` |
| `LICENSE.txt`           | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |

## Verification

The final cleanup passes **seven bounded browser cases in 5.61 seconds** on
Bazzite in isolated headless Chromium. Both 1100 × 700 and 1440 × 1000 layouts
were checked with Console open and visually reviewed, including scrolled photo
rows. Coverage includes group/selection/history and keyboard navigation,
compact floating controls, hover/focus/menu/dialog behavior, touch and reduced
motion, the original icon at all four sizes on dark/light backgrounds, and
offline image loading with JavaScript disabled. Network access was blocked and
only the HTML was copied outside the repository for these checks.

Formatting, inline JavaScript syntax, 109 unique IDs, 56 local SVG/anchor
references, companion links, source photograph identities and the original icon
hash pass. Application source, package files and photographic fixtures are
unchanged. The selected PNG retains its original generation provenance; no
private capture metadata was found.

Detailed evidence is local and ignored under
`artifacts/verification/2026-11-01-design-handoff/`; screenshots and rejected
studies are excluded from the handoff. Browser contexts, processes and temporary
standalone copies were closed. This verifies the retained prototype only;
native Electron behavior and application implementation remain later checks.
No comprehensive application checkpoint or processing benchmark ran.

## Next session

Start from this selected prototype. Application implementation remains deferred
for today. First write `docs/design-system.md` with semantic tokens, typography,
spacing, component dimensions, interaction states, motion and inspector
organization. Align [input](../input-design.md), [menu](../menu-design.md) and
[scrolling](../scrolling-design.md) guidance, and create the concise project UI
skill with the skill creator, referencing the guide and existing components.

Then implement shared tokens and controls for **#34**, preserving workspace
geometry. Implement inspector navigation for **#33** as a separate bounded
change. Reuse `AdjustmentInput`, the shared menu model and continuous-scrolling
controller. Preserve pending edits, active/selected photo identity, focus,
photo-wide Undo/Redo, external updates and saved workspace state. Keep processing
APIs and photo-edit schemas unchanged; extend only the existing typed workspace
state where navigation persistence requires it.

Verify the affected targets and genuinely new navigation/state behavior,
including actual Electron minimum sizing with Console open. Close #34 and #33
only after their respective implementations and relevant checks pass. Do not
resume unrelated processing or performance work as part of this handoff.
