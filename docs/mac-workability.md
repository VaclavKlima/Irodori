# Mac workability

This milestone improves the current production pipeline on the M4 Pro. Sharp
detail takes priority over presenting every intermediate input. Processing-graph,
native-service and decoder research remain separate. Disabled controls and the
read-only Console retain their existing scope. Mac acceptance remains **failed / incomplete**:
sharp frames and numerical checks pass, but sustained interaction, nine-source
merge and GPU-versus-legacy preview performance still miss existing gates. Cold
export has an intermittent first-launch miss. Hardware and Linux gaps remain open.

Implementation branch: `perf/mac-workability`, based on upstream research revision
`3c5fcb1` (fast-forwarded from `c69c40f`). Production implementation revision:
`cedef59` (pixel-processing source `980435a`). The editor/export acceptance
measurements use `0b4f99f`; later changes affect merge output, library publication
and recovery, canvas configuration, and verification. Verified code and test
handoff revision: `cedef590fdf53c0c558d4a3c10b4fd6abc2368f7`. Subsequent report,
README and testing-guide changes are documentation only. Linux acceptance remains
pending.

## Task register

| Task                   | Owner                              | Dependencies       | Status                                                   | Evidence / remaining work                                                                                                                                                                         |
| ---------------------- | ---------------------------------- | ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Baseline          | Coordinator                        | Upstream research  | Complete                                                 | Upstream integrated; all 15 committed Sony original hashes verified. Unchanged baseline runs in a detached, isolated checkout.                                                                    |
| M1 — Exact rendering   | Rendering agent                    | M0                 | Focused checks passed                                    | CPU/GPU/pinned Float64 CTL agree on Mac; maintained compensated range-reduced math shared across production shaders. Bazzite remains pending.                                                     |
| M2 — Sharp interaction | Rendering agent                    | M1                 | Implemented; performance gates fail                      | Immutable active/latest pending intent, normal-detail interaction and independent bounded histogram work. Measured 32-tile batches retained; sharpness passes, latency/progress miss their gates. |
| M3 — Export            | Export agent                       | M0, shared M1 math | Functional and warm gates passed; cold variance          | Internal validated working-asset leases, frozen preparation reuse across retries; initial cold miss retained alongside passing exact replay.                                                      |
| M4 — Merge             | Merge agent                        | M0                 | Functional checks passed; nine-source performance failed | Stage attribution, bounded verified strip reuse and lossless review-output optimization; final family: 11 passed, one performance failure.                                                        |
| M5 — Enabled workflows | Coordinator, then subsystem agents | M1–M4              | Mac software repairs verified; hardware gaps deferred    | Import/device adapters, library/selection/groups/Trash/recovery, adjustments/history/MCP, export and merge; physical/private-fixture gaps remain explicit.                                        |
| M6 — Integration       | Coordinator                        | M1–M5              | Execution complete; acceptance failed / incomplete       | One agreed full checkpoint completed; exact failures replayed, focused repairs verified and final Bazzite handoff recorded below.                                                                 |

## Machine and baseline

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
  use compression level 1, validated byte-exact after decoding against prior PNGs
  and raw pixels; durable masters and checksums retain their existing policy.
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

