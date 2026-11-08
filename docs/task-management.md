# GitHub task management

**Authority:** GitHub Issues owns task scope, priority and completion. The
[migration audit](task-migration/README.md) records the frozen source and cutover.

Use [GitHub Issues in VaclavKlima/Irodori](https://github.com/VaclavKlima/Irodori/issues)
for task scope, priority and completion. Keep implementation briefs,
architectural decisions and verification evidence in the repository. The
[legacy map](features/README.md#workspace-feedback-backlog) resolves historical
numbers; they are not GitHub issue numbers.

## Issue model

Each issue describes a problem/outcome, bounded deliverable, acceptance,
established dependencies, relevant briefs, verification and limitations. Scale
detail to the task. Separate delivered portions from remaining requirements.

GitHub open/closed state owns completion. For open issues, store **Type**,
**Workflow** and **Priority** in the body. Workflow is backlog, in progress,
blocked, deferred or awaiting delivery. A blocked item names a resumption
condition; deferred research retains its effort or adoption stop. Existing type
labels may aid discovery; the body remains the maintained metadata contract.
Priority preserves masking (P1), native-detail inspection (P2), then HDR visual
assessment (P3), ahead of stylistic effects. Other work stays unranked unless an
established decision ranks it.

Use explicit issue links for dependencies/related work. Use linked checklists
only when an outcome needs multiple issues. GitHub documents these relationships
in its [planning guide](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/planning-and-tracking-work-for-your-team-or-project).

## Agent workflow

Use the repository [irodori-github-tasks skill](../.agents/skills/irodori-github-tasks/SKILL.md)
for raw-text task creation, backlog additions, next-work recommendations,
implementation handoff and delivery updates. Search open and closed issues,
extend an existing owner where appropriate and read every saved mutation back.
An uncertain creation is resolved by exact provenance and recent records before
retrying. The stable migration marker survives title changes.

Task-management requests authorize issue operations. They do not independently
authorize feature implementation, publishing/merging code or adopting speculative
proposals. Ask only about scope or acceptance ambiguities that materially change
the outcome. Keep meaningful progress/blocker updates compact and preserve
decisions when splitting, merging or deferring.

Select one actionable bounded issue. Follow AGENTS.md for architecture, inputs,
current-device delivery and relevant verification. Keep passed evidence and
effort stops; do not resume an archived aggregate milestone. Current-device
acceptance can deliver its scoped issue while a linked other-device follow-up
records hardware, focused targets, expected behavior, gaps and resumption.

Locally accepted work awaiting required publication stays open with **Workflow:
awaiting delivery**. Close only after scoped acceptance and required default-branch
delivery are verified. A closed issue's old Workflow field is inactive. Historical
completed issues retain their original verification; migration does not repeat it.
Close superseded/rejected work with the appropriate reason and replacement links,
without presenting it as implementation completion.

## Migration records

The [migration audit](task-migration/README.md),
[many-to-many manifest](task-migration/manifest.json),
[frozen source](task-migration/source-inventory.json) and
[additional-source classifications](task-migration/source-audit.json) are static
cutover records. Current states and priorities belong exclusively in GitHub.
