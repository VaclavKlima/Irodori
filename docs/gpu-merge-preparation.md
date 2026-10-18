# GPU merge preparation on Mac

Status: **Mac numerical and recovery cohorts pass; competitive acceptance fails.
Both GPU selectors remain opt-in and are rejected as defaults.**
This pass runs on `perf/gpu-merge-preparation`, following production merge
`d39ecb391e237565efaf11b065bb9c0c68914e9d`. It preserves the historical CPU evidence and records a new opt-in implementation
freeze below; it claims no Linux results.

The three-Sony-RAW visible target remains median ≤10 seconds and every operation
≤12 seconds. At the final implementation freeze, the five ordinary GPU-reference
workflows measure **16.3872 seconds median and 16.5651 seconds maximum**; the
separate restart is **16.8395 seconds**, the slowest of all six operations.
The 15-second visible checkpoint, separate five-second service stretch and
33 ms interaction gates remain unmet. This bounded Mac pass is complete with
measured misses; the tested revision is prepared for Bazzite verification.
Service completion and visible presentation are separate clocks. No Linux result
or new GPU production default is claimed.

## Scope and ownership

| Work                                                                        | Owner                                     | Dependency                                                | State                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| Policies, recipes, cache proof, integration and verification runs           | Coordinator                               | Frozen CPU implementation                                 | Focused and complete native cohorts pass                                |
| Exact validity, geometry planning and maintained WASM                       | CPU preparation agent; coordinator builds | Existing decoder/lens/clipping arithmetic                 | ABI 5 and exact recovery verified                                       |
| Streaming camera projection and reference conversion                        | GPU preparation agent                     | Canonical CPU geometry/masks and bounded device ownership | Native quality passes; both default-adoption proposals rejected         |
| Independent numerical/lifecycle and complete-operation tests                | Validation and CPU agents                 | Candidate APIs                                            | Synthetic, complete recovery and actual device-loss cases pass          |
| Performance adoption, visible workflow, revision freeze and Bazzite handoff | Coordinator                               | Complete quality and recovery proof                       | Bounded Mac pass complete; target miss retained; Bazzite handoff frozen |

The decoder, source geometry, independent native registration checks, exposure
validation, crop, clipping policy, Float32 masters, originals and durable
publication stay intact. No public application or MCP operation is added. Old
recipes retain their recorded arithmetic; new policies have separate preparation
and registration identities. Diagnostics distinguish requested policy from actual
backend and record bounded component timings and resource counters.

## Camera evidence candidate

`LUMA_MERGE_CAMERA_PREPARATION=gpu` requests `gpu-camera-v2-exact` for new verified
HDR work. An unset selector or `cpu` keeps the ordinary writer. Existing recipes
without a policy remain CPU recipes even when the selector requests GPU.

The writer streams existing immutable working RGB in canonical 64-row strips.
A bounded CPU provider supplies exact channel validity without projecting RGB.
GPU projection uses split coefficients and compensated arithmetic. Conservative
rounding/threshold guards repair uncertain channels using the original ordered
Float64 expression and Float32 store. Native validation requires every camera and
reduced-plane Float32 word to match the frozen CPU reference, plus exact masks,
registration, motion and crop. Final linear output retains the existing tolerance
`2e-6 + 2e-5 × abs(reference)` and exact alpha.

Compensated GPU arithmetic requires native validation on each backend; WGSL FMA
accuracy alone does not prove portable exactness. Camera buffers own
`160 + 48 × capacity + 4 × ceil(capacity / 4)` logical bytes, where
`capacity = width × min(64, height)`. RAW preparation reserves those bytes before
admission. A failed camera writer drains work and removes partial evidence before
complete CPU replay from checksummed working strips. Cancellation stays cancelled.

### Rejected first camera candidate

The earlier `gpu-camera-v1` Float32 projection passed synthetic tolerances but
changed the real bracket's motion mask. An exact replay reproduced the failure.
The three matched service pairs retained these uninterrupted completion times:

| Pair | CPU seconds | GPU v1 seconds |
| ---- | ----------: | -------------: |
| 1    |      20.076 |         19.857 |
| 2    |      15.389 |         16.785 |
| 3    |      15.518 |         17.067 |

CPU median was 15.518 seconds; GPU median was 17.067 seconds. All six operations
completed durable publication and cleanup, but quality failed and two of three
GPU operations were slower. This candidate was rejected and never became default.
The frozen CPU reference was retained. Evidence:
[first report](../artifacts/verification/2026-10-18T15-19-29.290Z-check-Q7IVQU/summary.md),
[exact replay](../artifacts/verification/playwright-1792336955590-4a2ed0d5-17a4-4876-a3d4-27b93f54cdf4/playwright/summary.json).

