# Sunflower design system

Sunflower is Irodori's approved dark-only visual language. The unchanged
[prototype](design/prototype.html) and [handoff](design/README.md) are its visual
reference. Use the final cascade, with the explicit approved overrides below.
Computed styles were read in isolated Chromium at 1100 × 700 on 2026-11-02:
Photos 224px, inspector 344px, rail 52px, histogram 318 × 96px, individual rows
56px, floating photograph menu 30px and bottom controls 26px.

On 2026-11-04 the user selected **List + Beside browser** from the
[photo-browser study](design/photo-browser-study.md). Its uniform photo rows,
inline group disclosure and full-height Editor browser beside Console supersede
the historical prototype only for those surfaces. Keep the other Sunflower
composition and editing controls, including their real application behavior.
The study's comparison switches and simulated collection are not application UI.

## Semantic tokens

Production tokens live in [tokens.css](../src/renderer/src/tokens.css). Use roles
instead of new literal greys or warm-tinted surfaces.

| Role / token                  | Value                 | Use                               |
| ----------------------------- | --------------------- | --------------------------------- |
| `--canvas`                    | `#161616`             | Photograph surround, input wells  |
| `--surface`                   | `#202020`             | Panels and dialogs                |
| `--surface-raised`            | `#303030`             | Controls and selection            |
| `--surface-hover`             | `#3c3c3c`             | Pointer feedback                  |
| `--surface-overlay`           | `#202020eb`           | Floating photograph controls      |
| `--line` / `--line-subtle`    | `#606060` / `#3d3d3d` | Visible borders / separators      |
| `--text`                      | `#f2f2f2`             | Primary text                      |
| `--muted` / `--quiet`         | `#c0c0c0` / `#acacac` | Secondary text / hints            |
| `--accent`, `--focus`         | `#e7c75c`             | Actions, selected controls, focus |
| `--on-accent`                 | `#251e08`             | Text on primary actions           |
| `--accent-surface`            | `#303030`             | Neutral selection fill            |
| `--error` / `--error-surface` | `#f0a4a4` / `#352626` | Destructive actions and failures  |
| `--success` / `--warning`     | `#afd0b7` / `#e2c18c` | Completed tasks and limitations   |

Yellow marks decisions and focus; it never tints the photograph's surround.
Histograms, clipping overlays and creative color swatches retain domain colors.
Use text, a checkmark, outline or status icon in addition to color.

## Typography, spacing and geometry

Bundle Lato Regular 400, Semibold 600 and Bold 700; use Segoe UI and system
sans-serif as fallbacks. [Originals, hashes and OFL license](../assets/app/fonts/lato/manifest.json)
remain beside the fonts. Load locally through Vite with no hosted stylesheet.
Use 12px body text, 11–12px controls/headings, 10–11px hints and 9px compact
collection labels. Allow metadata and errors to wrap. Use tabular numerals for
values, dimensions and progress. Console output keeps its platform monospace
font with the same semantic palette.

The approved reference is the **rendered final Sunflower state** of
[prototype.html](design/prototype.html). Match its composition, controls and
computed dimensions, not only its colors. Earlier declarations in the prototype
are superseded by its final cascade. The study toolbar and component gallery are
design-review surfaces, outside the application window content. Keep the retained
prototype unchanged. Compare matching content sizes, tool tabs, scroll positions
and settled interaction states before updating this guide. For comparison on
hosts without Lato installed, load the committed 400/600/700 font files into the
reference page temporarily; otherwise its system fallback changes text widths.
This does not modify the retained prototype or add a network dependency.

Use 4px for close relationships, 6px within control sets, 10px workspace gutters
and 22px dialog insets. Workspace gutters reduce to 8px below 1200px. Controls
have 3px radii, panel and floating-control border radii 4px, and dialogs 5px. Lucide
icons are generally 16px with accessible names on icon-only controls. The 48px
header uses a 32px Little Jizō mark from the bundled 64px PNG alongside the
18px/600 Irodori wordmark. Little Jizō also supplies the desktop application icon,
with unchanged original bytes and reproducible platform derivatives.

On 2026-11-02 the user explicitly requested Little Jizō in the header, replacing
the prototype's aperture mark. This approved override takes precedence over that
part of the retained prototype. Keep the prototype unchanged as the historical
reference; preserve Little Jizō in future header work.

### Editor geometry

