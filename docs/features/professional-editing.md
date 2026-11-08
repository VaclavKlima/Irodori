# Professional editing: individual tasks

## Current delivery approach — 2026-11-01

The user requested splitting the oversized professional-editing goal into
individual tasks because it was taking too long. The
[GitHub issue backlog](https://github.com/VaclavKlima/Irodori/issues) is the source of
work scope, priority and completion status. The [legacy map](README.md#workspace-feedback-backlog)
preserves old references. Select one item for a small goal; finish its
bounded deliverable and relevant checks before selecting another.

The former Goal 1 / Goal 2 order is retained as
[historical planning and evidence](professional-editing-history.md), rather than
a requirement to complete every feature and research study together. Unfinished
work remains on the backlog. This change neither accepts failed quality gates
nor claims the old goal is complete. Replanning does not itself create or resume
a coding goal.

## Working features to preserve

The existing checkout implements Light controls, Saturation/Vibrance, supported
Sony RAW white balance and neutral picking, Master/RGB curves with photo targeting,
the eight-range HSL mixer, three-way
grading, nondestructive crop/straighten, single-image luminance/chroma noise
reduction v1, detail sharpening, standard Lanczos3 export sizing/enlargement and
selective copy/paste and [named presets](named-presets.md) with bounded batch application. Adjustments use persisted
photo-wide history; resize choices belong to frozen export settings/jobs. Both
use the typed application/MCP API.

Legacy inspector items #26–28 are complete for their recorded Bazzite scope. Combined
RAW/raster/gain-map/v4-merge edit/export/restart, native keyboard/minimum-size,
source/resource protection and full-size 1.25× SDR/HDR export have focused passes.
The [processing ledger](professional-editing-processing.md) and individual briefs
retain their precise source, hardware, settings and platform limits. The owner authorized consolidating these changes into `main` on 2026-11-01.
Preserve this checkpoint and its explicit limits when selecting later work.

Noise reduction v1 is weak on strong high-ISO noise. C16 and the BM3D trial failed
their adoption gates and remain unenabled. Physical picker accuracy under two
measured illuminants, broader photographic appearance and remaining sustained
performance are unverified. Curves have focused Bazzite acceptance with explicit
[clipping/platform/activation limits](tone-curves.md). [Final-size JPEG proof](output-proof.md)
is available in Custom export and Console, with separate [output sharpening](output-sharpening.md)
for frozen JPEG output.
FSR is an optional evaluation, with standard
upscaling already available.

## Task index

Select current work in [GitHub Issues](https://github.com/VaclavKlima/Irodori/issues).
The [static legacy map](README.md#workspace-feedback-backlog) resolves every
former TODO number, including split and shared requirements; this guide does not
maintain a second status table.

Preserve masking → native-detail inspection → HDR visual assessment before
additional stylistic effects. Optional research, unavailable calibration and
unrelated queue/merge/branding work stay independent. Current-device delivery
uses linked hardware follow-ups rather than claiming cross-platform acceptance.

Use the [task-management skill](../../.agents/skills/irodori-github-tasks/SKILL.md)
and [issue policy](../task-management.md) for creation, selection, progress,
blockers and completion. Technical decisions, rejected candidates and exact
verification receipts remain in the briefs, processing ledger and stage inventory.

## How to work on a task

- State the selected GitHub issue, concrete deliverable, relevant source/hardware scope
  and stopping condition before coding. One task need not solve another task's
  research, performance or platform questions. Record only demonstrated
  dependencies, such as output sharpening needing final-size proof.
- Reuse existing code, fixtures and evidence. Run the registered targets affected
  by actual changes; do not rerun passed suites merely to close the old umbrella
  goal. Comprehensive checkpoints require separate agreement. Documentation-only
  changes need formatting/link/whitespace checks, not Electron or GPU runs.
- Preserve originals/masters, history, HDR/SDR contracts, frozen exports,
  cancellation, resource limits and explicit capability handling for the affected
  behavior. Follow the [GPU-first direction](../gpu-processing.md); do not build
  duplicate production CPU backends or CPU repair/fallback paths.
- Apply the [effort/benefit policy](../performance-decisions.md). Expensive
  committed denoising may load while the interface remains usable. Review one
  focused diagnosis and candidate before another substantial research cycle;
  ask before expanding costly uncertain work.
- Report implemented behavior, checks and remaining limitations. A deferred task
  stays open, and a failed threshold stays failed. Fix a newly discovered
  correctness regression or record a concrete dependency; do not silently expand
  the selected goal into the entire roadmap.

Masking prerequisites should be scoped when a task is selected, following the
editing-quality priority above; optional FSR, unavailable calibration equipment and every
advanced global tool are not automatic blockers for all future development.

## Remaining Goal 1 evidence — 2026-11-01

The [archived evidence map](professional-editing-history.md#remaining-goal-1-evidence--2026-11-01)
preserves the former exit requirements. Unfinished areas are now assigned to
[legacy tasks 39–44 and their GitHub destinations](README.md#workspace-feedback-backlog); none was converted to a pass. The functional receipts remain in
[professional-editing processing](professional-editing-processing.md), with
operator details in [color](color-mixer-grading-processing.md),
[detail](detail-processing.md), [crop](crop-straighten.md),
[upscaling](upscaling.md) and [selective transfer](copy-paste.md).