The first v2 diagnostic matched all native/reduced camera words and the complete
master, motion mask, crop and registration geometry. The test failed only because
normalized registration also compared new policy-specific cache-proof metadata
against its deliberately absent CPU field. Complete CPU/GPU times were 16.802
and 17.453 seconds. This one pair cannot establish performance or acceptance.
[Diagnostic evidence](../artifacts/verification/playwright-1792338507471-ce9b1f5b-bf1e-4ca5-b618-f778807534e7/playwright/summary.json).
The second diagnostic retained 16.038/17.703-second CPU/GPU operations and the same
policy-specific proof-metadata assertion failure; it was not counted as a pass.
[Second retained diagnostic](../artifacts/verification/playwright-1792338591993-1a0edd69-a6ec-438d-84ac-c37dc519bb21/playwright/summary.json).

## Reference fallback candidate

`LUMA_MERGE_REFERENCE_PREPARATION=gpu` requests `gpu-reference-fallback-v2-compensated` for
new verified HDR work. The fallback supplies pixels for irrecoverably clipped
reference regions and does not supply alignment/fusion evidence. The existing
LibRaw linear decode and highlight blend remain unchanged.

A bounded CPU planner computes canonical per-channel interpolation coordinates
and union-clipping alpha. GPU work samples the unchanged blended frame, applies
vignette gain, reference white balance and the original two color matrices.
Readback retains compensated RGB and a luminance error enclosure. Selected
uncertain samples use canonical CPU point recovery. Luminance is formed before
Float32 RGB storage, preserving the strict read-noise mask decision. The exact
ordered area reducer remains shared with CPU preparation.

Source upload is split into fenced, padded texture-array layers. Individual
upload staging is at most 8 MiB. Resource preflight counts source padding,
upload, geometry, result, readback, LUT and uniforms. The existing 1 GiB logical
GPU, 128 MiB aggregate preparation arena and 512 MiB measured merge/alignment
WASM limits remain unchanged. Logical counters do not establish physical VRAM.
Failed conversion drains owned resources before complete replay of the same
already blended frame through CPU conversion.

The first fallback candidate passed native quality but completed in 20.008 seconds
against 17.314 seconds for CPU. Its conservative Float32 vignette bound repaired
16,937,214 pixels (84%); verification alone took 3.854 seconds. It remains a
rejected performance experiment.
[Evidence](../artifacts/verification/playwright-1792338754433-039fe231-a7a6-4a3c-ab34-4b995c422ec8/playwright/summary.json).

The compensated candidate retains split radius, square-root correction and LUT
interpolation. Its first native pair required zero scalar repairs and matched the
reduced fallback, final master, motion mask and crop exactly. Maximum native
fallback error was 9.32e-10, within tolerance. Complete CPU/GPU times were
16.101/16.566 seconds, so this pair establishes no application gain. The GPU
conversion owns 364,081,456 logical bytes; complete operation peaks remain below
1 GiB logical GPU and 512 MiB measured aggregate WASM.
[Evidence](../artifacts/verification/playwright-1792339234209-265f02c0-39b0-4ac7-8fbc-ae40ccb612c3/playwright/summary.json).

The final candidate overlaps next-strip CPU geometry with already submitted GPU
work. It retains one fixed current-alpha copy and one borrowed next-strip
descriptor; only matching, full sequential 64-row requests reuse the prefetch.
The provider's reducer storage is separate. Cancellation and close still drain
the current operation before releasing the provider. `geometryMs` counts CPU
planning; `readbackMs` counts the remaining exposed wait and copy after planning.
Those component categories do not count the same wall time twice. This scheduling
change retains the v2 pixel policy and adds no GPU allocation or full native plane.

## Final three-pair service cohorts

Each stage has three interleaved, fresh CPU-control/GPU-candidate operations using
the committed Sony bracket. Camera and reference stages are separate experiments;
the other preparation policy stays CPU. Every sample includes RAW decode, native
registration/validation, full output, immediate acceptance, durable publication,
cleanup and bounded snapshot staging. Import and metadata setup are excluded.
Independent full-file quality comparisons run after the uninterrupted operation
clock and retain their separate `qualityAfterClockMs`; production GPU readback
verification and registration validation remain inside the operation clock.

| Stage                      | Pair | CPU seconds | GPU seconds |
| -------------------------- | ---: | ----------: | ----------: |
| Camera v2                  |    1 |     16.2308 |     17.5616 |
| Camera v2                  |    2 |     16.0386 |     17.5611 |
| Camera v2                  |    3 |     15.7124 |     18.0717 |
| Reference v2 with prefetch |    1 |     17.1516 |     21.6236 |
| Reference v2 with prefetch |    2 |     17.2100 |     17.1206 |
| Reference v2 with prefetch |    3 |     18.1450 |     16.1948 |

