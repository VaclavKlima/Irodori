---
name: irodori-ui
description: Implement or review Irodori application UI, controls, layouts and interaction states using the approved Sunflower design system. Use for renderer presentation and UI workflow changes in this repository.
---

# Irodori UI

Read `docs/design-system.md` from the repository root. It describes the final
computed styles of `docs/design/prototype.html`; early prototype rules are not
the selected design. Render the prototype's final Sunflower state first and match
its actual hierarchy, controls, spacing and dimensions. Compare the same content
sizes and settled tool state; exclude only the study toolbar. Run the registered
`sunflower-fidelity` target for dimensions and screenshots. Update documentation
after matching production to the prototype, never use documentation to justify
an approximation of the reference.

Reuse `src/renderer/src/tokens.css`, `components/ui/Controls.tsx`,
`AdjustmentInput`, `InspectorSection`, `PhotoContextMenu` and the collection
controller. Read the relevant input, menu or scrolling guide when changing its
behavior. Extend existing components before adding another presentation pattern.

For shortcuts and selectable/copyable text, use the repository
[Irodori input skill](../irodori-input/SKILL.md) and its authoritative input guide.
Preserve native field and Console input while keeping app chrome unselectable.

Native selects in the main application document automatically inherit the shared
Wayland picker guard; add no per-control refresh workaround. Follow the
[dropdown and focus contract](../../../docs/input-design.md#dropdowns-and-native-picker-stability)
when adding controls or editing focus/dismissal behavior. It covers renderer-only
versus native window blur, custom dropdowns and the applicable focused tests.

Keep the photograph dominant, surfaces neutral and actions/focus Sunflower yellow.
Bundle fonts/icons locally. Preserve the labelled editing rail, pinned histogram,
independent scrolling and native 1100 × 700 Console-open usability.

Presentation owns no persistence or processing. Keep hidden tool panels mounted,
flush valid drafts before navigation, preserve invalid-entry cancellation,
external revisions, active/selected identity, photo-wide history and typed workspace
recovery. Use existing edit services for atomic group resets; respect crop guards
and fixed lens corrections. Source indices own collection loading/selection;
revision-bound geometry owns visual navigation. Never add demo photos or invented metadata.

Select affected targets from `scripts/verification-plan.ts`. Use isolated profiles
and the shared hidden launcher; opt into foreground only for native interactions.
Read each run's short summary before logs. Visually compare changed surfaces and
record unavailable-platform acceptance explicitly. Do not add processing benchmarks
or comprehensive checkpoints for presentation work.
