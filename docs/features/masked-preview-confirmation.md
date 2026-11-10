# Confirmed masked HDR preview

[Issue #102](https://github.com/VaclavKlima/Irodori/issues/102) owns this fix.

## Observed failure

A masked photograph could remain on **Loading preview…** indefinitely even after
source preparation, upload, mask atlas preparation and GPU rendering completed.
Read-only inspection of the user's Bazzite development window found a ready
source and mask pipelines, a completed presentation queue and an untouched hidden
canvas. The saved photo was still at revision 9 with ten history snapshots.
Private diagnostic state and hashes remain ignored under
`artifacts/diagnostics/masked-preview-2026-11-10/`.

The display guard compared raw durable `EditState.settings` (with `maskStack`)
to rendering parameters (with resolved `localMasks` and authoritative
`maskGeometry`). Those are different representations. Strict pixel equality
correctly rejected the mismatch, but no confirmed masked frame could be published.
Unmasked photos did not expose the missing mask fields.

## Fix contract

Construct confirmation independently from the confirmed photo edit state and its
immutable stroke/base content. Bind the authoritative source geometry used by
rendering. Never manufacture confirmation from live adjustment or mask drafts,
and never ignore spatial masks in the equality check. Prepared edge coverage is
an internal replacement for the same authored tree and does not change its pixel
identity.

Global gesture tokens must also retain the immutable mask coverage belonging to
their captured base revision, and include durable mask changes in their conflict
identity. Geometry belongs to the actual source/presentation owner. Preserve
photo, revision, source, target, draft and stale-gesture rejection.

This changes confirmation ownership, not mask algorithms, pixels, numerical or
resource gates, GPU selection, decoding or CPU/GPU failure policy. Other-device
verification remains incomplete. The existing managed Console MCP cancellation
failure in #101 is not claimed fixed by this diagnosis.

## Verification

Focused isolated regression and current-device receipts follow. Automated imports
use the committed Sony RAW and raster fixtures;
no user photograph or live diagnostics enter Git. A live development-window
check compares saved-settings/history hashes before and after preview recovery.

### Reproduction and live recovery

The isolated real RAW case failed before wiring the fix: source upload and frame
geometry were complete, but the masked frame remained loading. Baseline evidence:
`artifacts/verification/playwright-1794340742029-7bcb5a0b-b6da-429d-9729-7abde3c128b5/`.
After the fix, the exact case passes (1 case, 11.1 seconds): saved compound/edge
coverage, a global Exposure edit, navigation back through a source-cache hit,
and restart all reach normal, confirmed visible presentation. Saved settings
agree after restart. Receipt:
`artifacts/verification/playwright-1794341175044-05b884d7-4990-442d-9e06-4b4c67a84746/`.
Test setup uses renderer activation for imports; this regression verifies mask
confirmation rather than native import keyboard focus. Source uploads are checked
against actual cache ownership: one on fresh activation/restart and zero on a hit.

The user's existing development window recovered through the source update:
HDR WebGPU presentation reports `presented`, the normal-quality canvas is visible,
and completed/requested serials match. Read-only settings and complete-history
hashes match the pre-fix values exactly: revision 9, cursor 9, ten snapshots.
No user photo, mask, adjustment or history edit was performed to recover it.
Physical HDR luminance is not inferred from these diagnostics.

### Existing cache-test corrections

The first combined run passed static/build and fast checks but exposed four
failures in the existing exact-cache UI suite:
`artifacts/verification/2026-11-10T20-07-27.869Z-check-aqzrOW/summary.md`.
Full native captures proved that the photographic rows were identical; the
mismatches were sibling controls painted over the canvas bounds (SDR/Loading,
Undo state and the photo ordinal after a group expanded). The fixture now uses
the existing Toggle hover preference and moves focus/pointer outside the preview
before capture. Full native-canvas byte equality and the loading/editability
assertions remain unchanged; no pixel tolerance or production rendering changed.

The held-recovery observer also read the newest requested serial while an older
active request was submitting. Its two submitted/fenced blits were mislabelled
with one serial. The observer now binds actual canvas blits to the production
`normalCanvasSubmittedSerial` at their real fence. It retains the unique-source,
submission, fence, hash and byte-equality requirements.

The second combined run passed 1,036 cases, including eight of the nine cache UI
cases, with no skipped cases. The remaining cache case reached a hidden Undo
button after capture moved focus outside the preview. Focusing the real Undo
button before its existing pointer click restores that fixture's interaction;
its stale-reply, Inspector and exact-pixel assertions then pass unchanged. The
original failed invocations remain retained rather than being marked passed:

- Combined receipt:
  `artifacts/verification/2026-11-10T20-18-20.288Z-check-Tha4EU/summary.md`.
- Exact remaining cache case: 1 passed in 9.7 seconds,
  `artifacts/verification/playwright-1794342124713-3cf8579e-85ab-462c-9e74-3721c0e3fc3d/playwright/summary.json`.

The combined receipt also covers confirmation snapshots, edit-gesture commits,
HDR gesture handoff and HDR presentation-cache model tests, plus type checking,
lint, formatting and the application build. An independent production-diff
review found no blocker. No comprehensive checkpoint or benchmark was run.

### Complete focused acceptance on Bazzite

The remaining browser targets all pass in the final invocation: 1,033 cases,
zero failures/skips, 101.26 seconds, foreground. Type checking, lint, formatting,
build and fast tests pass. The five actual GPU/UI cases cover saved compound RAW
activation/global edit/cache return/restart, brush-mask pixel identity and history,
neutral-mask histogram stability, production SAM2 object coverage and native HDR
histogram, and object geometry while zoom/pan are pending.

Targets: `masked-preview-confirmation-ui`, `masks-hdr-ui`,
`object-selection-presentation-ui`. Receipt:
`artifacts/verification/2026-11-10T20-23-57.680Z-check-SA4wEH/summary.md`.
Together with the retained eight cache passes and exact remaining cache rerun,
this completes the selected focused checks. Counts from repeated fast checks are
not added together. The run exceeded the routine 60-second budget; the slowest
test was 13.86 seconds, and no assertion was removed or cut short.

macOS, Windows and unavailable presentation paths remain incomplete under
[issue #99](https://github.com/VaclavKlima/Irodori/issues/99), which links this
confirmation regression. This fix does not claim physical HDR luminance
qualification or resolve the independent managed Console failure in #101.
