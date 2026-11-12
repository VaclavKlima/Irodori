# Adjustment input design

Follow the shared [Sunflower design system](design-system.md) for semantic tokens,
typography, dimensions and reusable presentation components. This document owns
the behavior and contracts of its controls.

New inputs should be compact, neutral, and subtle. Use consistent spacing and typography, restrained hover feedback, and an unmistakable keyboard-focus outline. Numeric values use tabular digits and align to the right; units remain quieter than the value. Keep disabled controls visibly unavailable and errors readable without relying only on color.

Photo command menus follow the separate authoritative [menu design standard](menu-design.md): shared model/renderer, explicit targets, hidden structural mismatches, and concise accessible explanations for temporary blockers.

## Desktop shortcuts and text selection

Irodori is a desktop workspace. Interface text is not selectable by default:
navigation, headings, button/menu labels, collection rows, slider labels and
status chrome belong to controls. Selecting photographs is application state,
separate from selecting text. Keep accessible names, focus and keyboard activation.

Text fields, numeric values, search, textareas and editable content retain native
selection, clipboard and text Undo/Redo. Read-only fields still allow selection
and copy. Do not disable a field just to prevent selection. Console's xterm owns
its terminal selection and key handling; its header remains ordinary app chrome.

Useful read-only content is copyable: metadata values, filenames in information
and confirmation views, destination paths, task error details and display
diagnostics. Mark the smallest useful text region with `data-selectable-text`;
give a useful standalone region `tabIndex={0}` and an accessible name when needed.
Error text exposed through `role="alert"` is also selectable. Keep action controls
outside copyable regions where possible. Do not mark whole panels, collection
items, the app root or Console as selectable merely to make one value copyable.

The shared [input policy](../src/renderer/src/input-policy.ts) is installed by the
renderer entrypoint, alongside the global CSS defaults. Ctrl+A / Command+A never
selects the application document. Inside a text editor it keeps native behavior;
inside a focused copyable region it selects only that region. Outside these
owners it has no document-selection action. Native Edit → Select All must obey
the same boundary. Ordinary drag selection stays within one copyable region.
Preserve composition, native controls and the terminal; do not stop propagation
or blanket-cancel key, pointer or context-menu events.

Use Ctrl on Linux/Windows and Command on macOS for the primary application
modifier. Define each new shortcut's owner, focus exclusions, modifier/repeat
behavior, availability, pending-edit/cancellation behavior and matching menu or
accessible hint. Prefer existing owners and handlers to a second global dispatcher.