Camera control/candidate medians are **16.0386/17.5616 seconds**, with maxima
**16.2308/18.0717 seconds**. All three GPU operations are slower; median regression
is 9.50%. Every native/reduced camera Float32 word, working source, fallback,
final master, motion mask, crop and registration matches the frozen CPU reference.
The 11,515,552-byte camera allocation and exact rounding repair are valid, but this
matrix-only offload is rejected as a default for measured performance.
[Camera cohort](../artifacts/verification/playwright-1792341379023-a9303446-a1e5-43dc-8564-2fbb06caf7b2/playwright/results/merge-gpu-preparation-nati-ed424-quality-through-publication-raw-gpu/merge-gpu-preparation-native.json).

Reference control/candidate medians are **17.2100/17.1206 seconds**, with maxima
**18.1450/21.6236 seconds**. The 0.52% median difference does not establish a
repeatable complete-operation gain, and the retained 21.6236-second candidate
tail fails the no-tail-regression requirement. Its fallback writing alone took
1.301 seconds, versus 0.106/0.181 seconds in the later candidate samples; no time
is subtracted or attributed as the cause of the entire operation difference.
Each candidate uses 84 prefetched strips out of 86 batches, zero discarded
prefetches and zero scalar repairs. The fallback differs in one Float32 word by
9.3133e-10; reduced fallback, final master, motion mask, crop and registration
match exactly. This path also remains opt-in and rejected as a default.
[Reference cohort](../artifacts/verification/playwright-1792341030511-b10f4791-bc74-4cad-8b35-0548815c5ccf/playwright/results/merge-gpu-preparation-nati-ed424-quality-through-publication-raw-gpu/merge-gpu-preparation-native.json).

Across both complete cohorts the maximum logical GPU ownership is **932,630,072
bytes**, aggregate merge/alignment WASM is **145,358,848 bytes**, and observed
worker RSS is at most **2,225,274,880 bytes**. The reference converter separately
owns **364,081,456 logical GPU bytes**. The configured 1 GiB GPU, 128 MiB aggregate
preparation-arena and 512 MiB measured aggregate WASM limits remain unchanged.
Counters include admitted attempts that later recover on CPU; they do not measure
physical VRAM. A later budget audit found an additional RAW reduced-map staging
allocation, about 8 MiB, missing from the conservative estimate. The implemented
correction budgets the larger of full reduced readback and 256-row image staging,
plus the retained 272-byte base uniform. Existing reservation coverage now checks
one-byte-over-budget rejection before admission, exact-limit admission and
unchanged successful native pixels. Both targeted RAW GPU regressions pass in
5.40 seconds, including exact-limit admission and sticky failure state; the
correction changes accounting, not allocations or pixels. The values above are
the recorded pre-correction counters.
Both cohorts record `d8e3e95` with a dirty working tree and exact source/build
hashes, not a final frozen handoff revision. All managed originals retain their
hashes and every operation completes publication and cleanup.

## Maintained CPU kernel

ABI/manifest **5** adds validity-only and fallback-geometry entry points. Two
pinned Emscripten **4.0.20** builds reproduced **12077 bytes**, SHA-256
`53064a44d404c49cf01851e22bc7e96efa56c37277bbc3036ef5a922ac5d6879`.
Maintained C source SHA-256:
`cdc92aec5079f6e5ec305b6de31092bf759d898a9bea7143a418fa99c849a329`.

Rebuild with
`LUMA_EMCC=/path/to/emsdk-4.0.20/upstream/emscripten/emcc npm run build:merge-kernels`.
The [manifest](../vendor/merge-kernels/manifest.json) records compiler and flags.
Float64 weights, contribution order and fallback Float32 update rounding remain
unchanged. Streaming reductions retain at most two active output rows. Optional
allocation or kernel failures restore state before scalar replay. Missing or
corrupt optional kernels preserve scalar recovery.

## Verification record

The v1/ABI4 focused selection passed 353 cases in 46.63 seconds before the native
quality rejection. [Evidence](../artifacts/verification/2026-10-18T15-07-30.891Z-check-o7P8g8/summary.md).

The revised v2/ABI5 selection (`merge-cpu-kernels`, `merge-engine`,
`merge-gpu-preparation`, `merge-gpu-reference`) passed 396 cases and failed one
test-only oversized fixture in 50.15 seconds. The fixture incorrectly swapped
the oversized dimension through orientation. Its corrected exact replay passes.
[Retained failure](../artifacts/verification/2026-10-18T15-45-14.792Z-check-ph4H9j/summary.md).

