# Photo browser design study

Open [the interactive study](photo-browser-study.html) directly in a browser.
It works offline, including when the HTML is copied out of the repository.
No application launch, server, installation or network access is needed.

On November 4, 2026, the user selected **List + Beside browser** for application
implementation. Its photo browser and Editor Console placement now override those
parts of the [historical reference](prototype.html), which remains unchanged.
The other variants remain research comparisons. Their switches, simulated data
and static editing controls are not production features.

## Research and direction

The current Editor changes its visual structure between individual photographs
and groups: 56px rows become 104px two-column tiles inside a group with a 69px
header. At the minimum size, that group structure consumes much of the browser.
The working hypothesis is that a consistent photo shape and less group chrome
will make the collection easier to scan. The study tests that hypothesis; it
does not establish measured usability improvements.

The research used these primary sources, checked on November 4, 2026:

| Source                                                                                                                                                      | Documented behavior                                                                | Application to this study                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Adobe Lightroom Classic: stacks](https://helpx.adobe.com/il_en/lightroom-classic/desktop/organize-photos-in-lightroom-classic/grouping-photos-stacks.html) | A collapsed stack has a cover thumbnail and count; expansion shows its members.    | Keep a group compact until its members are needed. Clicking a cover still targets one photograph. |
| [Capture One: browser overview](https://support.captureone.com/hc/en-us/articles/360002474018-The-Browser-overview)                                         | Filmstrip, grid and list provide different thumbnail browsing arrangements.        | Compare a filename-oriented list against a uniform thumbnail grid.                                |
| [Apple Photos: bursts](https://support.apple.com/en-ca/guide/photos/pht8745d2677/mac)                                                                       | Opening a burst provides a dedicated view of its members, with arrow-key browsing. | Try a focused group view with an explicit return to the collection.                               |

These are general navigation references. Their capture detection, rating,
deletion, catalog and editing policies are not adopted by this prototype.

### Browser designs

- **List:** 56px rows for singles, covers and members. A count/disclosure button
  replaces the separate group header. Expanded members keep the same row size,
  with a subtle connecting line.
- **Grid:** identical two-column, 112px tiles for singles, covers and members.
  Each thumbnail is 65px high, with its filename and current/member status below.
  Expanded groups have a quiet boundary instead of a separate heading.
- **Focused groups:** compact rows in the overview. The count button enters a
  member list; **All photos** or Escape restores the previous collection anchor.
  Opening or leaving the group changes neither the active photo nor selection.

### Console placement

- **Full width** retains the existing overall arrangement.
- **Beside browser** lets Photos extend to the status bar. Console spans the
  photograph and inspector columns, retaining usable text width.

The browser stays 224px wide. Both arrangements retain the same photograph and
inspector dimensions. Console is open initially, at 180px high in a 1100 × 700
application area and 216px at the two larger presets. Controls for the study sit
outside that measured application area.

The selected direction is **List + Beside browser**. It addresses both
the inconsistent photo shape and the lost browser height. Grid offers more image
area per thumbnail but less filename space. Focused groups contain large sets
well but require a return step and temporarily hide neighboring photographs.
The user accepted this direction after trying the visual examples.

## Trying the examples

Use **Browser**, **Console** and **Window** above the workspace. **Reset example**
restores the same collection, current photo, selected set, group covers and
expansion state while retaining the chosen design, placement and window size.
The live measurements below the workspace report complete/partial visible items,
browser viewport height, preview dimensions and approximate Console columns.

Click a photograph to view and select it. Ctrl/Cmd-click toggles selection;
Shift-click selects a range and includes every member of an included cover,
including collapsed members. Arrow keys browse; Ctrl/Cmd-arrows move focus without
changing the photograph or selection. Space toggles the focused photograph;
Home, End, PageUp and PageDown navigate the current collection view.

The current photo has a left accent and **Current** text. Selected photos have
a checkmark and neutral fill. Keyboard focus has a dashed outline. These are
independent states. **Show current** opens/reveals the active member without
replacing selection. The footer reports selection hidden by a closed group or
the focused-group view, rather than counting offscreen rows as hidden.

Right-click a photograph, use Shift-F10, or open either ellipsis button to use
the same session-only menu. Browser actions target the focused photo; the
photograph toolbar targets the current photo. **Select entire group** preserves
the current photo and range anchor. Cover changes alter only the study's group
order. Menus support arrows, Home/End, typeahead, Escape and ordinary Tab exit.

Photo navigation in the lower-left capsule follows the active group's members;
for an ungrouped photo it follows the visible collection. Inspector tabs and
disclosures are interactive for checking independent scrolling. Editing sliders,
Undo/Redo and Export are visibly unavailable in this navigation study. The
Console is disconnected and read-only.

## Photographic inputs

The same **24 simulated entries** are used in every design: seven singles and
three manual groups containing three, five and nine entries. Entries repeat five
existing JPEG originals; they are not 24 distinct captures, genuine brackets,
burst detection evidence or processing results. Simulation is labelled outside
the application example. Entry numbers appear in accessible names/tooltips so
repeated photographs remain distinguishable during navigation.

All five original JPEG byte streams are embedded unchanged and carry the same
SHA-256 values as the approved reference. Filenames, source dimensions and
unchanged-photo histogram paths come from that reference; no capture dates,
camera settings or automatic group origins are invented. Reusing the existing
reviewed fixtures requires no new photographic acquisition or fixture changes.

| Photograph           | Photographer    | Source                                                                    |
| -------------------- | --------------- | ------------------------------------------------------------------------- |
| `alpine-lake.jpg`    | Luca Bravo      | [Boathouse on a mountain lake](https://unsplash.com/photos/VowIFDxogG4)   |
| `mountain-ridge.jpg` | Luca Bravo      | [Mountain at golden hour](https://unsplash.com/photos/aIeukKl3raU)        |
| `quiet-valley.jpg`   | Nathalie Lays   | [Dawn at Emerald Lake](https://unsplash.com/photos/gTQ8U8NbDEc)           |
| `forest-light.jpg`   | Sebastian Unrau | [Entering another dimension](https://unsplash.com/photos/sp-p7uuT0tw)     |
| `coastal-dunes.jpg`  | Colin Lloyd     | [Great Sand Dunes National Park](https://unsplash.com/photos/-IyFkzVo_7A) |

The [fixture credits](../../tests/fixtures/photos/CREDITS.md) retain source and
permission records under the [Unsplash License](https://unsplash.com/license).
Sources remain at their existing fixture paths pending asset migration #35.
This study does not import them into a managed library or production bundle.

Lato Regular, Semibold and Bold are embedded unchanged from the
[bundled fonts](../../assets/app/fonts/lato/README.txt), covered by the
[SIL Open Font License](../../assets/app/fonts/lato/OFL.txt). The font copyright and complete OFL text are also embedded in the HTML so a
standalone copy retains them. The unchanged
[Little Jizō icon](../../assets/app/icons/README.md) is embedded at its original
source resolution. Inline interface icons follow the existing Lucide forms.

## Verification and implementation boundary

The browser review covers all 18 combinations of three designs, two Console
placements and 1100 × 700, 1440 × 1000 and 1920 × 1080 application areas. It
checks measured geometry, horizontal clipping, floating-control separation,
loaded images, current/selected/focus identity, hidden selections, complete group
ranges, cover changes, Show current, focused-group return anchors, keyboard menus,
independent scrolling and Console collapse/reopen. Additional checks cover an
offline copy outside the repository, all three embedded fonts, touch/reduced
motion and a clear JavaScript-disabled explanation with a visible photograph.

Generated screenshots, measurements, the bounded review script and reports live
under ignored `artifacts/verification/`. Each run has a `summary.md`, `details.md`
and `result.json`; failed attempts are retained separately from corrected reruns.
The final evidence link and measured comparison are recorded below.

This is isolated headless Chromium evidence on Linux. Native desktop focus,
display/HDR behavior, actual processing, large virtualized libraries, restart
recovery, macOS and Windows are not acceptance claims of this study. No Electron
launch, user-library access, application source edit, dependency change, API or
schema change, processing benchmark or comprehensive checkpoint is involved.

Application adoption uses the existing collection controller/layout adapter,
selection queue, workspace recovery and shared photo menu model. The finite in-memory data and standalone menu renderer here are
prototype scaffolding and must not become parallel application owners.

## Local review — November 4, 2026

[The review summary](../../artifacts/verification/2026-11-04-photo-browser-study-review-keh4v_ly/summary.md) records **34 distinct passing checks** across the 18 layout combinations and focused behavior/offline checks. The accumulated browser review took **23.64 seconds**, including the preserved fallback failures and corrected exact reruns. The matrix and unaffected interaction evidence were reused rather than repeated.

At 1100 × 700, with the same initial collection and Console open:

| Browser                 | Full-width Console | Console beside browser |
| ----------------------- | ------------------ | ---------------------- |
| List                    | 5 complete items   | 8 complete items       |
| Grid                    | 4 complete items   | 7 complete items       |
| Focused groups overview | 5 complete items   | 8 complete items       |

These are visible-item counts, not browsing-speed or usability measurements.
The browser viewport grows from **304px to 492px**. The photograph remains
**500 × 429px**, and Console remains **180px** high. Console width changes from
1100px (about 161 columns) to 852px (about 123 columns). Column estimates use the
actual browser font metrics and padding; they are not an implemented terminal.

The minimum-size list, grid, focused nine-member group and the study controls
were visually reviewed. The same geometry checks pass at 1440 × 1000 and
1920 × 1080. The user selected List + Beside browser after this review; application
adoption is recorded below.

## Application adoption — November 4, 2026

Backlog [#51](../features/README.md#task-51) implements the selected **List + Beside
browser** arrangement in Editor. Singles, covers and expanded members share
56px rows with 60 × 44px thumbnails and a 2px gap. Cover rows contain the count
and disclosure; whole-group commands stay in the shared photo menu. Photos
extends beside Console, preserving the existing photograph and inspector sizes.
Library retains its existing browser and full-width Console.

Current photo, selection, keyboard focus, loaded/unloaded group ranges, Show
current and workspace recovery retain their existing owners. Saved offsets from
the old taller tiles are bounded inside the compact row. No processing, bridge,
schema, history, dependency or photographic-input change is involved.

[Local application acceptance](../../artifacts/verification/2026-11-04-photo-browser-adoption-i0is1mwj/summary.md)
records **920 distinct passing checks**: 882 Node and 38 Electron. Native window
coverage includes 1100 × 700, 1280 × 800, 1440 × 900 and 1920 × 1080; the literal
composition check also covers 1440 × 1000. Native minimum-size group/menu review
and frozen 69-photo deletion pass. The final layout preserves 500 × 429px and
808 × 689px stages, with Console respectively 852 × 180px and 1186 × 216px.

Verification reused passed checks and reran exact failures. Launcher fixtures
now use an ephemeral probe port to coexist with a real development session; the
strict preload test recognizes the existing typed window-blur notification.
Hidden import review uses keyboard checkbox input, and native Wayland group/menu
capture is explicitly foreground. These are test corrections; the production
endpoint, typed bridge and assertions remain intact. Failed/deferred evidence and
corrected reruns are retained in the linked report.

The retained invocations total 527.05 seconds including superseded failures.
Routine duration warnings remain visible. Native screenshots were reviewed on
Bazzite/Linux; macOS, Windows, processing/performance and HDR display acceptance
are separate. Test profiles and Trash adapters are isolated, and the real user
library and running development session were not used for automation.