| Element                             | Final geometry                                                 |
| ----------------------------------- | -------------------------------------------------------------- |
| Application header / status bar     | 48px / 27px high                                               |
| Work area                           | 10px outer padding and gaps; 8px below 1200px                  |
| Photos                              | 224px wide; 38px heading; compact real library summary         |
| Inspector                           | 368px wide; 344px below 1200px; 52px rail                      |
| Rail buttons                        | 40px high, 2px separation; rail padding 6px 3px                |
| Expanded histogram                  | 157px high; 28px summary, 96px plot, compact caption           |
| Photograph                          | 1px stage border and 12px viewport padding                     |
| Floating photograph menu            | Top/left 9px, 30px high, 6px horizontal padding, 4px gap       |
| Floating navigation / view controls | Bottom 9px; left/right 9px; 26px high; 7px horizontal padding  |
| Console                             | 216px high; 180px at content heights up to 760px; 36px heading |

The plot stays at least 240 × 96px. Its clipping/HDR actions fit in the compact
summary, with detailed HDR legend available on demand. A separate 1px subtle
border divides the histogram and rail/tool body. Tools have independent vertical
scrolling, stable scrollbar space and 6px 10px 16px padding, narrowing horizontally
to 8px below 1200px. The rail remains fixed while tools scroll.

With Console open, a 1100 × 700 content window has a 500 × 429px stage and a
474 × 403px photograph viewport. At 1440 × 1000 these are 808 × 689px and
782 × 663px. These sizes include real Electron content geometry, not a browser
viewport containing the prototype's 44px study toolbar.

Editor Photos spans both the photograph row and the Console row. Console begins
at the photograph's left edge and ends at the inspector's right edge; its width
is 852px at 1100 × 700 and 1186px at 1440 × 1000. With Console open, Photos is
617px high at minimum size, including its independently scrolling collection.
The existing photograph, inspector and Console heights remain unchanged. Console
closed restores the existing taller photograph. Library keeps its full-width
Console arrangement and date/month/year browser.

### Inspector composition

- **Masks:** the November 8 approved extension uses one **Create mask** command
  menu, named 44px rows with type/status and per-row actions, and **Coverage /
  Adjustments** tabs. Coverage holds the active selection method and manual
  correction; Adjustments uses the shared Light disclosure and numeric inputs.
  The list and details scroll independently, with up to two list rows at minimum
  content height and four in taller windows. Keep the creation header, overlay
  preference and tabs visible. Future mask methods join the chooser and future
  adjustment groups join the disclosure area; see [local masks](features/local-adjustments.md).
  The November 10 gradient extension adds Linear/Radial gradient to that chooser
  and Gradient shape in Coverage, with Edit gradient, radial Feather and collapsed
  pixel Geometry. Handles belong to Coverage independently of Show overlay. The
  [gradient study](design/mask-gradients.html) and native 1100 × 700 Console-open
  acceptance preserve the existing layout and independent scrolling.
  The November 12 [range-mask panels](design/mask-ranges.html) add Color/Luminance
  range to the same chooser and compound methods. Coverage uses up to five sample
  swatches, Range/Softness and optional hexadecimal entry, or numeric Lower/Upper
  source-white percentages with an unbounded Upper option. New masks/parts preview
  until explicit Create/Add/Replace; the overlay inspection selector stays locked
  during creation. Native 1100 × 700 Console-open and Sunflower checks pass; see
  [range acceptance and limits](features/mask-ranges.md).
- **Light:** Light title and reset; Tonal adjustments disclosure; implemented
  tonal controls; an expandable Curves section with labelled channel selectors,
  square signed-log graph, Standard/HDR/Fit points views, Input/Output fields,
  targeting toggle, channel reset and an expandable complete point list. See
  [the interaction study](design/tone-curves-prototype.html) and [curve behavior](features/tone-curves.md).
- **Color:** Basic/Mixer/Grading segmented tabs and group reset on the same row;
  no second visible Color title. Basic contains White balance, its real supported
  controls and As Shot action, followed by Color intensity. Mixer uses two rows
  of four named swatches, scoped controls and reset. Grading has Shadows,
  Midtones and Highlights, a centered 128px wheel, scoped controls/reset and a
  separate Tone blending disclosure.
- **Detail:** title/reset, commit-feedback hint, separate Noise reduction and
  Sharpening disclosures; unavailable Output sharpening with Planned tool text.
- **Geometry:** title/reset, Crop and straighten and Lens corrections disclosures.
  Show real persisted framing values before starting a crop; enable the draft
  controls in the existing Start/Apply/Cancel session. Resizing stays in Export.