| Enabled area                                                            | Mac software result                                                               | Additional limits                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| File/folder import, review, duplicates, background tasks                | Full/focused import, review, duplicate and task checks passed; picker bug fixed   | Native picker and macOS permission dialogs are injected in automation.                                    |
| Device discovery, missing-photo recognition, disconnection              | Adapter/service/UI checks passed; private capture cases deferred                  | Real card mounting/unplugging and TCC access are unverified; diskutil/plutil facts are fixture-backed.    |
| Library search, scrolling, selection, ranges and groups                 | Full and focused browsing/group checks passed                                     | Automated profiles contain fixture libraries only.                                                        |
| Confirmed Trash and recovery/restart                                    | Full and focused journal/transaction/recovery checks passed                       | Isolated Trash adapters; real Finder/OS Trash restoration is unverified.                                  |
| Eight enabled sliders, lens toggles, comparison, overlays and Undo/Redo | Shared inputs/history/MCP passed; sharp trials functional, performance failed     | Other editing controls stay disabled.                                                                     |
| Zoom/pan, cached navigation, CPU fallback, device loss                  | RAW/GPU/CPU fallback and display lifecycle passed; sustained performance failed   | Physical scanout/luminance is unmeasured.                                                                 |
| Typed MCP revisions, statistics, pixels, export and isolated import     | Full and focused protocol checks passed                                           | A specific external client connection is not certified.                                                   |
| Individual/batch SDR/HDR JPEG export, retry/cancel/publication          | Functional and warm-source checks passed; cold first-launch gate remains variable | External reader interoperability and physical HDR display are separate.                                   |
| Merge review, alignment, publication, restart, source deletion          | Sony review/publication/restart/source deletion passed; nine-source timing failed | Missing private BRK sets, larger controlled HDR brackets and distinct 32-RAW sequences remain incomplete. |

## Bazzite continuation

Run against the final implementation revision recorded above, with the committed
Sony fixtures and a separately recorded Linux runtime/display/power configuration.
Do not substitute Mac measurements for Linux results. Start with compact reports;
rerun the exact failure before broader selections. Preserve all gates.

```sh
git switch perf/mac-workability
git pull --ff-only origin perf/mac-workability
# Confirm the tested code after transferring the reviewed branch; documentation-only descendants are allowed.
git rev-parse HEAD
git diff --exit-code cedef590fdf53c0c558d4a3c10b4fd6abc2368f7 HEAD -- . ':(exclude)docs/**' ':(exclude)README.md' ':(exclude)Luma.md'
node scripts/research/sony-fixtures.mjs check
npm run verify -- --target display-rendering-reference --target hdr-render-cache-gpu --target hdr-math-gpu
npm run verify -- --target edit-history --target merge-library --target import-pipeline --target stack-group-actions
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --foreground --target adjustment-engine-raw --target adjustment-renderer-raw-ui --target full-previews-raw --target gpu-preview --target lens-correction-raw --target white-balance-raw --target hdr-content-ui --target hdr-editor-ui
npm run verify -- --foreground --target hdr-slider-benchmark --target hdr-interaction-benchmark
VITE_LUMA_HDR_TILE_BATCH=8 npm run verify -- --foreground --target mac-workability-batching
npm run verify -- --foreground --target mac-workability-batching
npm run verify -- --foreground --target mac-workability-benchmark
node scripts/research/sony-fixtures.mjs noise -- npm run verify -- --foreground --target mac-workability-interference
npm run verify -- --target export-context --target export-rendering --target export-gpu
npm run benchmark:export -- --foreground
node scripts/research/sony-fixtures.mjs noise -- npm run benchmark:merge -- --foreground
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --target merge-raw
node scripts/research/sony-fixtures.mjs hdr -- npm run verify -- --foreground --target merge-raw-ui
# Select a saved, same-configuration pre-change baseline, never candidate output.
LUMA_PREVIEW_BASELINE=/absolute/path/to/saved-baseline.json npm run benchmark:preview -- --foreground
```

The acceptance harness separates 60 Hz and 120 Hz configurations and retains
three 240-input trials for all eight sliders at Fit and 100% in each layout.
Transfer/publish the reviewed branch before using the pull command; these commits
are currently local. A saved Linux preview baseline must come from pre-change
production code on the same configuration. Linux encoding backend availability, real input cadence (60/120 Hz separately),
GPU/CPU/CTL agreement, memory/cancellation, HDR display and background interference
need local results. Physical HDR measurements, larger controlled brackets and a
distinct 32-RAW sequence remain incomplete wherever the equipment/fixtures are
unavailable. A Linux comprehensive checkpoint requires its own agreed checkpoint.
