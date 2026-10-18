# Mac workability

This milestone improves the current production pipeline on the M4 Pro. Sharp
detail takes priority over presenting every intermediate input. Processing-graph,
native-service and decoder research remain separate. Disabled controls and the
read-only Console retain their existing scope. Mac acceptance remains **failed / incomplete**:
sharp frames and numerical checks pass, but sustained interaction, three-RAW
five-second merging and GPU-versus-legacy preview performance miss their gates.
The final 2/3/5/9-source noise family passes its existing 15-second gate. Cold
export has an intermittent first-launch miss. Hardware and Linux gaps remain open.

Implementation branch: `perf/mac-workability`, based on upstream research revision
`3c5fcb1` (fast-forwarded from `c69c40f`). The October 16 production and verification
handoff was `03d633ceeed05ec06c6b627508d393ae8e9dd3b5`; the October 17 handoff is
recorded in the acceleration section below. Follow-up commits
`fc6674b`, `5565f79` and `34ce777` implement capture batching, exact merge work
reduction and linear tile workgroups; `03d633c` records their acceptance contracts.
Measurements for that earlier handoff retain actual revision/dirty state and
source/build hashes. Its subsequent report, README and testing-guide changes were
documentation only. The original milestone below retains its `cedef59` code,
`980435a` pixel-processing and `0b4f99f` early editor/export provenance. Linux
acceptance remains pending.

## October 17–18 competitive HDR workflow pass

The bounded Mac pass is implemented, verified and frozen; **competitive acceptance
remains failed**. The final visible-workflow replay measures an **18.220 s median
and 18.779 s maximum**, versus the matching 24.817/25.572 s baseline. This is a
26.6% median reduction, but neither the 10 s median / 12 s maximum target nor the
15 s visible engineering checkpoint is met. Five seconds remains the separate,
unmet service stretch. No timing or numerical gate was relaxed.

Production changes are `9c2db1604ce56b67d1eb72ac588c99a24e6de3f1`; the isolated
GPU study is `a739a0ce9f6b3507ec4f5f7dc174d6f41a85a116`. The latter is the
**implementation freeze for Bazzite**, with documentation-only descendants allowed.
These commits are local. Measurements retain their actual `81bec53` dirty-state
provenance and source/build hashes: all 24 final replay inputs still match the
frozen implementation. The earlier handoffs below remain historical evidence.

| Task                           | Owner                   | Dependencies                     | Adopted result / decision                                                                                                                                                          | Commit    |
| ------------------------------ | ----------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| N0 — Matching Luma clocks      | Coordinator             | `81bec53`, committed HDR bracket | Native decode/draw/fence/post-paint review; immediate acceptance; uninterrupted final editor clock. Baseline, five-run series and restart controls retained.                       | `9c2db16` |
| N1 — Critical-path attribution | Coordinator             | N0                               | Bounded worker-relative spans, alignment submission/admission/completion, separate main publication and verification/sync/cleanup durations.                                       | `9c2db16` |
| N2 — Fallback scheduling       | Coordinator             | N1                               | Reference-first source order retained; early alignment precedes unchanged fallback. Actual fallback/alignment overlap is 1.66–1.70 s in the final service replay.                  | `9c2db16` |
| N3 — Ordered reductions        | CPU agent               | N1–N2                            | Exact Float64 camera sums and per-update Float32 fallback sums; two live rows, arena preflight and transactional scalar replay.                                                    | `9c2db16` |
| N4 — Clipping and masks        | CPU agent               | N3                               | Compiled canonical/channel sensor masks and atomic boundary repair preserve the original 64/128/256-row producer boundaries.                                                       | `9c2db16` |
| N5 — Publication               | I/O agent + coordinator | N1                               | Attributed both validations, copying, sync, admission, journal, commit and cleanup. Publication algorithm remains unchanged: no repeatable multi-second I/O opportunity was found. | `9c2db16` |
| N6 — GPU preparation study     | GPU agent               | N2–N5                            | Fresh evidence clocks and cancellation/device-loss recovery pass; complete merge integration remains unvalidated. Production enabling rejected.                                    | `a739a0c` |
| N7 — Acceptance / handoff      | Coordinator             | N0–N6                            | Focused checks and sequential performance replays complete; speed and existing slider-latency misses retained. Linux measurements remain pending.                                  | `a739a0c` |

The optional binary is ABI/manifest 3, 9488 bytes, reproducibly built with pinned
Emscripten 4.0.20. Its SHA-256 is
`8ae83ee75c22b1489c64eb7f5400326e1c4db1c074e482729c14c7cc1c6c7771`.
The 128 MiB aggregate preparation arena remains enforced. An optional reduction
allocation miss keeps compiled conversion and bounded scalar reduction. Late
reduction failures restore live state before scalar replay; failed repair never
publishes partial RGB, alpha or changed positions. Pixel policy and cache identities
remain unchanged, including legacy manifests without a stored source identity.

### Comparable visible results

The new `merge-workflow-benchmark` target belongs to the sequential foreground
merge family. It uses `DSC03243.ARW`–`DSC03245.ARW`, actual native image decoding,
a real review draw, completed WebGL work when applicable and a post-paint task.
It accepts immediately and retains one uninterrupted renderer clock through
publication, cleanup and a sharp final editor frame's post-paint observation.
Import, startup and human review are outside the clock. Every operation prepares
the sources afresh. The source library is isolated; OS/driver caches are uncontrolled.

| Series                                  | Ordinary samples (s)                       | Median (s) | Maximum (s) | Separate restart (s) |
| --------------------------------------- | ------------------------------------------ | ---------- | ----------- | -------------------- |
| Matching baseline, three-run experiment | 24.098 / 24.817 / 25.572                   | 24.817     | 25.572      | 23.924               |
| Candidate merge family, five runs       | 18.494 / 18.492 / 18.933 / 18.059 / 18.468 | 18.492     | 18.933      | 18.082               |
| Final build exact replay, five runs     | 18.220 / 18.403 / 18.202 / 18.779 / 17.861 | 18.220     | 18.779      | 18.366               |

Both five-run series fail the competitive and intermediate visible gates. All
review backends are the application's actual Canvas2D fallback; final editing uses
WebGPU HDR at normal detail. The first draft incorrectly required WebGL review and
stopped after one operation in each case. Its partial-series 28.511/23.601 s results
remain retained separately, with incomplete integrity assertions; they are not
substitutes for the complete baseline series. The recorded Lightroom 10.038 s
median / 10.529 s maximum remains faster. Different precision, crops and publication
work still prevent an equal-work or cross-application quality claim.

[Baseline evidence](../artifacts/merge-lightroom-2026-10-17/baseline/artifacts/verification/playwright-1792235997919-8646cea5-bf11-42a4-97b6-a67fe4ca81f5/playwright/summary.json),
[candidate family](../artifacts/verification/2026-10-17T11-28-36.657Z-benchmark-59bn3O/summary.md),
[final replay](../artifacts/verification/playwright-1792237140413-50bfcfc6-9318-4eac-88c4-6164d7cb6696/playwright/summary.json),
and [all retained samples and timing breakdowns](../artifacts/merge-lightroom-2026-10-17/outcomes.json).

### Remaining critical path and regression results

The candidate family service HDR runs are 15.139/14.780/14.710 s, compared with
18.801/19.205/19.007 s before this pass. The final exact replay is
15.203/15.075/15.326 s. Every preparation/registration/mask/crop/master identity
matches the frozen pre-acceleration CPU reference. Three-source noise is
7.602/7.560/7.501 s in the family and 8.651/7.907/7.481 s in the isolated replay;
all samples, including the slower first replay, remain retained. These service
clocks include diagnostics and omit Electron presentation; they cannot replace
visible acceptance.

Final HDR worker spans expose 4.38–4.50 s of source preparation, 4.20–4.23 s of
highlight-safe fallback, 0.12–0.13 s of remaining registration, 0.22–0.25 s of
coverage, 1.42–1.48 s of accumulation and 3.03–3.32 s of output. The 1.66–1.70 s
alignment overlap is already hidden inside preparation/fallback; parallel matching
and nested durations must not be added again. Source/fallback preparation and
native output remain the main processing bottlenecks.

Durable service publication costs 0.85–0.99 s, plus 0.16–0.18 s cleanup. Source and
destination checksum work account for roughly 0.44 s together; copies are about
0.25 s, with file sync around 0.02–0.03 s. The visible family additionally records
1.66–2.09 s of main scheduler admission after acceptance, then 0.59–0.72 s of
final editor presentation after observed task completion. This identifies a further
application scheduling cost; changing foreground editing priority was not adopted.
Dropping validation or durable sync would not establish the required safe workflow.

The full foreground merge family has **12 passed, four time-gate failures, zero
skips in 501.74 s**. Its prepared 2/9/32, repeated-original calibration and distinct
2/3/5/9-source noise cases pass. Distinct maxima are **6.956/7.746/9.676/12.889 s**, all
within their unchanged 15 s bound. All sixteen warmed merge gestures pass. The
four exact failed-case replays retain only the same time misses, in 205.46 s.
Strict-series reported peaks are 932,630,072 logical GPU bytes and 145,358,848
merge/alignment WASM bytes, below 1 GiB / 512 MiB. Maximum worker RSS is
2,423,750,656 bytes, below the earlier 2,492,301,312-byte series. Driver allocations
and physical VRAM remain outside these logical counters.

Focused numerical/lifecycle verification passes **364 cases, zero failed/skipped,
105.60 s**, selecting `merge-cpu-kernels`, `merge-io`, `merge-engine`, `merge-library`,
`merge-gpu`, `brk-merge`, both real RAW import paths and `research-merge-gpu`.
Publication attribution replay passes 319 cases in 20.95 s; the final legacy-key
engine replay passes 317 in 30.46 s. These selections overlap and are not additive.
Type checking, lint, formatting and builds pass. The duration warning is retained.
Evidence: [focused checks](../artifacts/verification/2026-10-17T11-25-04.055Z-benchmark-XRHBJN/summary.md),
[publication replay](../artifacts/verification/2026-10-17T11-27-20.818Z-check-GxG53V/summary.md),
[final engine replay](../artifacts/verification/2026-10-17T11-38-13.594Z-check-Rkbchl/summary.md).

October 18 foreground merge interference retains three matched idle/editing trials
at 60 Hz, 1100 × 700 with Console. Both invocations fail only twelve unchanged
33 ms frame/histogram assertions: frame p95 42.0–42.7 ms, histogram 49.6–51.2 ms.
Sharpness, progress, cadence, final image/histogram, history, source reuse and cleanup
assertions pass. The first invocation retains a 22.916 s idle first task, then
14.344/14.666 s idle and 17.949–18.458 s editing tasks. Its exact replay records
14.189/14.390/14.245 s idle and 18.473/18.269/18.366 s editing tasks. The slower
first task is not discarded or attributed to a code cause. These do not establish
an overall latency or cold-tail acceptance pass. Durations are 136.57/128.11 s.
[First interference result](../artifacts/verification/playwright-1792332578741-7268a5a3-dfbe-4a31-8310-f68342ab4be7/playwright/summary.json),
[exact replay](../artifacts/verification/playwright-1792332737874-4bbcf793-ee14-4113-a02e-b48bea64fd8e/playwright/summary.json).

### Rejected GPU integration and Bazzite freeze

The isolated study passes sixteen synthetic probes, both native Sony cases and
six complete scalar camera-evidence recoveries after cancellation/device loss.
Its fresh native preparation-through-proof clocks are 4.790/4.289 s, including
canonical CPU oracle/mask work and full readback/verification; warmed resident
GPU medians are only 5.98/6.08 ms. The fresh clocks explicitly include duplicate
CPU evidence work. Registration decisions, fusion/motion masks, crop, complete
Float32 master, publication and full-merge CPU recovery remain unvalidated.
`productionSpeedEvidence` remains false. These resident timings do not justify
production enabling or promise a complete-operation saving.

The Mac pass stops at the measured remaining preparation/output/admission costs
and the retained latency/cold-tail misses. AC power and a full battery were verified
on both days; low-power mode was off for the October 17 performance series.
All fifteen originals retain their committed hashes. All sixteen recorded Electron
launches exited, twelve isolated profiles were removed, window-policy violations
are zero, no owned processing workers remain and invocation locks are released.
[Integrity](../artifacts/fixture-integrity/2026-10-18T14-15-10.177Z-68061.json) and
[cleanup audit](../artifacts/merge-lightroom-2026-10-17/cleanup.json) remain outside Git,
with all generated measurements. No comprehensive checkpoint was repeated.