- **Presets:** compact 44px rows with a 16px scenario icon, name and included
  groups; neutral fill and Sunflower selection/focus outline. The nine named
  marker colors stay on icons. New/Update and Edit details show a 24px preview,
  closed grouped icon disclosure and native radio choices with checkmarks and
  focus outlines. The icon collection scrolls inside the dialog body; Save and
  Cancel remain visible at minimum size with Console open. See
  [preset appearance](features/named-presets.md#scenario-icons-and-colors).
- **Info:** Information title and one stacked definition list: filename,
  dimensions, format, camera/exposure and supplied additional metadata. Long
  values wrap inside the independently scrolling panel. Do not repeat the old
  compact preview metadata summary above it.

Group titles use 12px/600 text and a 24px-wide reset button whose 16px icon,
4px padding and border compute to 26px height. Titles have 5px bottom spacing;
section summaries are 28px high with 12px text. Dividers use the subtle border,
10px bottom padding and 10px separation. Fresh disclosures are expanded;
explicit saved collapsed choices remain respected.

### Photos and floating controls

All photographs use 56px rows separated by 2px, with 60 × 44px thumbnails
and adjacent filenames. Only the active photograph has Current text and a left
accent. Selection has neutral fill and a top-left thumbnail check; keyboard focus
has a separate dashed outline. The footer contains the selection count
and full-width Show current action. Do not add a separate stored-on-device block.

Group covers use the same row, with a 31 × 26px count/disclosure button at the
right. Expanded members continue below at the same size with a subtle connecting
line. There is no separate group header, two-column tile layout or loose-photo
heading. Current, cover/member status and genuine dimensions stay compact;
origin remains available through the group's accessible label. Whole-group
selection and commands use the shared photo menu. Reserve the same row geometry
before records load. Source order remains owned by the collection projection;
never reorder or fabricate sample records to imitate the study's static library.

The photograph menu is filename, display badge, Undo, Redo, Toggle hover, divider
and More. Icon buttons are 28px high and Toggle hover is 24px. The badge opens display mode, crop/comparison controls and display
information; it dismisses on outside pointer input or Escape. Group navigation
is one lower-left capsule. Dimensions, native zoom selector and truthful task or
frame feedback share one lower-right capsule. Keep zoom keyboard/wheel behavior;
place no separate +/−/Fit button row or metadata strip below the photograph.
Error text may ellipsize with its full description available, while Retry stays
visible and keyboard-accessible. Preserve the mounted canvas and its processing
owner across these presentation changes.

Console uses the canvas surface and an 11px monospace font at 1.8 line height,
with 18px 22px output padding. Its heading is Console, a Disconnected badge and
collapse chevron. Size xterm from an inner container so padding never creates
horizontal overflow. The status-bar Console action comes first on the left.

## Components and ownership

Custom JPEG export's [Output preview](features/output-proof.md) uses the approved
expanded dialog: 22px insets, 256px independently scrolling settings, a neutral
photograph canvas beside them, and fixed footer actions. The proof header carries
the frozen filename, batch navigation and a local native display select; its
lower-right capsule uses the existing zoom choices. Metadata and explicit
Preview output / Update preview actions stay below the canvas. At 1100 × 700 with
Console open, all footer actions remain visible. The mounted Editor retains its
own view and suspends through the existing presentation owner.

The settings column places Output sharpening after Size, using a native select
with Off, Low, Standard and High. Its help directs final-detail review to 100%.
The proof caption names the sharpening already baked into the displayed JPEG;
changing the draft keeps that caption until Update preview replaces the image.
The setting belongs to export rather than the saved Detail inspector controls.

Shared [controls](../src/renderer/src/components/ui/Controls.tsx) provide `Button`,
`IconButton`, `Tabs` and mounted `TabPanel`. Native buttons with specialized
collection/menu semantics use the same global rules and semantic tokens.

```tsx
<Button variant="primary" disabled={!ready} onClick={startExport}>Export</Button>
<IconButton icon={RotateCcw} label="Reset Light" onClick={resetLight} />
<Tabs label="Color tools" value={tab} items={colorItems} onChange={switchColor} />
<TabPanel id="basic" active={tab === 'basic'}>{basicControls}</TabPanel>
```

- **Buttons:** 28px minimum height, 4 × 10px padding, 600 weight. Primary is
  yellow with dark text; secondary is neutral raised; quiet/icon actions have
  transparent surroundings; destructive actions use labelled error styling.
- **Inputs:** reuse `AdjustmentInput`, including its borderless right-aligned
  value and full-width slider. Adjustment spacing is 4px 0 6px, with an 18px
  heading row and 58px-wide numeric input (14px line height, 1px 3px padding).
  Labels use 11px/600 and values 11px/400. The slider is 15px high with 1px top
  margin, a 3px yellow/grey track and a 9px white thumb with canvas border. Forms use neutral wells, visible borders and
  explicit labels. Keep busy values read-only and focusable. [Input design](input-design.md)
  owns gesture/commit semantics.
- **Segmented controls and tabs:** neutral well, selected yellow border/text,
  with a roving Tab stop, arrows and Home/End in shared `Tabs`. Grading tone
  buttons retain ordinary Tab traversal and pressed state. Tabs use `aria-controls` and labelled
  panels. Owners flush valid drafts before switching; invalid text restores the
  confirmed value. Hidden panels stay mounted and receive external revisions.
- **Disclosures:** use `InspectorSection`, with a named native button,
  `aria-expanded`, `aria-controls` and mounted hidden body. Info implements the
  same contract directly in `Inspector` to retain its plain Information title. The histogram stays
  above the editing rail. Preserve disclosure/range/tone preferences.
- **Menus:** extend `PhotoContextMenu` and its shared command model. Keep
  targets, selection and availability in their owners. Follow [menu design](menu-design.md).
- **Dialogs:** retain native `dialog.showModal()`, Escape/cancellation guards,
  focus restoration and scrolling bodies/fixed actions. Confirm frozen deletion
  targets and preserve native Trash behavior. Use semantic tokens/shared buttons.
- **Tooltips:** concise native `title` supplements an accessible name. Required
  instructions and unavailable reasons belong in visible/described text so they
  remain available to keyboard and touch users.
- **Feedback:** reuse TaskProgress/TaskCenter/TaskErrors and ProgressSpinner.
  Show real known/unknown progress, retained completion/errors, Retry and Cancel.
  Errors have text and `role="alert"`; status uses `role="status"`. Never invent
  metadata, photographs or progress.

The [collection controller](../src/renderer/src/collections/controller.ts) owns
loading/retry/caching. Layout maps source indices to visual boxes; fetching,
selection and anchors keep source indices. Active indication is independent of
selection; Show current expands/reveals it without replacing selection. Follow
[scrolling design](scrolling-design.md).

The edit owner alone controls persistence, conflicts and photo-wide Undo/Redo.
Group resets are one edit-service patch, using neutral settings, supported As
Shot/reference white balance and automatic lens settings. Preserve fixed merge
corrections. Crop Apply/Cancel guards prevent committed resets during transient
crop. Mixer and Grading keep scoped resets. Navigation creates no edit history.

## Interaction, accessibility and motion

Keep hover, pressed/selected, focus, busy, disabled and error distinct. Default focus is
a 2px yellow outline with 2px offset. Disabled controls remain labelled and use
45% opacity. Busy inputs retain focus and reject extra gestures through existing
guards. Use native elements, normal Tab traversal and accessible names.

Floating controls default to persistent. Toggle hover may hide them on fine
pointers; pointer presence, keyboard focus, open menus, badge disclosures and dialogs keep them
visible. Coarse pointers keep controls visible. Use restrained 140ms color/opacity
feedback, no layout animation, and disable nonessential motion under reduced motion.

## Migration checkpoints and verification

Track visual migration under #34, navigation under #33 and desktop identity under
#21. Platform evidence stays explicit; an icon file does not prove desktop presentation.
Use focused targets, isolated profiles and the hidden launcher. Cover pending/invalid
input, external revisions, reset Undo/Redo, older checkpoints/restart, unloaded group
geometry across chunk boundaries, selection/anchor recovery, keyboard, hover,
coarse pointers and reduced motion. Use the registered `sunflower-fidelity` target for measured dimensions and
settled screenshots of every tool at matching sizes. Compare production to the
prototype, including an actual native 1100 × 700 Console-open window. Packaged acceptance starts offline
and exercises import and RAW decoder fallback. Foreground platform identity checks
are separate. Comprehensive suites and processing benchmarks are outside this migration.

## Codex console extension — November 4, 2026

The [interactive console](features/agent-console.md) retains the approved height,
36px header and List + Beside geometry at the default height. The user-requested
height divider adds bounded pointer/keyboard resizing, cancellation, reset and a
workspace-only saved preference; it preserves photograph space and independent
scrolling. Shared Sunflower buttons provide
connection, Stop, New conversation, explicit Resume and setup recovery. Compact
status/error text explains setup; xterm keeps monospace output and independent
scrolling. One mounted terminal moves between Editor/Library slots and remains
mounted while hidden. Shift+Tab leaves terminal input for its controls. The
historical prototype's disconnected text is superseded by this selected console
deliverable; the reference photograph/inspector/browser geometry is unchanged.

## Compound mask extension — November 10, 2026

The [compound-mask study](design/mask-compounds.html) was approved before
production UI changes. Coverage parts adds Combine… with Add/Subtract/Intersect
methods or independent editable copies. Result and fixed Starting coverage
precede expandable nested operands. Parts scroll independently; per-part menus
and parent-local keyboard/pointer ordering preserve the mask-list and details
owners. Result / Selected part inspection is a workspace preference. Handles
appear only for the selected gradient in Coverage. Native 1100 × 700 review
keeps Console open and the photograph dominant; see
[compound coverage](features/mask-compounds.md).
