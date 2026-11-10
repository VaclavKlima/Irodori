---
name: irodori-input
description: Define or change Irodori keyboard shortcuts, text selection and copyable read-only content. Use for desktop input behavior; ordinary control styling follows irodori-ui.
---

# Irodori input

Read the [desktop input contract](../../../docs/input-design.md#desktop-shortcuts-and-text-selection)
before changing shortcut ownership or text selection. That guide owns the rules
and shortcut inventory; keep it current instead of duplicating an inventory here.

Treat UI chrome as controls, not document text. Reuse `global.css` and the shared
`input-policy.ts` installed by `main.tsx`. Text entry keeps native selection,
clipboard and local Undo/Redo, including read-only and temporarily busy numeric
fields. xterm owns Console input/selection; its header is still app chrome.

Opt useful read-only values and diagnostic prose into `data-selectable-text` at
the smallest useful region. Make standalone copyable content keyboard reachable
with a suitable accessible name. Error alerts are selectable through their role.
Keep buttons, headings and collection items out of broad selectable wrappers.
Ctrl+A / Command+A must stay inside the focused text owner; never restore
document-wide selection through a key handler or native Edit menu.

For a shortcut, establish the focused owner, modifiers, repeat/composition rules,
availability, pending-edit behavior and cancellation/focus restoration. Extend
the existing owner; avoid a parallel global command dispatcher. Preserve text
editing, native pickers, collection/range selection, photo-wide history and the
Console copy-versus-interrupt contract. Do not blanket-cancel keyboard or pointer
events to make the app feel native.

Register focused behavioral coverage in `scripts/verification-plan.ts`. Reuse
`desktop-input-ui` and affected owner targets with isolated profiles. Native
focus, pointer selection and actual clipboard checks require foreground mode;
keep unavailable-device evidence incomplete.