After fixing fresh-job reference-policy gating, `merge-engine` and
`merge-gpu-reference`, including cheap checks, pass **364 cases, zero failed or
skipped, in 37.09 seconds**.
[Evidence](../artifacts/verification/2026-10-18T15-46-51.857Z-check-BfTpg6/summary.md).

Coverage includes eight orientations, fractional geometry, clipping footprints,
threshold-adjacent values, signed/cancellation-sensitive matrices, fourth-CFA
normalization extrema, partial strips, exact reductions, allocation pressure,
scalar planning, corrupt readback, device loss, cancellation and drained cleanup.
Source-level camera recovery uses a real HDR source. These focused checks alone
do not establish complete publication, legacy RAW replay, native full-output or
performance acceptance; the separate complete cohorts are recorded here.

After the cache and teardown fixes and compensated gain update, the focused
`merge-engine`, `merge-gpu-preparation`, `merge-gpu-reference` selection passes
**401 cases, zero failed/skipped, in 48.63 seconds**, including type checking,
lint, formatting and production build.
[Evidence](../artifacts/verification/2026-10-18T15-59-30.645Z-check-iWYmQv/summary.md).
Three new cache-test assertions initially compared persisted checksum metadata
with an in-memory plane. Their corrected exact pixel/mask comparisons pass all
three exact reruns; policy admission and corruption checks remain intact.

Six complete RAW lifecycle cases pass **6/6, zero failed/skipped, in 228.59
seconds**: camera and reference CPU recovery after a late GPU readback failure,
fresh legacy recipe replay while selectors request GPU, both policy cache
hit/miss/corruption paths, and cancellation after the completed fallback file's
drained GPU close. Recovery compares complete native evidence and final master
exactly, then verifies publication, journal/catalog cleanup and original hashes.
[Evidence](../artifacts/verification/playwright-1792339371689-e035553d-5906-4029-8e20-46be5a5673c9/playwright/summary.json).
Actual shared-device loss was then exercised separately, as recorded below.

After geometry prefetch and metrics-observer coverage, the
`merge-engine`, `merge-gpu`, `merge-gpu-preparation`, `merge-gpu-reference` selection
passes **405 cases, zero failed/skipped, in 85.05 seconds**. The existing tiled GPU
case takes 23.77 seconds; the routine budget warning is retained. A later
`merge-engine`, `merge-gpu-preparation`, `merge-gpu-reference` selection passes
**402 cases, zero failed/skipped, in 48.97 seconds**. Both include type checking,
lint, formatting and production builds. These overlapping selections are not
additive, and no comprehensive checkpoint was requested or repeated.
[405-case evidence](../artifacts/verification/2026-10-18T16-12-48.687Z-check-gmyLMk/summary.md),
[402-case evidence](../artifacts/verification/2026-10-18T16-17-05.594Z-check-uWdPNT/summary.md).

### Actual shared-device loss

The real cached Dawn device is destroyed after one successful converter strip;
the next map rejects. The first camera case exposed a worker-lifecycle defect:
an empty Dawn `OperationError.message` replaced the device-loss reason, and a
truthiness guard allowed a fresh GPU device. The first source recovered on CPU
while later sources used GPU. The resulting exact-control comparison failed,
including 256 motion-mask pixels and a 0.028574 maximum master difference. That
failed camera case remains retained; the separate reference device-loss case
passed in the same two-case invocation.
[Retained two-case result](../artifacts/verification/playwright-1792340302150-ce26a8c6-d1cb-4533-bbb0-2b977647d15e/playwright/summary.json).

The renderer now tests the unavailable state explicitly, preserves its first
nonempty failure and gives empty errors a nonempty fallback reason. Later GPU
requests stay disabled for that worker. The exact camera replay passes in
**184.09 seconds** with complete CPU preparation, matching camera/fallback/master
words, motion and crop, durable publication, journal/catalog cleanup and original
hashes. Together with the retained passing reference case, both actual-loss
paths have complete recovery evidence. These are lifecycle checks, not speed
samples. Three targeted production regressions also pass in **10.93 seconds**:
empty-map failure stays disabled without repeated initialization, all sensor
orientations retain clipping, and independent LibRaw preparation/recovery agrees.
[Camera recovery replay](../artifacts/verification/playwright-1792340700641-7c17a83b-4d74-4565-a722-6a7103860ba5/playwright/summary.json),
[three production regressions](../artifacts/verification/playwright-1792340966560-7a7b72d6-1097-487d-8001-55c4907e0c89/playwright/summary.json).

Camera and reference metrics observers retain logical ownership even when a
constructor fails after admission. Observer errors cannot interrupt cleanup.
Device-loss observers detach on close so the shared device cannot retain closed
writers' RAW inputs or provider arenas. Partial evidence is removed before CPU
replay, and cancellation remains cancellation through drained close.