Continue the existing [Bazzite checklist](#bazzite-continuation) from the frozen
`a739a0c` implementation (documentation-only descendants allowed). Add
`npm run verify -- --foreground --target merge-workflow-benchmark` to that local
acceptance sequence, retaining five ordinary operations and a separate restart
control. Obtain a same-configuration Linux scalar/pre-change control before
adopting acceleration there. Mac measurements establish no Linux performance,
window/display, package or hardware result; Bazzite remains pending.

## October 17 merge acceleration

The internet-research follow-up starts from `a06e74c`. The user authorized three
parallel experiments: exact compiled preparation, bounded GPU/output overlap, and
an isolated GPU preparation study. The strict complete-operation target remains
less than 5000 ms for each of three fresh-worker runs in both HDR and noise modes.
Native detail, source integrity, independent registration, clipping, deghosting,
numerical bounds, durable publication and cancellation retain their current gates.

Production acceleration is committed as `64065da`; isolated research and its
registration are committed as `76d1408`. The code/verification handoff is
`76d1408bd76e7a412c69eec2d23f4ab2410aba90`; documentation-only descendants are
allowed. The pinned 4113-byte ABI 2 binary rebuilt identically with SHA-256
`4c3f88ba5fb75ff52c8a80ad9981e3591a8db7a09b43ae5f76ec381b11591f2c`.
An independent read-only review found no production blockers in arithmetic,
borrowed views, scalar recovery, GPU draining or packaged-asset resolution.

| Task                            | Owner                      | Dependencies                        | Status                                   | Evidence / next step                                                                                                             |
| ------------------------------- | -------------------------- | ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A0 — Matching baseline          | Coordinator                | `a06e74c`, committed Sony originals | Complete; five-second gates fail         | Noise 8.597/8.230/8.136 s; HDR 23.603/23.647/23.830 s. All integrity/publication checks passed.                                  |
| A1 — Exact preparation          | Merge agent                | A0, reproducible SIMD build         | Implemented; exact checks passed         | Float64 SIMD and bounded arenas; native preparation, masks, planes, registration and published master match the frozen baseline. |
| A2 — GPU/output overlap         | Export agent + coordinator | A0, bounded slot ownership          | Implemented; functional checks passed    | One/two-slot output equality and in-flight fallback pass; device timestamps remain separate from map wait.                       |
| A3 — GPU preparation study      | Rendering agent            | Existing CPU camera evidence oracle | Complete, research only                  | Synthetic and both native Sony cases pass pixel/mask bounds; production byte identity and end-to-end integration are unproven.   |
| A4 — Integration and acceptance | Coordinator                | A1–A3                               | Complete; acceptance failed / incomplete | 328 focused passes; 12 benchmark passes and two five-second misses; foreground latency failure replayed; Bazzite pending.        |

Matching baseline: 283 passed, two unchanged five-second failures, zero skipped,
115.26 s. Evidence:
`artifacts/merge-acceleration-2026-10-17/baseline/artifacts/verification/2026-10-17T09-43-09.978Z-benchmark-NAbCez/summary.md`.
The detached worktree is source-identical to `a06e74c`; its only untracked entry is
the shared `node_modules` symlink. The initial sandbox-blocked localhost test and
passing exact replay remain retained separately. Compiler downloads and all
generated measurements stay under ignored artifacts.

Focused checks: `merge-cpu-kernels` and `merge-gpu-output` pass 296 cases in
14.27 s. The affected `brk-merge`, `merge-engine`, `merge-gpu` and `merge-library`
selection passes 348 cases in 64.31 s with zero skips. It retains scalar/GPU
agreement, full output/master identity across one/two slots, partial strips,
device-failure fallback, native validation and managed publication/recovery.
Evidence: `artifacts/verification/2026-10-17T09-57-52.973Z-check-UAxR96/summary.md`
and `artifacts/verification/2026-10-17T09-58-19.465Z-check-n6XQ9l/summary.md`.

The first GPU study passes its 16 synthetic orientation/lens/clipping probes.
Both native cases then fail because Dawn's internal texture-initialization staging
exceeds the study device's buffer limit. Those results and invalid timings remain
under `artifacts/verification/playwright-1792231016939-3c0fee04-09db-449c-8ce2-5498e5fe5d14/`.
The repaired study uses bounded 64-row texture layers and passes all three cases,
including every native sample and exact clipping masks. Combined CPU/GPU/research
verification passes 304 cases with zero skips in 68.25 s:
`artifacts/verification/2026-10-17T10-05-37.724Z-benchmark-b1WduT/summary.md`.
The resident numerical stage takes roughly 6 ms on M4 Pro. RAW decode, canonical
CPU clipping geometry, upload, full proof readback, validation and publication are
outside that clock. Many Float32 words differ within the unchanged pixel tolerance;
this does not establish identical alignment decisions or master bytes. Nothing
from the research prototype is enabled in production.

The first complete SIMD attempt detects scalar fallback at the camera handoff:
production emits 256-row chunks while the optional kernel accepts 64. Evidence:
`artifacts/verification/2026-10-17T10-00-32.493Z-benchmark-6UX2lO/summary.md`.
The repaired writer subdivides borrowed chunks, preserves ordered area sums and
awaits each native write before buffer reuse. Exact 64/128/256-row integration
coverage now proves actual SIMD execution. The HDR-only replay records
20.941/20.772/20.604 s with every prepared/source/master identity matching the
baseline, before failing only the unchanged five-second gate. Evidence:
`artifacts/verification/playwright-1792231667929-33721087-eda3-4afe-aa7f-02856e8aaff4/`.

Two-slot diagnostic runs retain all identities and reduce complete maxima to
7.628 s for noise and 19.232 s for HDR. Output device time is about 1.72/1.76 s;
summed map waits overlap and cannot be added to stage wall time. Evidence:
`artifacts/verification/2026-10-17T10-09-12.074Z-benchmark-fxaQlk/summary.md`.
Final adoption measurements disable optional timestamp queries. The 32,768-entry
tagged gain-cache and 64-thread output experiments first passed their arithmetic,
resource and exact-output checks: 304 cases in 52.70 s:
`artifacts/verification/2026-10-17T10-14-50.186Z-check-ludIgO/summary.md`.

The 64-thread workgroup produced less than a one-percent device-time difference
and no application gain. Its option and test scaffolding were removed; production
retains 256 threads. The rejected patch and measurements remain under ignored
artifacts, including
`artifacts/verification/2026-10-17T10-16-01.269Z-benchmark-WeBGmm/summary.md`.

The fixed-256, two-slot, timestamp-disabled 2048-entry control retained all frozen
identities: noise 8.682/8.404/8.618 s and HDR 21.128/19.884/20.124 s. Evidence:
`artifacts/verification/2026-10-17T10-19-59.285Z-benchmark-qRAZnb/summary.md`
(298 passed, two five-second failures, zero skipped, 108.00 s).
Matched HDR-only 32768-entry runs take 19.358/19.360/19.650 s; the following
2048-entry replay takes 19.433/19.752/19.716 s. Both retain all prepared/master,
registration and mask identities. Evidence:
`artifacts/verification/playwright-1792232556021-d74deb8b-38a4-4a53-9f68-d14409b74beb/`
and
`artifacts/verification/playwright-1792232657640-17ee7f4b-9dce-4814-834f-1b1485c2d3b7/`.
Direct Playwright replays retain JSON/reporter evidence rather than a runner summary.
The compiled fallback loop consistently saves about 0.4 s; complete-operation
gains are smaller and vary with other stages. Production adopts 32768 tagged
entries (384 KiB, 360 KiB above the control) and two bounded output slots for
native comparisons. The 128 MiB kernel arena cap, GPU bounds, algorithms and
exact arithmetic remain unchanged. Non-comparison output retains one slot.
`LUMA_MERGE_GAIN_CACHE_ENTRIES=2048` and `LUMA_MERGE_OUTPUT_SLOTS=1` select controls.
AC power and a full battery were confirmed; macOS thermal telemetry was unavailable.

Final default correctness/lifecycle verification selects `merge-cpu-kernels`,
`merge-gpu-output`, `merge-engine`, `merge-gpu` and `merge-library`: **328 passed,
zero failed/skipped in 63.87 s**, including typecheck, lint, formatting and build.
Evidence: `artifacts/verification/2026-10-17T10-26-14.358Z-check-RQ3Wn8/summary.md`.
This run verifies the adopted 32768-entry default and fixed 256-thread shader.
The duration warning is retained; no assertions were removed or cut short.

Final foreground `benchmark:merge` selects `merge-benchmark`,
`merge-preview-benchmark` and `merge-three-raw-benchmark`: **12 passed, two failed,
zero skipped in 378.48 s**. Only the unchanged five-second cases fail. Evidence:
`artifacts/verification/2026-10-17T10-27-58.766Z-benchmark-KJ6213/summary.md`.
The actual default-path HDR samples all execute SIMD; fallback selects 32768
entries, output owns two slots and diagnostic timestamps remain disabled.

| Complete three-RAW operation | Baseline runs (s)        | Final runs (s)           | Maximum reduction | Five-second gate |
| ---------------------------- | ------------------------ | ------------------------ | ----------------- | ---------------- |
| Noise                        | 8.597 / 8.230 / 8.136    | 7.624 / 7.646 / 7.594    | 11.1%             | Failed           |
| HDR                          | 23.603 / 23.647 / 23.830 | 18.801 / 19.205 / 19.007 | 19.4%             | Failed           |

All native preparation, registration, motion-mask and published master identities
match the frozen baseline. Earlier controls show full-operation variance, retained
above; the table reports every final sample rather than selecting the fastest run.
Distinct 2/3/5/9-source noise maxima are 7.073/7.662/9.721/12.925 s, all below
15 s with three cold runs per count. Prepared synthetic 2/9/32-source and repeated-
fixture calibrations remain separate passing results. All sixteen native merge
view gestures pass, with maximum p95 11.4 ms against 33 ms. This is merge-view
presentation, separate from editor sliders and physical scanout.

Final strict-series logical peaks are 932,630,072 GPU bytes and 101,777,408 WASM
bytes; maximum worker RSS is 2,492,301,312 bytes. These retain their limits and do
not measure driver-internal GPU allocations. All fifteen committed originals match
before and after the family:
`artifacts/fixture-integrity/2026-10-17T10-27-58.469Z-30519.json`.
Consolidated experiment measurements remain out of Git:
`artifacts/merge-acceleration-2026-10-17/outcomes.json`.

The focused foreground merge-interference case retains three matched 240-input
trials at 60 Hz, 1100 × 700 with Console. Its first run fails only twelve unchanged
33 ms latency/histogram assertions: frame p95 42.0–42.6 ms, histogram p95
49.8–50.7 ms, refinement 32.5–41.2 ms. All six idle/editing trials meet cadence,
sharpness, progress, final image/histogram, history and source-reuse assertions;
there are no drafts, loaders, hidden/regressed frames or cleanup errors. Every
idle/editing nine-source task completes. Idle tasks take 13.13–13.39 s, editing
tasks 17.10–17.23 s: foreground work retains priority. The dispatched operation
interval overlaps 238–239 of 240 inputs. This includes scheduler waits and does
not establish simultaneous GPU computation or output-stage overlap.
Evidence: `artifacts/verification/playwright-1792233422867-bc1dcdd9-b4de-4227-9784-cfeaca6a9e0c/playwright/summary.json`
(zero passed, one failed, zero skipped, 119.24 s).

The exact replay again fails only the twelve 33 ms assertions: frame p95
41.9–42.5 ms, histogram 49.8–51.1 ms, refinement 32.6–41.1 ms. All other
assertions pass, with actual cadence 60.00–60.13 Hz. Evidence:
`artifacts/verification/playwright-1792233572775-e51c4348-32f9-444e-8109-a9b73ee4f7b6/playwright/summary.json`
(zero passed, one failed, zero skipped, 119.86 s). No latency target was relaxed.

Final integrity check:
`artifacts/fixture-integrity/2026-10-17T10-42-02.315Z-32147.json`.
All three recorded Electron launches have closed processes, removed isolated
profiles and zero window-policy violations; the invocation lock is released.
The read-only process audit found no processing workers or test profiles running.
Evidence: `artifacts/merge-acceleration-2026-10-17/cleanup.json`.
The detached source baseline and pinned compiler remain under ignored artifacts
for reproduction. Generated measurements stay out of Git. The earlier agreed
full checkpoint was not repeated; no `check:all` was run. Linux and physical HDR
results remain pending.

The remaining HDR serial costs in the 2048-entry control are approximately
11.47–12.35 s decoding/preparation, 2.05–2.08 s remaining alignment/coverage work,
1.31–1.56 s accumulation, 3.36–3.54 s output and 1.21–1.25 s publication/cleanup.
The remaining-work bucket is derived wall time, not a new alignment measurement.
Parallel alignment sums and overlapping map waits must not be added as serial
costs. No multi-second copying or cleanup bottleneck was found. Exact ordered
area accumulation and attributed durable publication are focused future studies;
the new GPU numerical prototype needs full registration/master validation before
production integration. Five seconds requires gains across several stages.

## Task register

| Task                   | Owner                              | Dependencies       | Status                                                        | Evidence / remaining work                                                                                                                                                                         |
| ---------------------- | ---------------------------------- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Baseline          | Coordinator                        | Upstream research  | Complete                                                      | Upstream integrated; all 15 committed Sony original hashes verified. Unchanged baseline runs in a detached, isolated checkout.                                                                    |
| M1 — Exact rendering   | Rendering agent                    | M0                 | Focused checks passed                                         | CPU/GPU/pinned Float64 CTL agree on Mac; maintained compensated range-reduced math shared across production shaders. Bazzite remains pending.                                                     |
| M2 — Sharp interaction | Rendering agent                    | M1                 | Implemented; performance gates fail                           | Immutable active/latest pending intent, normal-detail interaction and independent bounded histogram work. Measured 32-tile batches retained; sharpness passes, latency/progress miss their gates. |
| M3 — Export            | Export agent                       | M0, shared M1 math | Functional and warm gates passed; cold variance               | Internal validated working-asset leases, frozen preparation reuse across retries; initial cold miss retained alongside passing exact replay.                                                      |
| M4 — Merge             | Merge agent                        | M0                 | Functional and 15-second gates pass; five-second target fails | Exact SIMD/cache/capture and bounded output; October 17 family: 12 passed, two three-RAW five-second failures.                                                                                    |
| M5 — Enabled workflows | Coordinator, then subsystem agents | M1–M4              | Mac software repairs verified; hardware gaps deferred         | Import/device adapters, library/selection/groups/Trash/recovery, adjustments/history/MCP, export and merge; physical/private-fixture gaps remain explicit.                                        |
| M6 — Integration       | Coordinator                        | M1–M5              | Execution complete; acceptance failed / incomplete            | One agreed full checkpoint completed; exact failures replayed, focused repairs verified and final Bazzite handoff recorded below.                                                                 |

## Machine and baseline

### Follow-up: slider latency and three-RAW processing

The October 16 follow-up starts from `5df6ae8` on the existing implementation
branch. Sharp interactive frames retain the 33 ms frame/histogram p95, sustained
progress and 500 ms release-refinement gates. The new three-source target applies
separately to HDR and noise: every one of three fresh-worker, empty-preparation-
cache operations must finish in less than 5000 ms. The clock includes review
creation, RAW preparation, Auto Align, native review output, durable publication
of that same frozen revision and cleanup. Import and human review time are outside
the clock. Filesystem and driver caches are uncontrolled; idle AC-powered acceptance
and background interference are reported separately.

| Task                               | Owner                      | Dependencies                   | Status                                             | Verification / remaining work                                                                                                       |
| ---------------------------------- | -------------------------- | ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P0 — Matching baseline             | Coordinator                | `5df6ae8`, committed originals | Complete                                           | Fresh editor and both complete-operation series archived; all quality and source-integrity assertions pass, performance gates fail. |
| P1 — Exact tile processing         | Rendering agent            | P0                             | Complete; performance fails                        | Linear workgroups verified through all 192 trials and lifecycle checks. Uniform tables and alternate rounding rejected.             |
| P2 — RAW preparation and merge     | Merge agent                | P0                             | Complete; five-second target fails                 | Exact CPU/cache/capture and mixed-PNG changes verified; existing 15-second family passes.                                           |
| P3 — Complete-operation acceptance | Export agent / coordinator | P0, P1, P2                     | Complete; five-second gates fail                   | Independent three-source HDR/noise series retains all three runs, exact identities and failures.                                    |
| P4 — Integration                   | Coordinator                | P1–P3                          | Execution complete; acceptance failed / incomplete | Focused checks, sequential performance families, reviewable commits, cleanup and final Bazzite handoff recorded.                    |

The five-second target remains unmet. Fresh complete-operation baseline maxima are
9698.36 ms for noise and 33481.21 ms for HDR (all three operations per mode retained).
The new clock publishes the same reviewed revision and includes awaited cleanup;
prior calibration is not a substitute for this measurement.
No approximation, reduced native output, skipped validation, increased worker
count or processing-graph/native-decoder rewrite is part of this follow-up.
Public application/MCP operations and numeric edit history retain their contracts.

Follow-up evidence (original milestone evidence below remains unchanged):

- Baseline `mac-workability-batching`: 280 passed, two existing performance failures,
  zero skipped, 79.97 s. Minimum Fit frame p95 42.2–42.3 ms; large Fit 101.2–109.1 ms,
  with zero draft frames. History/source retention and invalidation pass. Evidence:
  `artifacts/verification/2026-10-16T21-16-43.068Z-benchmark-fhTxv8/summary.md`.
- Baseline `merge-three-raw-benchmark`: 279 passed, two new five-second gate failures,
  zero skipped, 147.50 s. Noise 9696.16/9698.36/9560.04 ms; HDR
  32398.01/33481.21/32161.27 ms. Every native/master/revision/hash/cleanup assertion
  passed. HDR fallback conversion costs 9923.93–10066.01 ms; three dimension probes
  total only 29.68–32.04 ms. Evidence:
  `artifacts/verification/2026-10-16T21-18-47.165Z-benchmark-jKGV8j/summary.md`.
- Exact kernel targets `display-rendering-reference`, `hdr-render-cache-gpu` and
  `hdr-math-gpu`: 286 passed, zero failed/skipped, 52.08 s. Both grid8 and linear64
  pass the same independent CTL, alpha and sampling checks at 64/256-pixel tiles.
  Evidence: `artifacts/verification/2026-10-16T21-22-16.809Z-check-1TnVVK/summary.md`.
- A diagnostic application attempt was blocked by a CPU-loop local-variable naming
  collision, without running tests. It was fixed; exact typecheck replay passed.
  Evidence: `artifacts/verification/2026-10-16T21-25-32.868Z-benchmark-tYXFry/summary.md`.

Baseline source hashes, diagnostic-only patch, original master checksums and compact
timings are archived under `artifacts/mac-latency-followup-2026-10-16/`.

The retained preparation changes preserve scalar evaluation and accumulation order:
reused RGB/strip storage, hoisted white-balance extrema, indexed camera reduction
and a preparation-local 24 KiB Float64 gain cache. Cache collisions recompute the
original expression. Independent uncached tests cover nonidentity lens corrections,
portrait orientation, clipping, partial strips and cache collisions. Fresh capture
inspection uses one owned worker/ExifTool session, retaining admission, scheduler
checkpoints, current source checks and awaited cleanup. Decoder dimension probes
cost only about 30 ms across the HDR triad; decoder-session restructuring was
deferred because it does not address the measured critical path.

| Follow-up selection / experiment                                       | Result                                                                         | Duration | Evidence under `artifacts/verification/`               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------: | ------------------------------------------------------ |
| `brk-merge`, `capture-metadata`, `merge-engine`, `merge-io`, cache GPU | 328 passed, zero failed, one unavailable private capture fixture               |  76.27 s | `2026-10-17T08-16-27.035Z-check-sGgG1E/summary.md`     |
| CPU/capture complete-operation candidate                               | 280 passed, two five-second failures; noise max 9.298 s, HDR max 27.635 s      | 129.48 s | `2026-10-17T08-19-14.600Z-benchmark-NMwby8/summary.md` |
| Bounded gain cache/indexed reductions + exact CPU oracle               | 302 passed, two five-second failures; noise max 9.443 s, HDR max 25.124 s      | 132.06 s | `2026-10-17T08-26-45.830Z-benchmark-txvpOx/summary.md` |
| Lossless PNG level 0 trial                                             | 280 passed, two five-second failures; noise 8.448–8.645 s, HDR 23.858–24.003 s | 117.50 s | `2026-10-17T08-33-33.571Z-benchmark-6EjYMb/summary.md` |

All six native masters, geometry, crops, motion masks and normalized registration
records match the original complete-operation baseline in each candidate series.
Original fixture hashes and durable publication/cleanup checks pass. GPU/WASM
bounds and worker counts are unchanged. HDR worker RSS already exceeds 2 GiB in
the baseline and candidates; the 1 GiB GPU bound is separate from process RSS.
The final review PNG policy uses level 0 for color result/reference and level 1
for the sparse overlay. The overlay retains compression because level 0 added
73–77 MB per operation without a useful timing benefit. Decoded RGBA, alpha and
native dimensions agree exactly across levels 0/1/6; this is a temporary review
encoding change, without a rendering-version or master policy change.

Four matched 1440 × 900 application trials compare grid8/linear64 workgroups and
storage/uniform tables, three 240-input repetitions at Fit and 100%. Linear64 with
storage increases sharp progress from 46–49 to 55 frames at Fit and 87 to 97 at
100%; matched tile GPU time falls from 72.5–73.4 to 64.8–65.0 ms and about 39–40 to
35 ms respectively. Frame p95 remains 92–100 ms at Fit and about 59 ms at 100%,
above the unchanged 33 ms gate. Diagnostic input-to-request p95 is at most 0.8 ms;
tile evaluation dominates the delay. Uniform tables provide no repeatable application benefit and
were removed. Evidence: `2026-10-17T08-23-17.041Z-benchmark-I0BgPx`,
`08-23-48.858Z-benchmark-4dEScv`, `08-24-20.506Z-benchmark-65gecW` and
`08-24-51.626Z-benchmark-VtGTca`; full paths and compact comparisons are archived
in `artifacts/mac-latency-followup-2026-10-16/slider-four-candidate-comparison.json`.

An integer rounding-barrier experiment passed compensated scalar bounds but
failed independent CTL pixel accuracy at a 256-pixel tile (error/tolerance ratio
1.07128). It was rejected and removed; the existing frexp/ldexp implementation and
`2e-6 + 2e-5 * abs(reference)` pixel bound remain unchanged. No performance claim
uses that candidate. Exact failure evidence:
`artifacts/verification/playwright-1792226421927-be27779f-394b-4e4a-b796-3c625cdb9160/`.
Earlier diagnostic harness mistakes and their exact replays remain archived;
they do not represent production failures or passed acceptance.

The final production-default eight-slider matrix records **192/192 trials**:
eight sliders × Fit/100% × three repetitions × two layouts × two input rates.
All configurations meet Retina and actual cadence requirements. There are zero
drafts, regressed frames, attribution errors, loaders, hidden frames or history/
source/analysis failures. Final refinement is at most 99.5 ms. All four test cases
still fail their unchanged performance gates: **zero passed, four failed, zero
skipped, 637.90 s**. Evidence:
`artifacts/verification/2026-10-17T08-51-47.652Z-benchmark-8Mfwgr/summary.md`.

| Layout / input              | Zoom |     Frame p95 |  Histogram p95 | Presentations during 240 inputs |
| --------------------------- | ---- | ------------: | -------------: | ------------------------------: |
| 1100 × 700, Console, 60 Hz  | Fit  |  41.7–42.5 ms |   42.0–50.8 ms |                         192–200 |
| 1100 × 700, Console, 60 Hz  | 100% |  25.5–34.3 ms |   33.4–41.9 ms |                         236–238 |
| 1100 × 700, Console, 120 Hz | Fit  |  34.0–34.7 ms |   35.1–42.8 ms |                          96–100 |
| 1100 × 700, Console, 120 Hz | 100% |  26.0–26.4 ms |   33.6–34.5 ms |                         102–119 |
| 1440 × 900, 60 Hz           | Fit  | 92.2–101.2 ms | 100.9–109.3 ms |                           54–55 |
| 1440 × 900, 60 Hz           | 100% |  58.8–67.5 ms |   66.8–75.0 ms |                           95–98 |
| 1440 × 900, 120 Hz          | Fit  |  84.5–93.5 ms |  92.7–101.1 ms |                           25–27 |
| 1440 × 900, 120 Hz          | 100% |  51.0–52.0 ms |   58.6–59.7 ms |                           47–48 |

The matched large-workspace Exposure-only comparison to the fresh follow-up
baseline reduces the mean of trial frame p95 values by 8.69% at Fit and 8.47% at
100%. This does not imply a 33 ms pass or a percentage gain for every adjustment.
Full missing-presentation, stale-frame, histogram and per-trial measurements are
retained in `artifacts/mac-latency-followup-2026-10-16/final-editor-matrix-analysis.json`.

The matched 1100 × 700 Console-open Exposure trials also show no greater-than-5%
regression in any repetition. Fit frame p95 changes from 42.2–42.3 to 41.9–42.1 ms,
with 196–198 presentations versus 178–179. At 100%, p95 changes from 34.1 to
26.0–33.2 ms, with 238 presentations versus 233–237. Across the entire matrix,
151/192 trials miss frame latency, 192/192 miss histogram latency, and 144/192
miss each sustained-progress gate. Every trial meets the 500 ms refinement gate.

Final focused functional selection: **375 passed, zero failed, one unavailable
private capture fixture, 168.85 s**, including type/lint/format/build, optional
diagnostic cleanup/ownership, CPU preparation oracles, frozen export contexts,
managed merge publication/recovery and actual RAW editor/device/fallback paths.
The signed regression triplet passes independent CTL with the retained math.
All fifteen committed originals match before and after. Evidence:
`artifacts/verification/2026-10-17T09-04-32.201Z-check-o5bm5L/summary.md`.
The earlier attempt stopped before tests on a benchmark cleanup-handler lint error;
the exact lint replay passed after moving the throw outside `finally`.
Evidence: `2026-10-17T09-02-59.482Z-check-yDIPwI/summary.md`.

The final merge family completes **11 passed, two five-second performance failures,
zero skipped, 405.57 s**. Existing 2/3/5/9-source clocks pass all three repetitions;
the new strict clocks remain separate:

| Mode / clock                                     | Source count | Three measured operations  | Maximum / gate         |
| ------------------------------------------------ | -----------: | -------------------------- | ---------------------- |
| Repeated-original calibration                    |            9 | 13.329 / 13.669 / 12.723 s | 13.669 s / ≤15 s: pass |
| Distinct Sony noise, existing clock              |            9 | 13.997 / 13.870 / 13.826 s | 13.997 s / ≤15 s: pass |
| Distinct Sony noise, strict complete clock       |            3 | 8.684 / 8.546 / 8.473 s    | 8.684 s / <5 s: fail   |
| Complete Sony HDR bracket, strict complete clock |            3 | 24.538 / 24.304 / 24.550 s | 24.550 s / <5 s: fail  |

Against the matching complete-operation baseline, maximum noise time falls
10.46% and HDR 26.68%. Every frozen master/strip, crop, motion mask and normalized
registration identity matches in all six strict operations. Every attempt retains
source identities, timings and any errors before assertions can throw; all six
finish successfully before their performance assertions fail. Actual PNG policy
is 0/0/1 in every operation. GPU allocations remain 901,807,848 bytes for noise and
932,630,072 bytes for HDR. Final strict peak worker RSS is about 1.64/2.06 GB;
earlier higher peaks remain recorded and no process-RSS limit is inferred.
All fifteen original hashes match before/after. Evidence:
`artifacts/verification/2026-10-17T09-07-59.182Z-benchmark-YngRxK/summary.md` and
`artifacts/mac-latency-followup-2026-10-16/final-merge-family.json`.

Final foreground interference retains **12/12 matched pairs**, three for each
workload, at 1100 × 700 with Console open and actual 60 Hz cadence. The invocation
reports **283 passed, four latency failures, zero skipped, 486.26 s**. All tasks,
cleanup, source retention, expected history, final image/analysis identity,
sharpness and progress checks pass. There are no draft frames or source changes;
refinement is at most 41.4 ms. Frame/histogram p95 still misses 33 ms in every
idle and editing trial.

| Operation               |     Idle task |  With editing | Editing frame p95 | Editing histogram p95 | Sharp progress / 240 |
| ----------------------- | ------------: | ------------: | ----------------: | --------------------: | -------------------: |
| Import nine originals   |   3.03–3.05 s |   7.00–7.12 s |      42.0–42.5 ms |          50.6–50.8 ms |                  196 |
| Individual export       |   3.99–4.90 s |   8.17–8.32 s |      42.0–42.1 ms |          50.8–51.0 ms |              193–196 |
| Nine-photo batch export | 33.20–36.00 s | 37.26–37.99 s |      42.1–42.3 ms |          50.8–51.0 ms |              190–193 |
| Nine-source merge       | 13.88–14.19 s | 17.82–18.07 s |      42.4–42.6 ms |          50.1–50.9 ms |              193–195 |

These task clocks include preparation, publication and scheduling waits. They
are separate from the isolated export and strict three-RAW gates. Operation/input
overlap remains partial and recorded; no simultaneous-computation or historical
percentage claim is inferred. Export checks retain frozen settings and actual
published-byte/hash evidence. Evidence:
`artifacts/verification/2026-10-17T09-16-30.085Z-benchmark-gtYutc/summary.md` and
`artifacts/mac-latency-followup-2026-10-16/final-interference-analysis.json`.

Final cleanup finds **22 recorded launches, all 21 temporary profiles removed,
no remaining profile processes or project workers, and no window-policy
violations**. All fifteen Sony originals match after the final invocation, and
the common Sony fixture retains SHA-256
`14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2`.
Evidence: `artifacts/mac-latency-followup-2026-10-16/final-cleanup.json` and
`artifacts/fixture-integrity/2026-10-17T09-16-29.784Z-96981.json`.
Generated evidence stays outside Git. The original agreed full checkpoint is
retained; this follow-up does not run another full checkpoint or `check:all`.

### Original milestone configuration

October 16, 2026: MacBook Pro Mac16,8, Apple M4 Pro (12 CPU cores: 8 performance,
4 efficiency; 16 GPU cores), 24 GiB unified memory, macOS 26.7 (25G229), Darwin
25.6.0, arm64. The project shell uses Node 24.8.0; npm and processing use pinned Node 24.20.0. The detached checkout's direct baseline preview driver used Node 26.4.0; its processing workers still used Node 24.20.0;
Electron 44.3.0 and Playwright 1.63.0. Actual display, refresh, adapter, DPR and
canvas configuration are recorded by foreground acceptance measurements. AC power was connected, battery fully charged, and low-power mode was off. The internal P3 display reports 1800 × 1169 logical bounds, DPR 2, and
120.0006 Hz in the acceptance harness. Physical scanout and luminance are not measured.

Fixture manifest SHA-256:
`4e3e6a07767ede1df7f23b2b646146ea355af3b00a975575b32cbdff0769677f`.
The committed Sony originals retain their existing attribution and repository
testing authorization. Checks run before and after merge measurements.

Baseline checkout: `/private/tmp/luma-mac-baseline-3c5fcb1`, with an isolated build
and test profiles and the same installed dependencies. Its evidence is archived under
`artifacts/verification/mac-workability-baseline/`, including fixture-integrity
checks and copied regression tests. Filesystem/driver caches are uncontrolled. No candidate result
is used as its own preview-regression baseline. The temporary checkout was removed
after confirming the archive and byte-identical copied regression tests.

Existing Linux failures and prior Mac failures remain recorded in
[the research report](performance-research.md). Numerical tolerance remains
`2e-6 + 2e-5 * abs(reference)`. Export retains the fresh-worker four-second gate;
real 2/3/5/9-source merging retains three repetitions and a 15-second maximum.
Missing measurements remain incomplete.

## Delivered changes

- Maintained generators now share export's compensated, range-reduced ACES math
  with every preview shader. Pinned Float64 CTL coverage includes the Bazzite
  failing sample within a 125-triplet Float32 neighborhood. Changed display pixels use
  rendering version `aces2-069b0bc3-v2`; originals, linear preparation and numeric
  history remain intact. Shared lookup storage adds 3072 bytes per consuming buffer.
- The editor separates request intent from quality, retaining one immutable active
  request and one replaceable pending request. Valid sharp interactive frames
  advance monotonically. Histogram readback has its own bounded active/latest
  coordinator and revision; its pending status keeps panel geometry stable.
  Measurements support 32-tile batches with unchanged allocations and cancellation.
- Main-process-only working-asset leases validate frozen preparation identity,
  file geometry and hashes, pin cache entries until worker exit, and fall back to
  original decoding on misses. Completed preparation survives disposable export
  output retries. Decoder and encoder WASM heaps remain separate; terminal paths
  release leases and temporary work. Import now remains available during export.
- Merge diagnostics attribute preparation, alignment lanes, verified reads,
  conversion and output. Bounded strip reuse and paired readbacks reduce allocation
  and mapping without changing image work or worker limits. Temporary review PNGs
  use compression level 0 for color result/reference and level 1 for the overlay,
  validated byte-exact after decoding against prior PNGs and raw pixels; durable
  masters and checksums retain their existing policy.
- Registered Mac targets measure real editor inputs, tile batches and matched
  foreground interference. They retain all existing progress, latency, memory,
  cancellation and numerical limits and preserve failed evidence.
- Edit publication checks the persisted revision inside its SQLite transaction,
  preventing concurrent updates or Undo/Redo from losing history. Legacy merge
  recovery uses current runtime metadata without rewriting frozen provenance or
  inspecting a nonexistent original container.
- Changing presentation primaries resets the canvas drawing buffer before its
  completed frame is blitted. This clears a reproduced Chromium color-space
  retention bug while retaining source textures, cached tiles and numeric edits.

## Verification evidence

Results record selected targets, passed/failed/deferred counts, duration,
artifact path and limits here. Builds, GPU/Electron tests and benchmarks ran
sequentially. Tests use isolated libraries/profiles and shared launch/cleanup.
The agreed full checkpoint was `npm run check:full -- --foreground`; `check:all`
is outside this checkpoint.

The following detailed sections retain the original October 16 checkpoint and
its failures. The October 17 follow-up results above supersede its current
performance status without removing the historical evidence.

### Unchanged baseline findings

These runs use upstream production code. The numerical regression tests and
picker reproduction were copied into the detached checkout without applying
implementation changes. Counts below include each invocation's cheap checks;
repeated cases are not distinct coverage.

| Selection                                           | Result                                                                 |    Duration | Evidence (baseline archive)                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------- | ----------: | ---------------------------------------------------------------- |
| Original numerical targets + preview benchmark      | 278 passed, 1 failed; later families blocked after the preview failure |    428.10 s | `2026-10-16T13-14-36.835Z-benchmark-zfmZ6F/summary.md`           |
| Exact preview rerun                                 | 1 failed again                                                         | about 395 s | `playwright-1792156958967-69981c3d-648e-4c0a-9c70-606ef902d813/` |
| New Bazzite/neighbor CPU/GPU/CTL reference coverage | 276 passed, no failures/skips                                          |     28.91 s | `2026-10-16T13-29-43.545Z-check-GFxqeX/summary.md`               |
| Existing eight-slider and navigation benchmarks     | 278 passed, no failures/skips                                          |     64.54 s | `2026-10-16T13-32-20.199Z-benchmark-GSkcXC/summary.md`           |
| New import-during-export reproduction               | 1 failed: picker rejects an active export                              |      32.8 s | `playwright-1792157462434-be3ee07e-363c-4243-a8f2-a515de67dbd2/` |
| Cold edited quality-100 export                      | 1 failed: fresh-worker p95 4083.99 ms; subsequent p95 3672.39 ms       |     77.41 s | `2026-10-16T13-34-06.951Z-benchmark-gzih8P/summary.md`           |

Preview median generation + actual Electron presentation was **3226.18 ms GPU**,
**44440.16 ms CPU**, and **2411.89 ms legacy PNG**. The exact rerun again failed:
3279.36 ms GPU versus 2362.23 ms legacy. Cached GPU presentation was 17.0 / 17.15 ms.
The first pre-change result is saved as
`artifacts/mac-workability/preview-baseline-3c5fcb1.json` for the candidate's separate
15% uncorrected regression gate. The existing GPU-versus-legacy failure remains.

The expanded direct numerical baseline's maximum GPU error/tolerance ratio is
**0.90592**; CPU versus pinned Float64 CTL is **5.34e-9**. It includes the exact
Bazzite failing sample within a 125-triplet binary32 neighborhood. This establishes independent
Mac agreement; it does not resolve the retained Linux failure. Existing Mac
slider p95 ranged from 10.0–10.6 ms under continuous draft input and 17.3–25.7 ms
paced; warm pan/zoom p95 was 13.1/12.5 ms. These do not establish sharp interaction.

The exact cold-export rerun passed both unchanged gates: fresh-worker p95
**3625.46 ms**, subsequent p95 **3814.90 ms**, twenty samples total. Retained evidence:
`playwright-1792157839472-ec7a795a-5c78-4440-8353-849bf93d396b/`.
The initial 4083.99 ms failure remains part of the baseline's variability.

The merge baseline completed **283 passes and two failures in 414.64 s**:
`2026-10-16T13-38-55.680Z-benchmark-VXuHJY/summary.md`. All 2/3/5-source
calibration and distinct-original gates passed. Nine-source calibration reached
**15443.67 ms**; the real nine-source burst reached **18063 ms**, both above the
unchanged 15-second maximum. Exact nine-source reruns also failed: repeated-fixture maximum **17979.27 ms**
and distinct-original maximum **18221 ms**
(`playwright-1792158404952-abff0d9d-0f7c-4d8a-b3f7-bcf4e8b1e595/`). Output accounted
for about 5.5 seconds; alignment-attempt/preparation measurements overlap and
must not be added to that wall time. All fifteen fixture hashes matched before
and after the complete invocation.

### Integrated focused checks

The integrated numerical/export/merge selection completed **342 passes, one
failure and one native-only deferral in 144.18 s**:
`artifacts/verification/2026-10-16T16-40-22.784Z-check-njY6w6/summary.md`.
CPU/GPU/pinned CTL, direct and tiled rendering, scalar math, histogram GPU,
export reconstruction and native encoding, actual working-source reuse, cache
corruption/cancellation/eviction, retry cleanup and committed Sony HDR preparation
passed. The exact histogram UI rerun passed in **4.9 s** after the test waited for
matching analysis identities and the existing curve animation to finish. The
native pointer-lock/navigation case separately passed in **6.5 s** foreground.

The new import-during-export reproduction now passes. The picker admits a new
import while an export is active; frozen export edits and current selection are
retained. Focused checks also caught and fixed an already-aborted cache-validation
stream race. Earlier failed invocations remain preserved beside the final runs.

The initial eight-tile sharp batching run has **280 passes, two failures in
79.31 s**:
`artifacts/verification/2026-10-16T16-53-11.659Z-benchmark-eNrYmG/summary.md`.
Both layouts sustained 60 Hz with zero drafts, stale revision regressions,
attribution failures, loaders or hidden frames. History, source reuse, memory,
final histogram convergence and all invalidation/cancellation assertions passed.
Performance remains failed: minimum-size Console Fit completed 140–150 of 240
inputs with about 51 ms p95 latency; the 1440 × 900 Fit completed 40–41 with
118–126 ms p95. The unchanged progress/latency gates remain visible. The exact rerun reproduced the misses.

The 32-tile comparison and exact rerun retained correctness, source reuse,
allocation and cancellation behavior while improving presentation progress by
about 18–22%. It is now the default; `VITE_LUMA_HDR_TILE_BATCH=8` retains the
internal comparison. First comparison: **280 passed, two failed in 79.13 s**,
`artifacts/verification/2026-10-16T16-56-37.592Z-benchmark-8axxVA/summary.md`;
exact rerun:
`artifacts/verification/playwright-1792169944795-525886bd-3368-4309-a870-0bba8dae6159/`.
Minimum Console Fit completed 165–179/240, 100% 235–236/240; larger Retina Fit
49/240, 100% 87–88/240. Non-source invalidation completed in 53–120 ms, within
500 ms. Both candidates allocate the same 630.6/687.5 MB by layout. All completed
frames were sharp. Latency and larger-workspace progress gates remain failed.

The diagnostic 32-tile invocation completed **280 passes and two failures in
80.64 s**:
`artifacts/verification/2026-10-16T17-01-37.991Z-benchmark-bX2bn0/summary.md`.
Elapsed stage measurements, including driver/queue waits rather than hardware
GPU timestamps, attribute large Fit's 79–81 ms frame work to about 74–76 ms across
ten tile completion checkpoints (330 tiles, 1.437 million evaluated texels).
Large 100% uses about 38 ms in five checkpoints (180 tiles, 784080 texels),
45 ms total. Retained-frame copying costs about 0.7 ms minimum / 1.3 ms large,
so replacing its transport is not justified by this measurement. Final frames
and histograms still converge, with unchanged 33 ms and 500 ms gates.

### Sustained editor matrix

The registered `mac-workability-benchmark` invocation completed **279 passes and
four performance-case failures in 647.01 s**:
`artifacts/verification/2026-10-16T17-39-47.535Z-benchmark-Gow1pH/summary.md`.
It retains **192 trials and 46080 actual React input events**: eight sliders,
Fit/100%, two layouts, separate 60/120 Hz configurations, three repetitions and
240 inputs per trial. Measured input ranged from 59.97–60.13 / 119.75–120.05 Hz;
every trial met the required cadence. The display reports P3, DPR 2 and 120 Hz.

All functional assertions passed: 19954 completed sharp presentations, **zero
drafts**, no regressed or misattributed revisions, no loaders/hidden frames or
sidebar movement, matching final edit and histogram, one source upload and one
history entry per gesture. Coalescing omitted 26126 intermediate inputs. Release
refinement stayed within 32.1–100.3 ms; final histogram curve convergence took
107.5–191.4 ms. Maximum observed stale-frame age was 192.5 ms. These successful
conditions do not make the failed performance cases pass.

Each row spans all eight sliders and three repetitions. Progress counts are
presentations during the 240-input gesture; the unchanged minimum is 160.
Frame/histogram p95 limits remain 33 ms and release refinement remains 500 ms.

| Content size / Console |  Input | Fit progress |  Fit frame p95 | 100% progress | 100% frame p95 |
| ---------------------- | -----: | -----------: | -------------: | ------------: | -------------: |
| 1100 × 700 / open      |  60 Hz |      165–183 |   41.9–49.4 ms |       233–238 |   33.8–34.4 ms |
| 1100 × 700 / open      | 120 Hz |        87–90 |   34.2–34.6 ms |       113–115 |   26.5–34.1 ms |
| 1440 × 900 / closed    |  60 Hz |        49–50 | 101.0–109.2 ms |         87–89 |   67.5–75.4 ms |
| 1440 × 900 / closed    | 120 Hz |        23–24 |   92.8–93.9 ms |         41–43 |   59.2–59.9 ms |

Histogram first-curve p95 ranged from 33.6–110.0 ms. Exact failing-case replay reproduced all four performance failures in
**628.08 s**, with another 192 trials / 46080 inputs, zero functional issues and
zero drafts. Per-case maximum p95 was 50.4 / 34.8 / 109.3 / 94.0 ms in table
order; final refinement stayed below 100 ms:
`artifacts/verification/playwright-1792173086692-30fda0cd-81a2-454c-aac4-dcf93fb924ab/`.
No thresholds or samples changed. The matrix uses the fixed compiled
editor code; independent merge PNG source edits are not executed by these trials.
Physical pointer delivery, display scanout and HDR luminance remain unmeasured.

The explicit original targets `hdr-benchmark`, `hdr-slider-benchmark` and
`hdr-interaction-benchmark` completed **283 passes and two failures in 80.27 s**:
`artifacts/verification/2026-10-16T18-14-19.983Z-benchmark-ljceoQ/summary.md`.
Cold selection (1161.6 ms median), cached revisits (512.4 ms p95), paced pan/zoom
(17.9/18.4 ms p95), pointer-locked burst drag (17.9 ms), and warm/cold continuous
navigation (13.0–20.5 ms) passed their existing gates. Warmed actual-editor exposure
failed at 83.8 ms p95. The short burst suite stopped at its retained progress
assertion (Fit Exposure: five completed frames/histograms); its remaining sliders
are covered independently by the complete sustained matrix above. Exact replay
reproduced both failures in **18.98 s**, exposure 83.9 ms:
`artifacts/verification/playwright-1792174572619-d470f56f-3b5f-4027-b9b5-46dd2ba6d292/`.
An earlier invocation stopped at a sandbox-denied localhost bind; its exact Node
case and the complete selected rerun passed that check outside the sandbox. It is
retained under `2026-10-16T18-13-23.722Z-benchmark-AdxM4u` as an execution limit.

### Export measurements

Separate export series completed **one pass and one failure in 151.59 s**:
`artifacts/verification/2026-10-16T17-05-45.207Z-benchmark-3AvUt6/summary.md`.
The existing twenty cold original-decode samples remain unchanged. Fresh-worker
p95 was **4080.22 ms** (four-second gate failed); subsequent-worker p95 was
**3803.86 ms**. The first fresh sample spent 1002.5 ms in native HDR encoding;
GPU tile work stayed about 1792 ms. This resembles baseline variability rather
than demonstrating a new regression. The exact cold rerun passed both gates: fresh-worker **3631.37 ms p95**,
subsequent **3727.11 ms p95**, one passing case in **74.38 s**:
`artifacts/verification/playwright-1792170549844-c8395252-4f96-462f-a407-efad648ad998/`.
The first failure remains part of the evidence.

Ten warm working-source exports passed at **3109.92 ms p95**, including full and
strip hash validation, pinning, durable publication and cleanup. Ten exports
interrupted after completed preparation reused it in a fresh worker and completed
at **3982.09 ms p95**; retry overhead is reported independently, with no replacement
of the cold gate. All samples retained frozen edits, GPU rendering, native
encoding, image dimensions, sampling, source bytes and existing memory limits.
Warm median was 3.099 s versus 3.678 s for the same-run subsequent original-decode
series (15.8% lower, descriptive). Full/strip validation still cost 278–292 ms;
cache reuse bypasses decoding without dropping validation. GPU allocation was
406709736 bytes and native process peak stayed at or below 895139840 bytes.
These measurements use committed source `0b4f99f`; only this document was dirty.

### Preview generation and presentation

The first candidate preview invocation failed its retained GPU-versus-legacy
gate, one case in **384.07 s**:
`artifacts/verification/playwright-1792171203304-9c330649-7c30-4c46-af33-50cd694f914f/`.
GPU generation plus actual Electron presentation improved from **3226.18 ms**
to **2544.13 ms median** (21.1% lower). Legacy PNG was **2357.98 ms**, so the
GPU-versus-legacy gate remains failed. CPU measured **43617.13 ms** versus the
44440.16 ms baseline; both uncorrected paths pass the saved 15% regression gate.
Corrected GPU was 2383.30 ms versus corrected CPU 43667.83 ms. Cached GPU
presentation was **16.90 ms** versus legacy 16.60 ms, within its unchanged gate.

The run reuses compiled production preview source `0b4f99f`; independent merge
source edits did not execute in this case. The invocation's `preview-provenance.json`
records built worker/shared-math and saved-baseline hashes. No concurrent builds
or tests ran. The exact rerun again failed only GPU versus legacy: **2594.95 ms** versus
**2382.26 ms**, CPU 43982.89 ms, cached GPU 16.95 ms; both saved regression
checks and cached-presentation gate passed. The case took **386.20 s**:
`artifacts/verification/playwright-1792171722691-18266a2c-0fe1-4d46-be5e-6784f8ac89a3/`.
All cold/cached CPU/GPU and legacy samples were retained. This measures software completion/presentation,
not physical scanout.

### Merge measurements

The first integrated merge family completed **11 passes, one failure in
372.10 s**:
`artifacts/verification/2026-10-16T17-11-32.752Z-benchmark-vaf7bl/summary.md`.
All fifteen original hashes matched before and after
(`artifacts/fixture-integrity/2026-10-16T17-11-32.414Z-9453.json`).

| Sources | Repeated-original calibration maximum |         Distinct Sony noise maximum |
| ------- | ------------------------------------: | ----------------------------------: |
| 2       |                            8110.08 ms |                             9354 ms |
| 3       |                            8781.49 ms |                            10137 ms |
| 5       |                           10665.13 ms |                            12545 ms |
| 9       |                           14347.17 ms | **16731 ms — failed 15000 ms gate** |

Every maximum retains three repetitions. Nine-source calibration now passes;
distinct nine remains above the unchanged gate despite improving from the
18063/18221 ms baseline maxima. Its exact rerun again failed at **16473 ms**,
three repetitions in **51.2 s**:
`artifacts/verification/playwright-1792171091146-866882c2-6f7e-4a52-974b-5b66805abb3a/`.
Original hashes matched again. Warmed native merge wheel/drag with deghost overlay
also passed in the family invocation.

Distinct nine-source output took 4.29–4.37 s, versus about 5.5 s before shared
math. GPU conversion used about 1.86 s (115 batches; about 1.77 s elapsed mapping
and completion, including hardware work). Copying cost 9–13 ms. The remaining
2.43–2.50 s warrants finer CPU composition, file I/O/hash and PNG attribution;
conversion copying alone cannot explain the remaining miss. Alignment-lane and
native-validation measurements overlap and must not be summed as serial stages.

The measured output follow-up passed **295 checks in 55.76 s** with no
failures/skips:
`artifacts/verification/2026-10-16T17-35-30.634Z-check-bjLtt2/summary.md`.
Paired/separate and partial-strip conversions are byte-equal, returned mapped
bytes remain independently owned, and existing CPU/GPU, fallback and capacity
assertions remain. GPU allocation stays 901807848 bytes. Pairing reduces 115
readbacks to 58 while still evaluating 115 image strips; copying falls to about
4.3 ms, but elapsed GPU work stays about 1.75 s. The new nine-source maximum is
**16437 ms**, exact rerun **16471 ms**, both still above 15000 ms:
`artifacts/verification/playwright-1792172214078-d8232289-090f-4bed-a943-920d0a68942c/`
and `artifacts/verification/playwright-1792172283725-8ad39264-f62a-4e57-91b1-0bf530d43689/`.

Per-image attribution identifies the next candidate: result/reference PNG encoding
costs about 740–754 / 868–870 ms, plus 43–53 ms for the overlay. Composition costs
153–190 ms, mask work 132–136 ms, hashing 205–209 ms, writing 147–192 ms and
reading about 40 ms. The temporary-review PNG compression-level-1 candidate passed all **295 focused
checks in 64.03 s**, including exact old/new decoded RGBA, alpha, geometry and
conservative encoded-size bounds:
`artifacts/verification/2026-10-16T18-02-11.868Z-check-9LIoFT/summary.md`.
Its first matched run remained variable: maximum **17367 ms** (16575/17367/16347),
**55.04 s** total:
`artifacts/verification/playwright-1792173809501-e8de47e8-6a53-49b7-b9e9-62a0b0c8251a/`.
The exact rerun improved to maximum **16081 ms** (16081/15919/15966), **52.53 s**:
`artifacts/verification/playwright-1792173876257-2e003872-232f-4684-b255-53170d8ead2e/`.
The 15000 ms gate still fails. Native PNG encoding consistently drops from about
1.65 s to 0.83–0.90 s, with about 32 MB extra scratch output (4.233 GB total writes
versus about 4.201 GB). Output in the rerun takes 3.43–3.50 s. Higher source-strip,
output-write and publication elapsed times partly mask the gain; the measurements
do not identify a physical disk cause. GPU allocation remains 901807848 bytes and
observed worker peak stays below the existing 2 GiB limit. Compression level 1 is
retained in `980435a`; the complete affected merge family is rerun on that commit. The master, algorithms, checksums and sequential encoders
remain unchanged.

The final committed merge family completed **11 passes and one performance failure
in 349.77 s**:
`artifacts/verification/2026-10-16T18-06-44.961Z-benchmark-0kcQ1G/summary.md`.
Three repetitions remain in every native series. All synthetic resource checks
and sixteen warmed native viewport cases passed (p95 10.0–12.4 ms). The retained
nine-source failure has already been reproduced by exact cases above; no threshold
changed. All fifteen originals matched before and after:
`artifacts/fixture-integrity/2026-10-16T18-06-44.632Z-20792.json`.

| Sources | Final calibration maximum |   Final distinct Sony noise maximum |
| ------- | ------------------------: | ----------------------------------: |
| 2       |                7513.47 ms |                             8443 ms |
| 3       |                8382.67 ms |                             9355 ms |
| 5       |               10754.12 ms |                            11719 ms |
| 9       |               13600.33 ms | **15752 ms — failed 15000 ms gate** |

The final distinct-nine maximum is 12.8% lower than the first unchanged 18063 ms
baseline and 13.5% lower than its 18221 ms replay. These descriptive comparisons
retain uncontrolled filesystem/driver caches and the failed acceptance gate.

### Foreground interference

The registered `mac-workability-interference` invocation initially reported
**279 passes, four failures in 74.68 s**:
`artifacts/verification/2026-10-16T18-16-42.911Z-benchmark-X09ffK/summary.md`.
Import completed all three matched repetitions and failed only the retained
latency gates. The other cases stopped before measurement: setup observed the
previous import's retained completion message before the next import published
all sources. Exact replay reproduced this setup race. The benchmark now waits
for every required filename and for import work to end before freezing IDs;
this setup wait is outside measured operation time. Application code is unchanged.

Corrected individual export completed three matched pairs with only latency
failures in **57.16 s**:
`artifacts/verification/playwright-1792174794856-eee7ac38-6fc9-4875-99aa-cbb4f2f64066/`.
Its replay plus the corrected batch and merge cases completed **three failed
performance cases, no skips, in 429.37 s**:
`artifacts/verification/playwright-1792174877504-cc65f602-ab5f-4bb7-b2c3-b4bccd908f50/`.
Each case retains three idle-editor, idle-operation and editing-plus-operation
trials at 1100 × 700, Console open, Fit and 60 Hz. All operations completed without
task or cleanup errors. Sharpness, source retention, history, final edits,
histogram convergence, panel geometry and refinement assertions passed. There
were no drafts or source changes during the gestures. Latency remains failed
even in the idle controls.

| Operation               | Idle operation duration |  With editing | Editing frame p95 | Editing histogram p95 | Sharp progress / 240 |
| ----------------------- | ----------------------: | ------------: | ----------------: | --------------------: | -------------------: |
| Import nine originals   |             2.55–3.01 s |   6.95–6.98 s |      42.1–43.2 ms |          50.8–50.9 ms |              176–179 |
| Individual export       |             3.97–4.13 s |   7.94–8.07 s |      42.4–42.8 ms |          50.8–50.9 ms |              176–177 |
| Nine-photo batch export |           33.47–33.95 s | 37.56–37.64 s |      42.2–42.7 ms |          50.8–51.0 ms |                  176 |
| Nine-source merge       |           16.00–16.68 s | 19.91–20.12 s |      42.6–42.7 ms |          50.6–50.9 ms |              178–180 |

Matched ratios are descriptive: about 2.32–2.73× import, 1.96–2.00× individual
export, 1.11–1.12× batch and 1.21–1.24× merge. Operation clocks include scheduling
and waiting; merge includes review preparation/alignment before background task
acceptance and durable publication. These are not simultaneous-computation or
physical-disk measurements. Task/operation intervals overlap 238–239 of 240 inputs,
not all inputs. Input cadence meets the 99% requirement; dispatched-operation time
and actual stage/progress samples remain in each `interference.json`. Original
hashes matched before and after the corrected sequence:
`artifacts/fixture-integrity/2026-10-16T18-21-16.819Z-28521.json`.

Exact batch/merge replay reproduced only the same latency failures: **two failed
cases, no skips, in 373.48 s**, three matched pairs each:
`artifacts/verification/playwright-1792175348886-9c737868-f491-44ca-95a9-41c9530e7aac/`.
Batch duration was 33.39–33.57 s idle / 37.40–37.56 s editing; merge was
16.20–16.58 s / 20.04–20.64 s. Frame p95 remained 42.2–43.0 ms, histogram
50.6–51.1 ms, zero drafts, achieved cadence 59.99–60.14 Hz and refinement
within 41 ms. Every non-latency assertion passed. All fifteen originals matched
again (`artifacts/fixture-integrity/2026-10-16T18-29-08.159Z-29521.json`).

### Agreed full checkpoint and workflow fixes

The one agreed `check:full -- --foreground` invocation used committed Sony HDR
brackets and revision `6c044f1`. It completed **722 passes, 19 failures and 19
skips in 1174.02 s**:
`artifacts/verification/2026-10-16T18-36-02.320Z-check-cln3Sw/summary.md`.
Type checking, lint, formatting, build and isolated MCP import passed. All fifteen
original hashes matched before and after:
`artifacts/fixture-integrity/2026-10-16T18-36-02.026Z-30379.json`.
This failed checkpoint is preserved; subsequent repairs use focused selections.

| Execution group     |       Passed | Failed | Skipped | Duration |
| ------------------- | -----------: | -----: | ------: | -------: |
| Node                |          279 |      0 |       0 |   6.02 s |
| Service             |          212 |     11 |       1 |  42.83 s |
| Service exclusive   |            3 |      0 |       0 |  23.00 s |
| Electron            |          116 |      1 |       0 | 204.27 s |
| Electron exclusive  |           35 |      0 |       0 |  91.75 s |
| RAW/GPU             |           77 |      7 |      18 | 748.29 s |
| Isolated MCP import | Passed stage |      — |       — |  48.32 s |

The eleven service failures reproduced exactly in **3.62 s**:
`artifacts/verification/playwright-1792176954586-3868c8d9-6068-4f68-bb07-9ba04d89724b/`.
They exposed a real persisted-revision race and legacy-master recovery bug,
alongside current synthetic fixtures incorrectly carrying an old metadata version.
The progressive-review focus/Space case passed alone in **0.77 s**; its test must
wait for the prepended ordering to mount before asserting retained focus. Seven
RAW failures use obsolete SDR, output-directory reuse, capture-serial or timeout
assumptions. All seven reproduced on exact replay in **284.23 s**:
`artifacts/verification/playwright-1792177081449-0d68cd5b-05d9-4070-a717-a8cc6af75932/`.
Their modernized correctness selection and the additional canvas bug it exposed
are recorded below.

The eleven failed service cases and eight new transaction regressions subsequently
passed together: **19 passes in 3.2 s**:
`artifacts/verification/playwright-1792180056812-74cfd2fe-8a1f-4cd3-8a30-5741cbb851e0/`. The registered focused workflow selection
then passed **377 cases, zero failures/skips in 138.84 s**:
`artifacts/verification/2026-10-16T19-50-33.553Z-check-Jdtuaw/summary.md`.
Selected targets: `edit-history`, `merge-library`, `import-pipeline`,
`stack-group-actions`, `progressive-review-ui`, `adjustment-input-decimal`,
`adjustment-input-integer`, `adjustment-wiring`, `editor-mcp`, `editor-mcp-raw`,
`export-context`, `export-ui`, `full-previews` and `merge-raw-ui`, plus cheap checks.
This includes actual Sony merge review/publication/restart/source deletion and
RAW MCP statistics/history. The library fixes are committed as `e7d305c`.

RAW correctness helpers now follow automatic Rec.2020 preparation and the current
ACES SDR proof rather than expecting the former 8-bit LibRaw rendition. Every
cold/proof publication uses fresh staging; matching warm renders explicitly reuse
validated HDR assets. Changed corrections prepare separate assets. Tests retain
original/working/frame hashes, native geometry and byte counts, alpha, numerical
bounds, exact CPU references and matching center-sampled ICC placeholders. The
renderer capture helper stamps copied pixels only after that canvas publishes its
fenced serial, retaining strict same-frame identity and dimension checks.

The modernized RAW selection completed **297 passes, one failure and no skips in
1082.13 s**:
`artifacts/verification/2026-10-16T19-54-03.290Z-check-pVipJw/summary.md`.
All nine native CPU proof/reference traversals passed (498.22 s), as did corrected
CPU/GPU agreement, GPU-failure fallback, both white-balance correction variants
with full-image references (211.03 s), and raster renderer regressions. All fifteen
original hashes matched. The remaining actual-editor comparison reproduced a
five-code dark-channel difference at Shadows +100. Its unchanged exact replay
failed again in about 35 s:
`artifacts/verification/playwright-1792181585480-85a91a7a-8e2f-42a2-9e1d-663c336e8799/`.

CPU, native GPU and independent pinned CTL agree on those three source samples:
`artifacts/mac-workability/shadow-triangulation/cpu-ctl.json` and `gpu.json`.
The actual source, coordinates and reported sRGB target also match. A controlled
same-canvas probe reproduced the cause: after P3 → sRGB, Chromium reports the
new configuration but retains the drawing buffer's former primaries. Direct
reconfiguration and `unconfigure()` alone retain the error; resetting the same
canvas dimensions clears it. Diagnostic evidence, including all reset comparisons:
`artifacts/verification/playwright-1792182165011-072bde36-9308-4fb4-a98d-2f243583e5c4/`.

The narrow configuration fix and renderer regression are committed as `719919b`.
The registered exact target subsequently passed **280 checks, zero failures/skips
in 87.12 s**:
`artifacts/verification/2026-10-16T20-27-37.539Z-check-Jm1Scs/summary.md`.
It includes four software sRGB/P3 transitions at Shadows +100, all eighteen
combined-edit states, Before/After, source reuse, device loss and CPU fallback.
The original one-code GPU and two-code fallback limits remain unchanged. The
controlled canvas probes are diagnostic artifacts; they do not add runtime
color compensation. Steady-state benchmarks were not repeated after the canvas
configuration fixes; the numeric processing and steady-state frame path remain
unchanged. The reset runs for initial/unconfigured setup or a change of primaries.
Physical output is still unmeasured.

The related display/full-preview selection completed **291 passes, zero failures
and one Wayland-only deferral in 213.57 s**:
`artifacts/verification/2026-10-16T20-29-47.500Z-check-2LYNzp/summary.md`.
Selected targets: `adjustment-renderer-ui`, `full-previews-raw`,
`full-preview-raw-ui`, `hdr-content-ui`, `hdr-interaction-ui` and `hdr-editor-ui`.
This verifies native Mac full screen with Console, monitor/headroom/device
changes, retained pixels, independent held histogram readback, source reuse and
native navigation. The corrected native RAW proof now compares **every RGB and
alpha pixel** against its analytic reference (69.21 s), plus complete/strip hashes,
exact placeholder and unchanged original. The test updates are committed as
`ced7b40`. The skipped native Wayland case leaves this invocation at exit 2;
every applicable Mac case passed.

Final lifecycle review added transitions after `unconfigure()`, matching the
source-reload path. The previous fix reproduced a three-code error in **34.47 s**
because the canvas no longer reports its former primaries:
`artifacts/verification/playwright-1792183106823-d750c10b-3fa5-42cb-998c-6dc96dda8447/`.
The reset now also covers this unknown configuration. The expanded exact target
passed **280 checks, zero failures/skips in 86.86 s**:
`artifacts/verification/2026-10-16T20-39-50.702Z-check-daikJg/summary.md`.
The source and regression are committed as `cedef59`. The final related targets
`full-preview-raw-ui`, `hdr-content-ui` and `hdr-interaction-ui` passed **283 checks,
zero failures/skips in 31.17 s**:
`artifacts/verification/2026-10-16T20-42-32.696Z-check-2sqxvQ/summary.md`.
These retain real initial RAW loading, visible pixels, source reuse, independent
histogram work and native navigation after the final configuration change.

The combined-adjustment case retains nine native CPU proofs and full-image
reference traversals. Correctness timeouts allow those computations to finish:
900 s for that case, 360 s for two white-balance correction variants, 180 s for
lens variants and 120 s for single native CPU/fallback proofs. These are liveness
budgets, separate from the unchanged 33 ms interaction, four-second export,
15-second merge and 15% preview regression gates. No samples or pixel assertions
were removed to meet a routine verification budget.

Publication now validates the persisted edit revision inside its SQLite
transaction, rejecting concurrent updates/Undo/Redo without lost history. No-ops,
rollback/retry and an edit queued behind isolated Trash retain their state and
notification contracts. Recovered legacy merge manifests create current runtime
metadata without rewriting immutable provenance or masters; cached derived
metadata never enters original-container inspection. Current synthetic fixtures
use the current metadata constant, while explicit v3 recovery coverage remains.
The progressive-review test waits for new-order chunks before checking retained
focus and pressing Space. A lint-only prerequisite failure was fixed and rerun
before the successful selection; its evidence remains preserved.

The nineteen deferrals comprise unavailable private camera evidence (one capture
case and seventeen BRK cases) and one native Wayland-only case. The committed
three-frame HDR sequence still runs through the ordinary Sony merge and UI/MCP
targets. Private fixtures are not replaced with invented metadata or repeated
originals. Physical integration gaps remain separate below.

The failed full checkpoint and all superseded failures remain preserved. Repairs
were verified through the focused selections above; a second full checkpoint and
`check:all` were not run. Durations above the routine budget retain their warnings;
no correctness, progress or performance gates were weakened.

Final fixture integrity passed at completion:
`artifacts/fixture-integrity/2026-10-16T20-42-32.380Z-53951.json`.
The common Sony fixture also matches its committed SHA-256
`14c9d2912584a3ccc5cf10f554fbe495fc960c36758a14d7d858b36ac5ca88e2`.
Cleanup audit: **333 recorded launches, all 285 recorded temporary profiles
removed, no matching profile processes, no project processing workers and no
window-policy violations**. The owned baseline checkout is removed; benchmark
evidence remains under ignored artifacts:
`artifacts/mac-workability/cleanup.json`.

### Enabled workflow coverage

The agreed foreground functional checkpoint and focused repairs supply the Mac
software results below. Native integration gaps remain explicit even when adapter
tests pass.

| Enabled area                                                            | Mac software result                                                                                  | Additional limits                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| File/folder import, review, duplicates, background tasks                | Full/focused import, review, duplicate and task checks passed; picker bug fixed                      | Native picker and macOS permission dialogs are injected in automation.                                    |
| Device discovery, missing-photo recognition, disconnection              | Adapter/service/UI checks passed; private capture cases deferred                                     | Real card mounting/unplugging and TCC access are unverified; diskutil/plutil facts are fixture-backed.    |
| Library search, scrolling, selection, ranges and groups                 | Full and focused browsing/group checks passed                                                        | Automated profiles contain fixture libraries only.                                                        |
| Confirmed Trash and recovery/restart                                    | Full and focused journal/transaction/recovery checks passed                                          | Isolated Trash adapters; real Finder/OS Trash restoration is unverified.                                  |
| Eight enabled sliders, lens toggles, comparison, overlays and Undo/Redo | Shared inputs/history/MCP passed; sharp trials functional, performance failed                        | Other editing controls stay disabled.                                                                     |
| Zoom/pan, cached navigation, CPU fallback, device loss                  | RAW/GPU/CPU fallback and display lifecycle passed; sustained performance failed                      | Physical scanout/luminance is unmeasured.                                                                 |
| Typed MCP revisions, statistics, pixels, export and isolated import     | Full and focused protocol checks passed                                                              | A specific external client connection is not certified.                                                   |
| Individual/batch SDR/HDR JPEG export, retry/cancel/publication          | Functional and warm-source checks passed; cold first-launch gate remains variable                    | External reader interoperability and physical HDR display are separate.                                   |
| Merge review, alignment, publication, restart, source deletion          | Sony workflows and final 2/3/5/9-source noise 15-second gates pass; three-RAW five-second gates fail | Missing private BRK sets, larger controlled HDR brackets and distinct 32-RAW sequences remain incomplete. |

## Next Mac merge improvement plan

The next milestone establishes a competitive target on this M4 Pro before another
Mac optimization pass. Published timings do not establish a universal five-second
expectation. HDR brackets and equal-exposure noise stacks remain separate workloads.
The existing five-second test and its failures stay unchanged while the comparison
is measured; no acceptance threshold is revised by this plan.

### Application research and target proposal

Primary sources reviewed on October 17, 2026 provide context with different inputs,
machines and completion boundaries:

| Source                                                                                                                                                                                                                                               | Reported behavior or timing                                                                                                     | Comparison limit                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Capture One HDR overview](https://support.captureone.com/hc/en-us/articles/4410014730257-HDR-merging-overview)                                                                                                                                      | The vendor gives 10 seconds to five minutes depending on hardware, source count and resolution; Auto Align adds time.           | A broad support range, without a matched M4 Pro benchmark or fixed quality settings.                                                                                                                                                                               |
| [Capture One worked interior example](https://www.captureone.com/blog/hdr-101-interior-christophe-benard-capture-one)                                                                                                                                | Three full-resolution Sony A7R IV exposures produced an HDR DNG in 30 seconds, with Auto Align on and Auto Adjust off.          | Vendor-published practitioner example; hardware and repeated-run variation are unspecified. Different source resolution from Luma's fixtures.                                                                                                                      |
| [Puget Bench for Lightroom Classic comparison](https://www.pugetsystems.com/pugetbench/results/compare/Puget%20Bench%20for%20Lightroom%20Classic/20/CPU/Intel%20Core%20i7-8700K%20CPU%20%40%203.70GHz/AMD%20Ryzen%205%207600X%206-Core%20Processor/) | The legacy 42 MP ARW HDR metric is 11.51 seconds for Ryzen 5 7600X and 17.68 seconds for Core i7-8700K.                         | Aggregated public desktop results, not M4 Pro. The displayed comparison does not establish source count, merge settings or Luma's durable completion boundary.                                                                                                     |
| [Adobe Lightroom desktop HDR workflow](https://helpx.adobe.com/lightroom/desktop/edit-photos/hdr-panorama.html)                                                                                                                                      | Lightroom presents an adjustable preview before generating the final merged HDR DNG.                                            | A workflow definition, not a numerical performance claim. Preview and final generation need separate clocks.                                                                                                                                                       |
| [Burst Photo pull request 38](https://github.com/martin-marek/hdr-plus-swift/pull/38)                                                                                                                                                                | The author reports 3.23 seconds for alignment and merging of seven bracketed 20.3 MP images on a seven-GPU-core M1 MacBook Air. | A component result from a different algorithm; conversion, loading and saving are outside the reported stage. Its GPU completion boundary is not established as equivalent to Luma's completed-work fences. Context for research, not a complete-operation target. |

The user selected Adobe Lightroom as the practical reference and authorized
measurement with the same images. Lightroom desktop 9.3 (build
`2026.0407.1239`, not Lightroom Classic) was measured on this M4 Pro through its
[Local workflow](https://helpx.adobe.com/lightroom/desktop/add-import-and-capture-photos/access-photos.html).
Seven separate folders contain verified copies of `DSC03243.ARW`, `DSC03244.ARW`
and `DSC03245.ARW`; no Cloud import was used. Setup is excluded from five timed
fresh-folder runs; one of those has an agent review interruption and is retained
separately from the four uninterrupted workflow results. Auto Align is on, Auto Settings off, Deghost High, Apply HDR
Always on and Show Deghost Overlay on; Create stack is disabled in Local view.

| Lightroom sample                      | Preview ready (s) | Merge to local result ready (s) | Active workflow (s) |
| ------------------------------------- | ----------------- | ------------------------------- | ------------------- |
| Fresh folder 1 (interrupted)          | 6.810             | 3.786                           | 10.596              |
| Fresh folder 2                        | 6.987             | 3.542                           | 10.529              |
| Fresh folder 3                        | 6.737             | 3.155                           | 9.892               |
| Fresh folder 4                        | 6.548             | 3.392                           | 9.940               |
| Fresh folder 5                        | 6.936             | 3.200                           | 10.136              |
| First merge after application restart | 7.675             | 3.428                           | 11.103              |

The four uninterrupted running-application samples have a **10.038 s median**
and **10.529 s maximum**. Sample 1 retains its **10.596 s active-stage sum** but
has a 12.869 s agent review pause, during which hidden work could occur; it is
excluded from the primary uninterrupted summary. The five preview observations
have a 6.810 s median. The restart control is recorded
separately; application startup, source browsing and OS-cache flushing are outside
its clock. Runs are sequential, not randomized or interleaved with fresh Luma
measurements. OS, disk, driver and application caches are uncontrolled. AC power
and a full battery were confirmed. These are measured samples, not a population
p95 or proof of performance across cameras.

Native UI actions carry before/after timestamps. Preview ends when its creation/
refinement progress disappears; final generation ends when Creating HDR ends and
the fourth local photograph is available. Active workflow adds those two stages,
excluding the agent review gap (12.869 s in sample 1, 0–1 ms in the others).
A 100 ms filesystem observer independently records the complete-size DNG appearing
for the five fresh-folder samples. UI observations are upper bounds and include
action transport; native accessibility calls can block during processing.
Neither local-file availability nor UI completion certifies internal `fsync` or
power-loss durability. The original five-second Luma clock remains a separate,
stricter managed-publication measurement.

Each Lightroom result is a 25,233,408-byte DNG 1.7 with 16-bit floating-point RGB
and JPEG XL compression, encoded at 3648 × 5472. The application displays a
3607 × 5410 crop for the inspected result. Luma retains a 3654 × 5450 Float32 RGBA
master of 318,628,800 bytes plus full native comparison images, checksums, durable
publication and cleanup. Different crops, rendering, precision, compression and
validation prevent an equal-quality or identical-work claim. The DNG opens at
100% in Lightroom; ExifTool reports two minor metadata warnings and no error.
A complete cross-application registration, motion, highlight, noise and native-detail
quality comparison remains pending. No lossy/precision change is authorized by
these timing results.

All 21 copied originals retain their committed hashes. Original fixture integrity
also passes. Generated evidence remains outside Git:
`artifacts/lightroom-merge-comparison-2026-10-17/results.json`,
`file-observations.jsonl`, `outputs-metadata.json` and `fresh-output-metadata.json`;
original integrity is recorded under
`artifacts/fixture-integrity/2026-10-17T10-59-13.584Z-35528.json`.
The six timed results completed; the setup run is excluded from timing claims.
No Luma code or automated threshold changed during this research.

The proposed Mac product target is **about 10 seconds typical, at most 12 seconds
for the complete three-RAW HDR workflow**, with **7–8 seconds to a usable
review**. Lightroom preview resolution is not established by these observations;
this is a proposed user-visible goal, not proof of native-detail equivalence.
These rounded planning goals come from the local Lightroom samples,
including its first merge after restart. Confirm them against new Luma measurements
using the same visible clocks and a quality review before registering a competitive
acceptance gate. Keep Luma's managed durability and numerical gates as additional
requirements. First aim for a **15-second engineering checkpoint** after the exact
scheduling/reduction work; this is an intermediate milestone, not competitive
acceptance or a promised result. Five seconds remains an unmet stretch goal and
the current registered test remains in force until an explicit target decision.

Adobe HDR merging does not establish a temporal noise-stack target. Keep the
current 7.59–7.65 s three-source noise result and its unmet five-second stretch
separate; use a genuine burst-noise merger such as Burst Photo for a later matched
quality/mode comparison. Lightroom AI Denoise is a different single-image workload.
The existing sharp-editor latency, progress and refinement goals stay unchanged.

Measure first usable review, native review ready on screen, acceptance to completed
result, and uninterrupted complete operation separately. Human review time stays
outside processing time. Luma currently prepares the full native master and all
three comparison images before returning its review; its dialog also waits for
those images to decode before enabling Merge. The strict processing benchmark
excludes Electron image decoding and presentation, so that clock cannot be compared
directly to an application's visible preview. An externally observed competitor
completion does not prove an internal durable-sync guarantee. Keep Luma's verified
durable-publication clock as an additional result.

### Work order and experiment decisions

The initial experiment decisions below are retained for provenance. The later
[competitive workflow pass](#october-1718-competitive-hdr-workflow-pass) records
N0–N7 implementation and measurements; cross-application quality remains pending.
Existing component costs select
experiments; their exposed ceilings are hypotheses, not promised savings. The
coordinator owns shared integration, builds,
verification registration and every Electron/GPU/benchmark run. Agents may edit
disjoint areas; shared preparation hooks integrate sequentially.

| Task                                  | Owner                              | Depends on                              | Experiment and decision evidence                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N0 — Comparable application baseline  | Coordinator                        | Existing frozen Mac results             | Lightroom: four uninterrupted fresh-folder runs, one interrupted control and one restart control complete. Add equivalent Luma UI clocks and cross-application native-quality review; retain service durability separately. Noise needs a genuine temporal merger, with cold/warm modes separated.                   |
| N1 — Critical-path attribution        | Coordinator                        | N0                                      | Add bounded timeline spans for source preparation, alignment submission/completion, fallback, output and publication substeps. Establish which intervals are exposed on the critical path; keep parallel sums, device execution and map wait separate.                                                               |
| N2 — Fallback scheduling              | Coordinator                        | N1                                      | Submit unchanged source preparation and existing early alignment requests before preparing the reference's highlight-safe fallback. Test whether the existing two lanes can hide currently exposed HDR alignment work during fallback. Keep worker counts, source order, fallback pixels and output order unchanged. |
| N3 — Exact ordered reductions         | CPU preparation agent              | N1; integrate after N2                  | Move camera-channel and CPU-fallback area accumulation into the maintained WASM source. Preserve y/x/contribution/channel order, Float64 sums and every Float32 store. Account for reduction tables/state inside the 128 MiB aggregate arena bound; unsupported capacities retain scalar recovery.                   |
| N4 — Canonical clipping and masks     | CPU preparation agent              | N3                                      | Compile the remaining sensor-mask dilation and boundary repair where profiling still shows exposed cost. Retain exact tap selection, positive-weight tests, Float64 lens geometry, orientation and mask bits. Share preparation integration with N3 sequentially.                                                    |
| N5 — Publication attribution          | Coordinator or available I/O agent | N1                                      | Attribute source verification, copying, destination verification, file/directory sync, catalog commit and cleanup separately. Change I/O only for measured exposed cost; retain checksum validation, journal ordering and recovery at every publication boundary.                                                    |
| N6 — Resident GPU preparation         | GPU research agent                 | N1; review N2–N5 outcomes first         | Extend the isolated camera-evidence study only if the remaining gap justifies it. Include canonical masks, bounded transfer/readback, native evidence, registration decisions and complete output. Keep the prototype disabled until full quality, resource, fallback and lifecycle evidence passes.                 |
| N7 — Mac acceptance and Linux handoff | Coordinator                        | Adopted experiments, N0 target decision | Run focused correctness first, then sequential affected performance and foreground-interference families. Record every target miss and incomplete hardware result. Freeze the reviewed revision and update the Bazzite continuation after the Mac experiments are assessed.                                          |

N2 has a concrete scheduling hypothesis: the reference is currently prepared first,
followed by roughly 4.9 seconds of highlight-safe fallback before either other
source launches alignment. Deferring that fallback could hide part of the final
roughly 2.14-second HDR residual. That residual includes more than alignment and
is not a guaranteed saving. Extra CPU contention or higher combined memory can
invalidate the experiment; verify both existing alignment lanes and the main
kernel together. The actual HDR fixture uses clipped-reference fallback, so
omitting it would change quality.

N3 addresses approximately 4.1 seconds in the three HDR camera writers, of which
about 1.5 seconds is already compiled conversion, plus roughly 0.7 seconds inside
fallback conversion outside its compiled loop and copying. The remainder includes
ordered JavaScript reductions and other writer work; measure them before claiming
a saving. Camera values/weights retain their ordered Float64 sums; fallback
luminance accumulation must retain its existing Float32 rounding on every write,
not only at the final store. Ordinary noise stacking does not run camera-channel
evidence. N4 targets
approximately 0.6 seconds of mask work in noise and 0.7 seconds in HDR. N5 starts
from only about 0.77–0.84 seconds of measured publication, with roughly 0.07–0.15
seconds more to the final cleanup event; no multi-second copy bottleneck is known.

The current native decoder remains the production source. HDR fallback spends
about 1.30 seconds in its CPU linear decode; reopening the session costs only a few
milliseconds. Native decoder replacement remains separate research with an
unresolved Mac numerical mismatch. A replacement is not justified by avoiding
those small opens, and a faster mismatching output does not pass.

For N2–N5, adoption requires exact frozen prepared planes/strips, clipping and
motion masks, registration and published master identities, source hashes,
cancellation/recovery, scalar fallback, existing memory bounds and a repeatable
complete-operation gain in matched controls. Retain all three fresh runs and
their slowest result; component speed alone is insufficient. Reject or archive an
experiment when its full-operation gain is lost in matched variation, tail time
regresses, or any quality/resource/lifecycle gate fails. Do not revisit the rejected
64-thread output workgroup without new evidence of a different bottleneck.

N6 retains the existing pixel tolerance and exact masks, but passing those alone
does not establish equivalent registration or masters. Its roughly six-millisecond
resident numerical result excludes decode, canonical clipping, upload, proof
readback, validation and saving. Any intentional pixel-policy change needs explicit
versioning and a reviewed numerical/quality contract rather than weakening frozen
identity assertions. A quick-review workflow, if later selected, must have its own
product decision and final-native acceptance gate; it cannot stand in for faster
complete processing.

After this bounded Mac pass, assess achieved competitive times and remaining
quality gaps, freeze the implementation and continue on Bazzite. Further Mac
experiments need a measured critical-path opportunity rather than an indefinite
attempt to reach an unsupported absolute target.

## Bazzite continuation

Run against the final implementation revision recorded above, with the committed
Sony fixtures and a separately recorded Linux runtime/display/power configuration.
Do not substitute Mac measurements for Linux results. Start with compact reports;
rerun the exact failure before broader selections. Preserve all gates.

```sh
git switch main
git pull --ff-only origin main
# Confirm the tested code after merging the reviewed branch; documentation-only descendants are allowed.
git rev-parse HEAD
git diff --exit-code a739a0ce9f6b3507ec4f5f7dc174d6f41a85a116 HEAD -- . ':(exclude)docs/**' ':(exclude)README.md' ':(exclude)Luma.md'
node scripts/research/sony-fixtures.mjs check
npm run verify -- --target display-rendering-reference --target hdr-render-cache-gpu --target hdr-math-gpu
npm run verify -- --target merge-cpu-kernels --target merge-gpu-output --target brk-merge --target capture-metadata --target merge-engine --target merge-io --target merge-gpu
npm run verify -- --target research-merge-gpu
npm run verify -- --target edit-history --target merge-library --target import-pipeline --target stack-group-actions
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --foreground --target adjustment-engine-raw --target adjustment-renderer-raw-ui --target full-previews-raw --target gpu-preview --target lens-correction-raw --target white-balance-raw --target hdr-content-ui --target hdr-editor-ui
npm run verify -- --foreground --target hdr-slider-benchmark --target hdr-interaction-benchmark
VITE_LUMA_HDR_TILE_BATCH=8 npm run verify -- --foreground --target mac-workability-batching
npm run verify -- --foreground --target mac-workability-batching
VITE_LUMA_HDR_KERNEL=grid8 npm run verify -- --foreground --target mac-workability-batching
npm run verify -- --foreground --target mac-workability-benchmark
node scripts/research/sony-fixtures.mjs noise -- npm run verify -- --foreground --target mac-workability-interference
npm run verify -- --target export-context --target export-rendering --target export-gpu
npm run benchmark:export -- --foreground
node scripts/research/sony-fixtures.mjs noise -- npm run benchmark:merge -- --foreground
npm run verify -- --target merge-three-raw-benchmark
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --target merge-raw
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --foreground --target merge-raw-ui
# Select a saved, same-configuration pre-change baseline, never candidate output.
LUMA_PREVIEW_BASELINE=/absolute/path/to/saved-baseline.json npm run benchmark:preview -- --foreground
```

For the October 17 kernels, create Linux scalar-control evidence at `a06e74c`
in an isolated checkout before measuring the candidate, retaining the three full
samples and preparation manifests for both modes. Supply that saved report via
`LUMA_MERGE_THREE_RAW_BASELINE`. Compare scalar/optional-WASM preparation,
2048/32768 gain-cache entries and one/two output slots with matched diagnostic
settings and source identities. Record three fresh-worker operations per mode;
keep the five-second and 15-second gates separate. Optional GPU timestamps need
an explicit supported/unsupported result and must remain separate from map wait.
Check memory peaks, actual selected backend, cache corruption/fallback,
cancellation/device loss and foreground editing before adopting Linux defaults.
The GPU camera study remains isolated and needs fresh native pixel/mask results;
its resident calculation is not an end-to-end merge measurement.

The acceptance harness separates 60 Hz and 120 Hz configurations and retains
three 240-input trials for all eight sliders at Fit and 100% in each layout.
The pull command assumes the reviewed branch has been merged into `main`; the
revision guard above checks that its implementation still matches the Mac freeze.
A saved Linux preview baseline must come from pre-change production code on the
same configuration. Linux encoding backend availability, real input cadence (60/120 Hz separately),
GPU/CPU/CTL agreement, memory/cancellation, HDR display and background interference
need local results. Physical HDR measurements, larger controlled brackets and a
distinct 32-RAW sequence remain incomplete wherever the equipment/fixtures are
unavailable. A Linux comprehensive checkpoint requires its own agreed checkpoint.
