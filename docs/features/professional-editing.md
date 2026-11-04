# Professional editing: individual tasks

## Current delivery approach — 2026-11-01

The user requested splitting the oversized professional-editing goal into
individual TODO items because it was taking too long. The
[workspace backlog](README.md#workspace-feedback-backlog) is now the source of
work scope and completion status. Select one item for a small goal; finish its
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
selective copy/paste with bounded batch application. Adjustments use persisted
photo-wide history; resize choices belong to frozen export settings/jobs. Both
use the typed application/MCP API.

Inspector items #26–28 are complete for their recorded Bazzite scope. Combined
RAW/raster/gain-map/v4-merge edit/export/restart, native keyboard/minimum-size,
source/resource protection and full-size 1.25× SDR/HDR export have focused passes.
The [processing ledger](professional-editing-processing.md) and individual briefs
retain their precise source, hardware, settings and platform limits. The owner authorized consolidating these changes into `main` on 2026-11-01.
Preserve this checkpoint and its explicit limits when selecting later work.

Noise reduction v1 is weak on strong high-ISO noise. C16 and the BM3D trial failed
their adoption gates and remain unenabled. Physical picker accuracy under two
measured illuminants, broader photographic appearance and remaining sustained
performance are unverified. Curves have focused Bazzite acceptance with explicit
[clipping/platform/activation limits](tone-curves.md). Named presets, final-size proof and output
sharpening are not available. FSR is an optional evaluation, with standard
upscaling already available.

## Task index

These rows move existing scope into independently selectable items; they add no
new feature requirement. The full descriptions and finish lines live in the
backlog, rather than a second aggregate checklist here.

| TODO                     | Work                                             | Current state / dependency                                                                                                              |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [#38](README.md#task-38) | Consolidate the existing editor changes          | Complete for the publication checkpoint; remaining quality/research tasks stay open.                                                    |
| [#39](README.md#task-39) | Improve strong-noise removal                     | Quality unresolved; review existing results before authorizing another bounded study.                                                   |
| [#40](README.md#task-40) | Finish photographic color review                 | Functional tools and one native skin review exist; review only missing declared subjects/domains.                                       |
| [#41](README.md#task-41) | Finish detail-sharpening appearance review       | Functional and cancellation/contention checks exist; keep strong-noise research in #39.                                                 |
| [#42](README.md#task-42) | Finish crop/enlargement appearance review        | Functional and full-size exports exist; remaining native texture/ringing comparisons only.                                              |
| [#43](README.md#task-43) | Measure white-balance picker accuracy            | Deferred research; required target/meter and a qualifying cohort are unavailable.                                                       |
| [#44](README.md#task-44) | Resolve remaining performance/resource questions | Separate from feature work; native-120 investigation retains its effort stop.                                                           |
| [#45](README.md#task-45) | Add Master/RGB tone curves                       | Complete for focused Bazzite acceptance; photographic, native, timing and bounded compatibility evidence and limits in the curve brief. |
| [#46](README.md#task-46) | Add named versioned presets                      | Reuse implemented selective transfer and batch/history services.                                                                        |
| [#47](README.md#task-47) | Add final-output-size proof                      | Reuse standard export sizing and frozen settings.                                                                                       |
| [#48](README.md#task-48) | Add export-only output sharpening                | Depends on #47 for trustworthy output-pixel review.                                                                                     |
| [#49](README.md#task-49) | Evaluate optional spatial FSR                    | Optional later task; a justified rejection is a valid outcome.                                                                          |
| [#51](README.md#task-51) | Adopt List + Beside browser navigation           | Complete for local Bazzite acceptance; collection, selection, menus and recovery preserved.                                             |

Reuse existing #10 for general Linux dropdowns and #32 for the remaining GPU-first
consolidation. The [stage inventory](../processing-stages.md) records current owners, retired executors, rejected candidates and remaining platform/removal gates. UI work follows the implemented #33 inspector navigation and #34
[Sunflower design system](../design-system.md). Keep #25 shutdown recovery,
#29 background deletion, #30 queue redesign,
#31 merge acceptance, #35 asset migration and camera/branding tasks separate.
Do not duplicate or automatically pull these items into an editing task.

## How to work on a task

- State the selected TODO, concrete deliverable, relevant source/hardware scope
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

Masking remains later work. Its real prerequisites should be scoped when that
feature is selected; optional FSR, unavailable calibration equipment and every
advanced global tool are not automatic blockers for all future development.

## Remaining Goal 1 evidence — 2026-11-01

The [archived evidence map](professional-editing-history.md#remaining-goal-1-evidence--2026-11-01)
preserves the former exit requirements. Unfinished areas are now assigned to
#39–44 above; none was converted to a pass. The functional receipts remain in
[professional-editing processing](professional-editing-processing.md), with
operator details in [color](color-mixer-grading-processing.md),
[detail](detail-processing.md), [crop](crop-straighten.md),
[upscaling](upscaling.md) and [selective transfer](copy-paste.md).