The final source integration also checks cancellation after its owned source
file closes. Cancellation after CPU recovery removes the newly owned outputs
before propagating. These final-close transaction fixes are implemented; their
the final affected checks pass as recorded below.

The native suite accepts `LUMA_MERGE_GPU_PREPARATION_STAGE=camera|reference|both`.
Three fresh interleaved CPU/GPU pairs are required for complete native evidence.
`LUMA_MERGE_GPU_PREPARATION_PAIRS=1` is diagnostic only. Native snapshots and
all samples remain outside Git, with snapshot work retained inside the operation
clock. Import, application startup and human review are excluded. Electron's
actual review draw/post-paint and final sharp presentation remain separate
foreground workflow measurements.

## Pre-handoff visible workflow

These measurements precede the source-preview handoff optimization currently in
progress. The CPU-policy control has only three ordinary runs and no restart;
it is a diagnostic control, not the required five-run acceptance cohort. The
reference-GPU opt-in series has five fresh ordinary operations and a separate
application-restart control. Camera preparation stays CPU in both series.

| Series                                      | Ordinary complete-operation seconds             |  Median | Maximum | Separate restart |
| ------------------------------------------- | ----------------------------------------------- | ------: | ------: | ---------------: |
| CPU camera/reference policies, diagnostic 3 | 20.9922 / 20.9833 / 20.4985                     | 20.9833 | 20.9922 |     Not measured |
| CPU camera / GPU reference v2, ordinary 5   | 19.5764 / 19.7961 / 19.1384 / 17.0594 / 16.8064 | 19.1384 | 19.7961 |          16.9682 |

Every operation uses the isolated committed bracket, fresh preparation, decoded
native review, an actual Canvas2D review draw and post-paint observation, immediate
acceptance, publication/cleanup observation and a sharp normal-detail WebGPU HDR
editor frame. Import, startup and human review stay outside the uninterrupted
renderer clock. All measured operations exceed 12 seconds; the ordinary median,
maximum and separate restart fail the unchanged gates. The 15-second visible
checkpoint also fails. The last two faster ordinary samples and the earlier slower
samples are all retained; neither the series ordering nor uncontrolled OS/driver
caches establishes a causal GPU saving.

| Operation             | Native review seconds | Observed publication + cleanup seconds | Final editor seconds | Complete seconds |
| --------------------- | --------------------: | -------------------------------------: | -------------------: | ---------------: |
| CPU 1                 |               16.3330 |                                 4.0338 |               0.6253 |          20.9922 |
| CPU 2                 |               16.3324 |                                 3.8176 |               0.8332 |          20.9833 |
| CPU 3                 |               15.9561 |                                 3.8846 |               0.6578 |          20.4985 |
| GPU reference 1       |               15.4002 |                                 3.6011 |               0.5751 |          19.5764 |
| GPU reference 2       |               15.4880 |                                 3.6830 |               0.6250 |          19.7961 |
| GPU reference 3       |               14.9978 |                                 3.5501 |               0.5904 |          19.1384 |
| GPU reference 4       |               14.4840 |                                 1.9007 |               0.6747 |          17.0594 |
| GPU reference 5       |               14.3387 |                                 1.7768 |               0.6909 |          16.8064 |
| GPU reference restart |               14.4510 |                                 1.9503 |               0.5668 |          16.9682 |

Review draw-to-post-paint observations are 1.1–6.6 ms and are already inside the
review boundary. Main-process publication records separate scheduler admission:
2.463–2.583 seconds for the CPU control, 2.053–2.337 seconds for the first three
GPU-reference operations, 0.679–0.876 seconds for the last two and 0.994 seconds
after restart. These main-clock and renderer-clock spans must not be added to
each other. This exposed handoff/admission work is the subject of the pending
source-preview optimization; no post-change result is claimed here.

The UI reports contain stale helper text saying production modules are unchanged.
They actually exercise the built candidate; the recorded `out/main/index.js`,
merge-worker and test source hashes remain the evidence for what ran. The helper
label has been corrected for subsequent runs.

[CPU three-run evidence](../artifacts/verification/playwright-1792341590886-374fd5e1-13d9-4c3f-b596-9164e746c865/playwright/results/merge-workflow-benchmark-f-d516b-e-RAW-HDR-visible-workflows-benchmark/merge-workflow.json),
[GPU five-run evidence](../artifacts/verification/playwright-1792341871022-6e7b0d35-dca3-422c-8a3d-6aa54d405a74/playwright/results/merge-workflow-benchmark-f-d516b-e-RAW-HDR-visible-workflows-benchmark/merge-workflow.json),
[GPU restart evidence](../artifacts/verification/playwright-1792341871022-6e7b0d35-dca3-422c-8a3d-6aa54d405a74/playwright/results/merge-workflow-benchmark-t-99bc0-w-after-application-restart-benchmark/merge-workflow.json).

