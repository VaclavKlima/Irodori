# Masked photo navigation — issues #116 and #117

[#116](https://github.com/VaclavKlima/Irodori/issues/116) owns the reported severe
pan/zoom lag with local masks on Bazzite. It is separate from the stopped
slider-pacer/native-120-Hz study in #46.

## Cause and implementation

The reported photo has four masks, including prepared range/edge coverage. A
read-only profile found a roughly 7.7 MB encoded range plane being repeatedly
walked by JSON serialization during view-only React renders. Preview drag-cancel
and clipping identities, SDR/HDR analysis keys and the presenter's analysis
publication key all participated, even when the image tile cache did no new
pixel work. The real gesture callback also cloned the full mask parameters twice
per move and retained another copy in each performance-timeline measurement.
Direct presenter redraws bypass that callback, so they alone cannot establish
responsive dragging. The user's initial feedback exposed this missing path.

The existing mask controllers now keep immutable parameter objects stable.
Preview and analysis serialize their full identities only when those objects or
their actual pixel dependencies change. Native analysis identity still includes
source, revision, target, domain, comparison and publication ownership. Display
diagnostics alone do not invalidate clipping's pixel target. Full worker payloads
remain available when analysis actually needs a new job.

The gesture callback now captures its immutable drawing parameters once per
edit/coverage change. Performance records retain bounded global control metadata
and scale, with no encoded masks or lens tables. Ordinary view frames no longer
copy large mask payloads into the presenter or the diagnostic timeline.

The HDR presenter reuses one detached parameter snapshot across view-only
requests. A new input object or changed pixel key creates a new snapshot; pending
requests retain their captured values. The normal-publication retry hint uses
the existing pixel identity instead of serializing PNG bytes. That hint remains
separate from authoritative source/revision/target confirmation. Disposal releases
the retained snapshot with the existing GPU-owned state.

No shader, mask order/coverage, color operator, source geometry, sampling quality,
tile-cache policy, GPU backend, resource ceiling or error/retry contract changes.
New source tiles still need their ordinary rendering; warmed navigation reuses
the prepared masks and cached pixels. Original files and edit history remain
unchanged by view-only interaction.

## Verification scope

`hdr-navigation-snapshot` checks detached capture, reference reuse and replacement
on actual changes. `masked-navigation-ui` imports the tracked Sony RAW into an
isolated library, authors a range mask with edge preparation and local Light/Color,
and instruments actual JSON calls and structured clones during warmed pan/zoom.
It checks zero encoded coverage serializations/clones or retained timeline
payloads, no tile/source-upload or histogram restart, exact normal reference
policy, unchanged history and correct invalidation after a local edit.
Its hidden-window timings are diagnostic, not native input/display acceptance.

Reuse affected `masked-preview-confirmation-ui`, `hdr-histogram-lifecycle`,
`hdr-presentation-cache`, `hdr-render-cache` and `hdr-gesture-handoff` checks.
Live private profiles and failed exact reruns remain ignored under
`artifacts/mask-navigation-performance/` and `artifacts/verification/`. No private
photograph or diagnostic payload is added to the repository. Final scoped results,
available-device measurements and other-device limits are recorded in #116.
macOS/Windows follow-up is
[#117](https://github.com/VaclavKlima/Irodori/issues/117).

## Current-device feedback — November 13, 2026

After the actual gesture-copy correction was loaded, the user confirmed
"Yes, it is responsive now." This accepts the reported interaction on the open
Bazzite photo, not universal native frame-rate or cross-platform qualification.
Bounded visible-window wheel-handler probes include warmed navigation and larger
pans exposing additional tiles, with GPU completion, exact view restoration and
unchanged edit history. All user-photo evidence remains private and ignored.
The existing processed-tile cache is reused; no additional full-image cache,
memory-limit increase or changed sampling policy was needed for this correction.

The final seven-target selection passes 1,070 cases with no failures or skips in
94.65 s, including cheap prerequisites, type checking, lint, formatting and build.
The 60-second routine budget warning is retained: the new hidden RAW navigation
case takes 31.72 s and the existing masked-confirmation case takes 8.29 s. No
assertion or quality gate was removed to meet that budget. The final run is
`artifacts/verification/2026-11-13T09-17-27.294Z-check-y3hBpP/summary.md`.

Two bounded visible-window probes exercise the production wheel handler at 100%
on the reported 2901 × 3627 photo in a 2782 × 945 canvas. Sixteen warmed updates
take 24.7–34.6 ms, with no new tiles; sixteen larger-movement updates take
21.2–35.6 ms, including eight newly computed tiles. Both await GPU completion,
restore the original view and preserve complete edit history. These are synthetic
wheel-handler timings, not physical-input or native-120-Hz certification. The
earlier same-view direct-presenter timings are not substituted for this evidence.
Local evidence and source hashes: `artifacts/mask-navigation-performance/summary.md`.

## macOS qualification — November 16, 2026

[#117](https://github.com/VaclavKlima/Irodori/issues/117) records bounded Mac
acceptance. This revision includes the qualified corrections and tests. Work
started from clean main
`adf9c3a7189fc3bcb5067600b223f3fd03f4ec57`. Windows remains outstanding;
[#80](https://github.com/VaclavKlima/Irodori/issues/80) retains the Bazzite
foreground/regression handoff. The verified publication receipt is maintained in
#117; the measurements below retain their original source base and exact attempts.

The current device is macOS 26.7 (25G229), Apple M4 Pro, 24 GiB unified memory,
with Dawn Metal and ANGLE Metal (Apple driver 26.7), bundled Node 24.20.0,
Electron 44.3.0 and Playwright 1.63.0. The checked native mask, accepted C++ codec
and SAM 2 model distributions from #122 were reused and validated by application
builds. An attempted native rebuild found no Cargo; it did not replace those
distributions. Sunflower reference/layout evidence from #122 remains applicable;
the additional native Texture/Console capture was reviewed on the corrected code.

### Portable corrections found during qualification

The RAW pilot reproduced roughly 67–75 ms warmed p95. A bounded CPU profile
attributes about 5.0 seconds across 96 updates to `validateMaskBaseContent`:
the same prepared PNG was validated twice while planning each atlas. The HDR
presenter now retains its validated atlas plan for the exact detached immutable
parameter snapshot and active-mask state. Replacement snapshots validate again,
including damaged content with an unchanged advertised hash; disposal releases
the plan. New tiles retain all existing validation and completion boundaries.

The complex Texture case also exposed a deterministic readiness failure:
`PhotoPreview` selected frozen Texture parameters without the prepared edge/range
planes attached by the current coverage owner. A delayed shader redraw then
threw “Mask edge coverage is not ready.” Matching authored pixel settings now
bind those prepared planes to the frozen source geometry. Changed drafts wait
for their matching Texture frame; drawing and analysis cannot authorize the old
recipe with new edits. Regression checks cover matching compound coverage and
rejection of changed Light, coverage and Texture inputs.

Both corrections use the existing common owners. Mac keeps reference arithmetic,
tile batch 32 and disabled exact-frame presentation caching. No shader/operator,
quality/resource ceiling, backend, public API, persisted setting, migration or
rendering-version policy changed. Saved-mask activation, global edits, photo
switching and restart now run independently of the separately skipped cache-hit
assertion.

### Protocol and results

The explicit-only, exclusive `raw-gpu` target `masked-navigation-native` has six
foreground cases. It uses the shared isolated Electron launcher and native
focus/pointer-lock helpers, with committed `tests/fixtures/sony-zv1.ARW`
(5422 × 3622) and the licensed flamingo fixture (2344 × 2708). The RAW has a
luminance range, prepared feather and local Light/Color. The flamingo has four
roots: accepted SAM 2 bird coverage with manual leg corrections/edges, luminance
range, linear gradient with radial subtraction, and brush coverage. Texture is
tested at 0 and +25 on the generated root. Source/model/coverage and prepared
candidate/union hashes are retained in the local result record.

Each configuration uses actual native 1100 × 700 content with Console open and
1440 × 900 with Console closed. Both report DPR 2; measured backing sizes are
948 × 806 and 1564 × 1558 respectively. Preparation and inference finish before
timing. The recorder requires the matching photo/revision/source/target, completed
request, full-resolution visible canvas and normal reference HDR output. Raster
uses its ordinary full-quality WebGL route; Texture additionally requires matching
prepared keys and completed preparation.

After five pan and zoom round trips, each case collects three batches of sixteen
pan and sixteen pointer-centered zoom/reversal updates through the production
wheel handler. Timing starts at renderer input capture, waits for matching GPU
completion, then observes a following animation frame. A replaced completion is
followed through its final matching observation, including that extra latency.
Native Chromium wheel delivery and middle-button lock/drag/release are checked
separately. These are elapsed software completion measurements, not hardware
compute timestamps or physical display scanout.

| Configuration         | Content size | Observation p95 | p99 / maximum | GPU completion p95 |
| --------------------- | ------------ | --------------: | ------------: | -----------------: |
| RAW range             | 1100 × 700   |         17.1 ms |       17.3 ms |            14.0 ms |
| RAW range             | 1440 × 900   |         17.1 ms |       25.1 ms |            15.6 ms |
| Flamingo, Texture 0   | 1100 × 700   |         24.8 ms |       25.3 ms |            17.4 ms |
| Flamingo, Texture 0   | 1440 × 900   |         25.3 ms |       28.9 ms |            22.0 ms |
| Flamingo, Texture +25 | 1100 × 700   |         25.2 ms |       25.4 ms |            18.0 ms |
| Flamingo, Texture +25 | 1440 × 900   |         25.3 ms |       36.9 ms |            22.0 ms |

All 576 warmed samples meet p95 ≤33 ms, p99 ≤50 ms, no stall over 100 ms and
full-quality completion p95 ≤200 ms. Warmed navigation performs zero encoded
coverage serializations/clones, retained encoded timeline payloads, GL source
uploads or histogram readbacks, with unchanged source/preparation/histogram
identities and no coverage-preparation IPC. Separate larger RAW pans compute
16 and 28 new tiles; those costs are excluded from the warmed distributions.
Raster navigation reuses prepared resources. Each 17-input rapid reversal
coalesces sixteen inputs. Restoring Fit preserves full history and both source
and managed original hashes. A real local edit creates one history entry,
changes the displayed pixels and relevant analysis/Texture identity, then passes
navigation again. All six restored-photo captures show the settled photograph.

### Receipts, cleanup and limits

The final background selection includes the seven issue targets plus
`masked-texture-preview-gpu`, `raster-spatial-comparison` and `comparison-ui`:
**1,049 passed, 0 failed, 35 unavailable, 68.26 s**. The final foreground selection
adds `masked-navigation-native` and `mask-texture-ui`: **1,050 passed, 1 failed,
34 unavailable, 149.76 s**. Its last navigation case failed native pointer-lock
acquisition; the exact unchanged case passes in **16.17 s**. Preserve the failed
batch and earlier diagnostic attempts: this is reconciled evidence, not a clean
single invocation or proof of reliable acquisition on every automated attempt.

Reconciliation gives **88 distinct selected feature/regression cases plus 971
other cheap Node passes = 1,059 passes**. Type checking, lint, formatting and
application builds pass. The 34 actual-Linux-only Node checks and one
Mac-disabled exact-frame-cache check remain incomplete. Routine budget warnings
are retained; no assertion was removed to shorten a run. Across 42 recorded
Electron launches and 39 isolated profiles, all windows closed, policy violations
were zero and all profiles were removed.

Local report and exact source hashes:
`artifacts/masked-navigation/2026-11-16-macos-qualification/{summary.md,details.md,result.json}`.
Accepted receipts are `artifacts/verification/2026-11-16T11-30-10.349Z-check-MNMHyk/`,
`2026-11-16T11-31-27.049Z-check-cd5W5s/` and the exact native rerun
`playwright-1794828855570-450cf956-c728-4402-bbdd-aab289976470/`.
Ignored evidence is local, not downloadable GitHub proof.

Windows, Bazzite regression of these corrections, physical mouse/trackpad feel,
120 Hz, sustained frame rate and physical HDR remain unqualified. The stopped
#46 slider-pacer study stays separate. No resource refusal was forced or bypassed;
larger/adversarial resource cases retain their existing availability limits.
