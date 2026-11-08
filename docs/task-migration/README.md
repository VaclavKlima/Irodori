# GitHub backlog migration audit — 2026-11-09

GitHub Issues in [VaclavKlima/Irodori](https://github.com/VaclavKlima/Irodori/issues)
owns task scope, priority and completion after this cutover reaches the default
branch. Implementation briefs, architecture and verification evidence remain in
the repository. These files are immutable migration records, not a second backlog.

## Frozen source and coverage

The source was frozen at
[65245e252e1beb9ec5fc768864c964be9f5509c1](https://github.com/VaclavKlima/Irodori/commit/65245e252e1beb9ec5fc768864c964be9f5509c1)
on November 8. The [inventory](source-inventory.json) retains both complete
backlog/index files, hashes and all 70 numbered entries, including continuation
paragraphs and shared evidence. It contains 36 completed and 34 open legacy tasks.

The [manifest](manifest.json) maps them to 89 issue destinations: 36 closed
historical deliveries and 53 initially open outcomes. Those open outcomes include
the four additional deferred roadmap decisions and the separate task skill.
Migration and skill issues close only after their respective checks and
default-branch delivery; their later closure does not change the historical count.
Read live status in GitHub.

Every legacy number has a destination in the
[static reference map](../features/README.md#workspace-feedback-backlog). All old
section anchors and `task-1` through `task-70` resolve. Issue numbers differ from
legacy TODO numbers.

## Reorganization

| Legacy source | Focused destinations                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 21            | macOS, Bazzite and Windows icon presentation; preserve delivered artwork and packaging.                                  |
| 32            | RAW decoder ownership, analysis, remaining merge kernels, retired-executor provenance, common HDR codec host.            |
| 37            | Linux paired/software-exposure acceptance, fidelity/recovery, native burst/bracketing feasibility, Windows feasibility.  |
| 54 and 63     | Refine Edge study, decision-gated implementation, local Dehaze, separate Texture and shared Clarity/local contrast.      |
| 57 and 59     | HDR agent delivery/inspection/matched comparisons; separate physical HDR qualification. Preserve delivered SDR evidence. |
| 58            | Gradient tools and compound coverage; preserve delivered core/workspace.                                                 |
| 66            | Automatic sky/background only; reuse delivered indicated-object selection.                                               |
| 69            | Bazzite object/workspace and whole-mask-edge qualification.                                                              |
| 70            | Migration/cutover, linked to the separate task skill.                                                                    |

The other 23 open tasks remain focused issues, distinguishing delivered behavior
from remaining acceptance. Four deferred roadmap outcomes cover measured camera
characterization, next HDR-format selection, native-reader HDR JPEG interoperability
and optional roll-off/output-brightness controls. Creating research issues does
not adopt an implementation.

The [source audit](source-audit.json) records 167 classifications: complete
numbered entries, repository references/follow-ups, planned-brief acceptance and
explicit exclusions. The 37 vendored upstream TODO/FIXME locations are excluded.
Archived aggregate goals, rejected algorithms and unadopted roadmap candidates
remain historical, rejected or unadopted. Remaining technical acceptance keeps
explicit owners; no unchecked criterion becomes a pass.

Historical merge TODO 29 in the workability, responsiveness and Bazzite handoff
documents means legacy 31, now [merge acceptance](https://github.com/VaclavKlima/Irodori/issues/35).
It does not mean current legacy 29's background deletion. The targeted corrections
preserve that document context without globally replacing bare numbers.

## Verification

The cutover requires:

- Structural skill validation and five independent, isolated behavior simulations:
  duplicate notes extend the owner; material ambiguity asks one question;
  interrupted creation recovers the saved record; local-only acceptance stays open;
  current-device delivery preserves an existing other-device handoff.
- Exact connector readback of every issue's saved content/state and actual
  dependency/related URLs, with fresh full-collection discovery for duplicate
  markers and missing destinations. Relative issue specification links become
  GitHub URLs; ignored artifact references remain labeled local evidence.
- Frozen-source/hash, many-to-many ownership, all 70 anchors, additional requirement,
  saved-body/state and duplicate-marker audits, plus formatting, changed-link and
  whitespace checks. Application/GPU/comprehensive suites are unnecessary here.

Run the deterministic audit from the repository root:

```sh
python3 .agents/skills/irodori-github-tasks/scripts/audit-migration.py \
  --snapshot artifacts/task-migration/2026-11-08/saved-issues.json
```

Omit `--snapshot` for an offline source/map check. A connector readback snapshot
may use normalized `issue_number/url` or GitHub `number/html_url` records. Evidence
and simulation results remain ignored under
`artifacts/task-migration/2026-11-08/`; local paths are not downloadable proof.
The manifest records expected body identities for open delivery issues and their
closed forms so closure can be verified without turning it into a live status file.

The connector initially lacked an installation on the repository owner's personal
account. Nine records were created through the authenticated CLI before that
fallback was stopped at the owner's request. The Irodori-only connector installation
was then authorized, a real write/readback passed, and subsequent issue publication and
verification used the connector. Those first records were reused.

## Resumption

Use the [task skill](../../.agents/skills/irodori-github-tasks/SKILL.md) and its
[migration procedure](../../.agents/skills/irodori-github-tasks/references/migration.md).
Discover both open and closed records by the immutable marker before creation;
after an uncertain response inspect recent records and read a found issue before
retrying. Never infer GitHub numbers from legacy numbers or titles.

Do not edit this frozen inventory to maintain future tasks. Change GitHub issues
and the relevant technical brief instead.