## Distinct-source regression control

The separate foreground noise control passes **four tests and twelve fresh
operations, zero failed/skipped, in 129.70 seconds**. These use ordinary CPU
camera/reference policies and preserve the existing 15-second durable-publication
gate. They do not substitute for the HDR visible target or editing interference.

| Distinct Sony sources | All complete-operation seconds | Maximum seconds |
| --------------------- | ------------------------------ | --------------: |
| 2                     | 7.014 / 7.028 / 6.971          |           7.028 |
| 3                     | 7.774 / 7.724 / 7.816          |           7.816 |
| 5                     | 10.016 / 10.191 / 9.883        |          10.191 |
| 9                     | 13.497 / 13.141 / 13.267       |          13.497 |

All fifteen committed fixture hashes match before and after the invocation.
[Noise regression evidence](../artifacts/verification/playwright-1792342186875-95a35b70-e41b-4484-b5a4-5d95fd87ec32/playwright/summary.json),
[fixture integrity](../artifacts/fixture-integrity/2026-10-18T16-49-46.130Z-3868.json).

## Foreground editing interference

The foreground interference invocation completed **two tests in 256.039206
seconds, both failed only the unchanged 33 ms latency/histogram gates, zero
skipped**. All twelve merge tasks completed: the nine-source noise stack and
three-source HDR bracket each have three matched idle/editing pairs. Every editor
trial dispatches the existing 240 Exposure inputs at actual 60 Hz, in the
1100 × 700 workspace with Console open.

| Workload            | Input-to-presentation P95 ms | Histogram P95 ms | Final refinement ms |
| ------------------- | ---------------------------: | ---------------: | ------------------: |
| Noise, nine sources |                    42.0–42.6 |        50.8–51.2 |           32.4–41.0 |
| HDR, three sources  |                    41.9–42.5 |        42.8–51.3 |           32.2–41.3 |

All other functional, source, backend and resource assertions pass. Each trial
has at least 160 sharp presentations and 160 histogram updates during input;
final refinement stays below 500 ms. No source changes, operation errors,
task errors or cleanup failures occur. The HDR fixture and managed-original
hashes match before and after the six HDR operations.

The HDR case starts the operation first and delays editor input by 6000 ms to
exercise later reference fallback. Recorded input/operation overlap is
3976–3983 ms. Camera preparation stays CPU; all six HDR diagnostics and completed
tasks confirm actual GPU reference preparation with no CPU fallback. The original
noise editor-first ordering and merge auto-open exception remain unchanged.
Overlap includes the dispatched operation and scheduler waits; it does not claim
simultaneous kernel execution. All recorded logical GPU and aggregate WASM peaks
remain below 1 GiB and 512 MiB, respectively, using the pre-correction counters.

The 33 ms gates remain unmet for both idle and editing trials. No cadence,
presentation-count or latency threshold is relaxed, and these results do not
establish foreground editing acceptance.
[Interference result](../artifacts/verification/playwright-1792342350972-a5f92ad1-310b-437c-ba46-d8b071d46636/playwright/summary.json),
[noise measurements](../artifacts/verification/playwright-1792342350972-a5f92ad1-310b-437c-ba46-d8b071d46636/playwright/results/mac-workability-interferen-7ce62--60Hz-1100x700-with-Console-benchmark/interference.json),
[HDR measurements](../artifacts/verification/playwright-1792342350972-a5f92ad1-310b-437c-ba46-d8b071d46636/playwright/results/mac-workability-interferen-be510--60Hz-1100x700-with-Console-benchmark/interference.json).

## Final visible workflow and remaining miss

The same uninterrupted foreground harness ran at the frozen implementation,
with actual native image decode, review draw and post-paint, immediate acceptance,
awaited publication/cleanup and normal sharp editor presentation. All five GPU
operations and the separate restart explicitly require the versioned reference
policy and actual GPU backend without CPU recovery. Full master verification,
managed/fixture hashes and empty review/publication staging pass. Only competitive
timing assertions fail; no sample or slowest operation is omitted.

| Final series                              | Every ordinary operation, seconds               | Ordinary median | Ordinary maximum | Separate restart |
| ----------------------------------------- | ----------------------------------------------- | --------------: | ---------------: | ---------------: |
| CPU camera/reference, diagnostic three    | 17.6676 / 17.1853 / 17.2382                     |         17.2382 |          17.6676 |     Not measured |
| CPU camera / GPU reference, required five | 16.3872 / 16.3524 / 16.5651 / 16.4283 / 16.3234 |         16.3872 |          16.5651 |          16.8395 |

