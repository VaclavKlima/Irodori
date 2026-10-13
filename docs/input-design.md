# Adjustment input design

New inputs should be compact, neutral, and subtle. Use consistent spacing and typography, restrained hover feedback, and an unmistakable keyboard-focus outline. Numeric values use tabular digits and align to the right; units remain quieter than the value. Keep disabled controls visibly unavailable and errors readable without relying only on color.

Photo command menus follow the separate authoritative [menu design standard](menu-design.md): shared model/renderer, explicit targets, hidden structural mismatches, and concise accessible explanations for temporary blockers.

## Numeric slider adjustments

Use `AdjustmentInput` for new numeric slider controls. It presents a label and borderless editable value above a full-width slider, with an optional unit. Number steppers are hidden; clicking or tabbing into the value allows direct entry. Preserve its shared CSS Module styling instead of adding per-adjustment field styling or inline sizes.

Supply the label, current draft value, limits, step, display precision, optional unit, disabled state, and change/commit/cancel callbacks. Change `resetKey` when confirmed state replaces the gesture, such as a new edit revision. Key the owner by photo ID so text from one photograph cannot carry into another. Other new input types should use the same visual conventions with semantics appropriate to their control type.

Valid changes preview continuously. A drag or repeated slider-key gesture commits once on release; numeric typing commits on Enter or blur. Escape and pointer cancellation restore the starting state. Do not rewrite partial numeric text while the user types. Invalid or out-of-range values never persist; leaving invalid entry restores the confirmed value. Format the number to its configured precision outside active typing. Numeric fields retain normal text-editing shortcuts.

## Ownership and history

Inputs own presentation and input gestures only. Their owner owns validation, drafts, persistence, conflicts, and errors. All photo adjustments use the versioned settings document and main-process edit service, including MCP updates. Adding an adjustment extends that document through an explicit schema migration; it does not create a separate history stack.

Undo/Redo belongs in the photograph toolbar and applies to the active photo's shared history. Do not duplicate history buttons, reset buttons, or permanent save-status rows beside each slider. Entering a neutral value resets that adjustment. Put preparation status beside the preview and save/history failures in the workspace error area.

## Verification

Check keyboard focus, natural negative/decimal typing, Enter/blur commit, Escape cancellation, invalid input, and external confirmed updates. Check mixed adjustment history and persistence when adding a new edit type. Inspect native window sizing at 1100 × 700 with the console open; browser viewport emulation does not resize Electron's OS window.