| Shortcut / gesture                          | Owner and behavior                                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary+A                                   | Native text editor; focused copyable text selects that region. App chrome has no Select All text action. Console retains terminal behavior.                                       |
| Primary+C/X/V and text Undo/Redo            | Focused text editor. Copyable text supports Copy. Console follows its own clipboard/interrupt contract below.                                                                     |
| Primary+Z; Primary+Shift+Z / Primary+Y      | Active photograph's shared Undo/Redo when focus is outside text entry and Console, subject to existing edit guards.                                                               |
| Delete / Backspace                          | Existing photo-deletion owner with its current platform rules, exclusions, frozen targets and Trash confirmation.                                                                 |
| Arrow, Home/End, Page Up/Down, Space, Enter | Focused collection/control owns navigation, selection or activation; preserve modifiers and range anchors.                                                                        |
| Preview `+` / `=`, `-`, `0`, `1`, arrows    | Focused preview zooms in/out, fits, selects 100%, or pans; Shift pans farther. Forms, menus and active tools retain their guards.                                                 |
| Preview `\`, `Y`, `J`                       | Focused preview toggles Before, split comparison, or clipping (both SDR endpoints; HDR canvas-channel clipping) when available. Active crop/picking tools retain their overrides. |
| Escape                                      | The active transient tool, menu or dialog owns cancellation and focus restoration.                                                                                                |
| Tab / Shift+Tab                             | Normal focus navigation; Console's Shift+Tab returns to its controls.                                                                                                             |

Use the repository [Irodori input skill](../.agents/skills/irodori-input/SKILL.md)
when adding or changing shortcuts or selectable text. Verify `desktop-input-ui`
and affected existing owners. Native clipboard, pointer selection and OS focus
cases require `--foreground`; do not replace them with synthetic passes.

## Dropdowns and native picker stability

Use standard HTML `<select>` elements for ordinary single-choice dropdowns. These
controls in the main application document automatically inherit the shared Linux
Wayland refresh guard in [wayland-display.ts](../src/main/wayland-display.ts).
Future native selects need no per-control timer, refresh guard, IPC or registration.
The pinned Electron workaround checks actual `select:open` / `input:open` state
before refreshing native display information. It waits while a picker is open
and resumes after choice, Escape or outside dismissal. A closed select retaining
focus must allow normal monitor updates.

Preserve the control's DOM identity and open state during ordinary React updates.
Renderer-only blur can come from a native picker or display refresh; it does not
establish application deactivation. A transient editing session that cancels on
window deactivation should use the typed `window.irodori.onWindowBlur` notification,
as crop does, and retain its explicit Apply/Cancel and Escape behavior.

Custom dropdowns, popovers, command menus and controls inside shadow roots or other
documents/windows need their own open/dismissal and focus contracts. The native-picker
guard does not automatically detect their open state. Reuse the applicable shared component
and extend its owner when needed instead of duplicating the refresh workaround.

When changing picker, focus or window-refresh behavior, reuse `wayland-display`
and `professional-dropdown-native --foreground`; add affected crop/application
targets as appropriate. Verify the actual open popup across multiple refresh
periods and explicit choice/Escape/outside dismissal, including resumed refresh.
`selectOption()` alone exercises value changes, not popup lifetime. For a newly
added native select, test its own behavior through the shared path; the existing
guard does not require reimplementation or a full regression run. The
[native picker and crop record](hdr-processing.md#native-picker-and-crop-stability--2026-11-04)
retains the cause, implementation and scoped Linux/development evidence. Revalidate
the pinned workaround when upgrading Electron.

## Preview panning

Hold the mouse's scroll-wheel button and drag to pan a zoomed photograph. The
Editor routes this gesture before crop handles, comparison dividers and tone or
white-balance picking; it changes the view without editing the photograph. Merge
review uses the same pan controller. Fit remains constrained to its fitted view.
Mouse panning retains pointer lock, capture fallback and interruption cleanup.
Verify button ownership with `pan-drag` and native interaction with
`middle-pan --foreground`, using the isolated test launcher.

## Range-mask sampling

Color/Luminance range sampling owns primary clicks only while its explicit picker
is active. Middle-button pan retains precedence. The same confirmed crop/lens/flip
mapping handles pointer positions and keyboard Sample position fields; old geometry
cannot sample a newer view. Crop, brush/gradient, object selection, white-balance,
curve targeting and region inspection retain mutual tool ownership.

New masks and parts remain local previews until Create/Add/Replace. Escape,
Cancel, native window blur, photo/revision changes and navigation retire unfinished
sampling without publishing history. Cancel restores the previous confirmed mask
selection and originating control focus. Creation locks overlay inspection and
counts as a preview gesture, so confirmed HDR clipping cannot analyze temporary
coverage. Existing range inputs retain the shared numeric commit/cancel contract.
See [range controls and verification](features/mask-ranges.md).

## Numeric slider adjustments

Use `AdjustmentInput` for new numeric slider controls. It presents a label and borderless editable value above a full-width slider, with an optional unit. Number steppers are hidden; clicking or tabbing into the value allows direct entry. Preserve its shared CSS Module styling instead of adding per-adjustment field styling or inline sizes.

Supply the label, current draft value, limits, step, display precision, optional unit, disabled state, temporary busy state, and change/commit/cancel callbacks. Change `resetKey` when confirmed state replaces the gesture, such as a new edit revision. Key the owner by photo ID so text from one photograph cannot carry into another. Other new input types should use the same visual conventions with semantics appropriate to their control type.

Valid changes preview continuously. A drag or repeated slider-key gesture commits once on release; numeric typing commits on Enter or blur. Escape and pointer cancellation restore the starting state. Do not rewrite partial numeric text while the user types. Invalid or out-of-range values never persist; leaving invalid entry restores the confirmed value. Format the number to its configured precision outside active typing. Numeric fields retain normal text-editing shortcuts.

A pending save uses `busy`, rather than native `disabled`: numeric values become read-only and sliders expose `aria-disabled` while keeping their DOM focus. Busy inputs reject typing, stepping, pointer changes and additional commits/cancellation; rejected gestures are not queued for later. Tab navigation and normal text selection/copy remain available. Preserve the focused element when saving completes, without automatically refocusing a control the user has left. Reserve `disabled` for genuine unavailability, such as no supported photo or an unavailable preview.

## Console height divider

The focusable horizontal separator above Console owns its pointer gesture and
announces its current height and bounds. Dragging previews locally; release
commits one workspace preference. Escape, pointer cancellation, lost capture,
window blur, panel closure or a workspace change cancels the unfinished gesture.
Arrow Up/Down changes height by 10 pixels, Shift by 30; Home/End selects the
available bounds. Double-click restores the responsive default.

Reuse `useConsoleResize` and the existing workspace checkpoint owner. Clamp the
height to the available space, keep at least 240 pixels for the photograph area,
and preserve independent scrolling. Resizing must not remount xterm, restart
Codex, alter photograph settings or enter Undo/Redo. Verify `agent-console` and
`workspace-recovery`, with the native Console case explicitly in foreground at
1100 × 700. The [console brief](features/agent-console.md) records acceptance.

## Console text selection

Console copies selected plain text to the system clipboard when the primary
pointer is released, including word/line selection. Do not write intermediate
drag selections or clear the clipboard for an empty selection. Cancel pending
copy on pointer cancellation or window blur. Ctrl+C (Command+C on macOS) copies
a selection; without a selection, Ctrl+C retains its terminal interrupt behavior.
Clipboard access uses the specific typed bridge, validates the current terminal
session and caps selected UTF-8 text at 4 MiB. The foreground `agent-console` case
verifies the actual clipboard and native pointer selection; preserve and restore
its previous clipboard content.

## Ownership and history

Inputs own presentation and input gestures only. Their owner owns validation, drafts, persistence, conflicts, and errors. All photo adjustments use the versioned settings document and main-process edit service, including MCP updates. Adding an adjustment extends that document through an explicit schema migration; it does not create a separate history stack.

Undo/Redo belongs in the photograph toolbar and applies to the active photo's shared history. Do not duplicate history buttons, reset buttons, or permanent save-status rows beside each slider. Entering a neutral value resets that adjustment. Put preparation status beside the preview and save/history failures in the workspace error area.

## Verification

Check keyboard focus, natural negative/decimal typing, Enter/blur commit, Escape cancellation, invalid input, and external confirmed updates. Check mixed adjustment history and persistence when adding a new edit type. Inspect native window sizing at 1100 × 700 with the console open; browser viewport emulation does not resize Electron's OS window.