The CPU control takes **63.60 seconds** for its one benchmark case and is not a
five-run acceptance cohort. The GPU five-plus-restart invocation takes **119.89
seconds**, with two expected timing failures and zero skipped cases. The visible
five-run reference median improves by 0.8510 seconds against the adjacent final
CPU diagnostic median. This does not erase the earlier three-pair service cohort's
21.6236-second tail or establish a default-adoption pass across cohorts.
[Final CPU control](../artifacts/verification/playwright-1792343044973-833a5580-91c9-4aca-802f-4e57d18b9ea4/playwright/summary.json),
[final GPU five plus restart](../artifacts/verification/playwright-1792343125082-90a65661-aeaa-4ca5-8abe-9f0bece01d9a/playwright/summary.json).

| Final GPU operation | Native review, seconds | Publication + cleanup observed, seconds | Editor presentation, seconds | Main operation admission, seconds |
| ------------------- | ---------------------: | --------------------------------------: | ---------------------------: | --------------------------------: |
| Ordinary 1          |                14.5277 |                                  1.2344 |                       0.6250 |                            0.1540 |
| Ordinary 2          |                14.4346 |                                  1.2516 |                       0.6661 |                            0.1541 |
| Ordinary 3          |                14.5712 |                                  1.2860 |                       0.7078 |                            0.1538 |
| Ordinary 4          |                14.4855 |                                  1.2677 |                       0.6750 |                            0.1548 |
| Ordinary 5          |                14.2803 |                                  1.3024 |                       0.7407 |                            0.1566 |
| Restart             |                14.6799 |                                  1.5759 |                       0.5837 |                            0.1532 |

The source handoff is adopted: all three CPU controls improve from the earlier
20.4985–20.9922 seconds to 17.1853–17.6676 seconds, and their independently measured
main admission falls from roughly 2.5 seconds to 0.1561–0.1599 seconds. The GPU
ordinary samples also reduce admission to 0.1538–0.1566 seconds. Native preparation
and filesystem timing vary between cohorts, so the complete gain is not attributed
solely to the queue reduction. The main admission column is nested in observed
publication; it must not be added to renderer elapsed time. Review, main and worker
clock origins remain distinct.

Durable publication remains unchanged. For ordinary GPU operation 1, source plus
destination hashing take 233.80 and 222.77 ms; pixel checks 56.23 and 47.32 ms;
copying 178.01 ms; file sync 16.63 ms; directory sync 12.36 ms; journal 0.66 ms;
catalog commit 2.04 ms; cleanup 237.14 ms. The restart retains its 313.32 ms file
sync instead of subtracting it. These are attributed main-process components,
not additional time on top of the uninterrupted workflow clock.

Final corrected-budget GPU cohorts retain peaks of **932,630,072 logical GPU
bytes**, **145,358,848 aggregate merge/alignment WASM bytes**, and at most
**2,187,608,064 worker RSS bytes**. The conservative accounting correction changes
admission for reduced-readback-dominated phases; another phase still determines
this bracket's overall logical GPU maximum. Logical counters do not measure VRAM.
The preparation arena and configured resource caps remain unchanged.

The representative median GPU operation exposes these worker-clock spans;
parallel alignment and nested native validation are excluded from the serial sum:

| Exposed worker span                  | Duration, seconds |
| ------------------------------------ | ----------------: |
| All three source preparations        |             4.778 |
| Reference fallback                   |             3.581 |
| Remaining registration/exposure tail |             0.128 |
| Coverage                             |             0.229 |
| Transition gap                       |             0.054 |
| Accumulation                         |             1.697 |
| Output                               |             3.220 |

The worker ends at 13.7254 seconds, while native review is observed at 14.5277
seconds on the separate renderer clock. The two alignment attempts already overlap
preparation/fallback; final alignment completes at about 6.569 worker seconds.
Making the entire fallback instantaneous would expose that alignment, so its
same-schedule maximum saving is about 1.829 seconds, still leaving roughly
14.558 seconds visible. This is a counterfactual ceiling on this recorded
schedule, not a hardware lower bound. Reference decode (1.467 seconds), geometry
(1.114 seconds), conversion-call total (1.592 seconds), verification (0.287 seconds)
and source upload (0.243 seconds) are nested/overlapping fallback diagnostics and
must not be added as separate stages. Output readback counters overlap the two
slots and are not kernel time; device timestamps were disabled.

The native review alone remains 14.28–14.68 seconds in this final GPU cohort,
before about 1.23–1.58 seconds publication/cleanup and 0.58–0.74 seconds final
editor presentation. Eliminating the remaining approximately 0.15-second
admission cannot achieve the target. Continue with the existing Bazzite checklist
and the same full-path proof before choosing further processing work or defaults.

## Implementation revision

The implementation is frozen at
[`0a70599669c884fc70d2e2afe5f9a6527df44dbb`](https://github.com/VaclavKlima/Luma/commit/0a70599669c884fc70d2e2afe5f9a6527df44dbb)
on `perf/gpu-merge-preparation`. Documentation-only descendants may record the
final measurements; they must not change this implementation guard.

| Commit    | Owner and dependency                                  | Result                                                                                                                                        |
| --------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `d8e3e95` | CPU agent; coordinator kernel build                   | Exact bounded geometry/validity providers, ABI 5 and matching manifest/binary                                                                 |
| `3c31505` | GPU/validation agents; coordinator integration        | Versioned opt-in camera/reference GPU paths, cache isolation, full CPU recovery, resource admission and independent native/lifecycle coverage |
| `0a70599` | Publication inspection agent; coordinator integration | Accepted-task preview suspension, user-intent cancellation of automatic opening and held-lookup lifecycle coverage                            |

Both GPU selectors stay opt-in. The prior production merge is `d39ecb3`; this
experimental branch is prepared for review and Bazzite verification and does not
claim a new production default. Generated binary snapshots, diagnostic contact
sheets, logs and benchmark reports remain outside Git.

## Final implementation checks and handoff behavior

The final affected selection retained **348 passes and one test assertion failure
in 78.05 seconds**. Type/lint/format/build, CPU kernels, engine, I/O and library
stages passed; the runner correctly deferred the GPU stage after the UI failure.
The navigation assertion had counted legitimate source-preview requests made
before terminal task completion. Its corrected observation boundary passes the
exact rerun in 3.74 seconds. The complete `merge-ui` selection subsequently passes
**318 cases, zero failures/skips, in 51.95 seconds**, including all eight UI cases
and fresh type/lint/format/build checks. Counts overlap and are not additive.
[Initial affected selection](../artifacts/verification/2026-10-18T16-58-22.953Z-check-2XhEvl/summary.md),
[exact navigation replay](../artifacts/verification/playwright-1792342835358-6ffbbc78-3a01-46c6-8ed6-4634e6c01794/playwright/summary.json),
[complete handoff selection](../artifacts/verification/2026-10-18T17-02-48.974Z-check-P8STga/summary.md).

The deferred camera/reference suites pass **75 cases in 23.59 seconds**, including
GPU and CPU cancellation during the final owned working-file close: both retain
the exact abort reason and remove owned working/camera/sensor outputs after close.
The two targeted RAW GPU cases pass in **5.40 seconds**, covering reduced-map
staging, a retained base uniform, one-byte-over-limit rejection, exact-limit
admission, unchanged native pixels, and sticky nonempty device failure.
[Camera/reference](../artifacts/verification/playwright-1792342891857-4a42f97a-91ad-4251-9c11-f8ab40503c67/playwright/summary.json),
[RAW admission/failure](../artifacts/verification/playwright-1792342943200-bbefb405-6fc6-4095-b998-e7f9d7f47227/playwright/summary.json).

The result handoff keeps only the unchanged source preview suspended while its
exact accepted task publishes and result selection completes. Failure, cancellation
and matching task dismissal release it. Explicit navigation or editing resumes
the source immediately and supersedes automatic result selection, including a
result lookup already in flight. It does not bypass scheduler priority or change
checksums, copying, sync, journal ordering, catalog publication or cleanup.

A retained diagnostic exposure contact sheet inspects the frozen master at
−3/0/+3 EV, including bright wall, deep shadow, foreground deer/antlers, bench and
background people. Final native cohorts have the same complete master hash, so
the candidates share that frozen output. This is an overview inspection, not
physical HDR certification or broader scene acceptance.
[Inspection notes](../artifacts/verification/2026-10-18-gpu-quality-inspection/notes.json),
[contact sheet](../artifacts/verification/2026-10-18-gpu-quality-inspection/master-exposure-contact.png).

## Remaining acceptance

This bounded Mac pass implements and validates both isolated GPU preparation
paths, exact cache/recipe policy, complete CPU recovery, cancellation including
late close, source integrity, resource admission and visible workflow timing.
Both GPU defaults remain rejected for this pass: camera is consistently slower;
reference improves the final visible cohort but retains an earlier service tail
and higher observed RSS. The 10/12-second workflow, 15-second intermediate,
five-second service stretch and existing 33 ms interaction gates remain unmet.
All failed experiments, earlier timing samples and slowest results are retained.

The implementation is frozen below the documentation-only report commits and the
[Bazzite continuation](mac-workability.md#bazzite-continuation) uses that exact
revision. Linux adapter/driver arithmetic, cancellation/recovery, performance,
HDR presentation and input behavior require independent local results. Mac
measurements establish no Linux result. No comprehensive checkpoint was repeated.
