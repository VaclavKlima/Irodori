# GPU-first processing and shared stage ownership

<a id="gpu-only-editing-and-rendering"></a>

## Decision — 2026-11-02

[Backlog #32](features/README.md#workspace-feedback-backlog) consolidates processing
around **one common production backend per stage across macOS and Bazzite**.
GPU execution is preferred for suitable image operations. Native multicore/SIMD
CPU execution is appropriate where it gives the best complete workflow, and
TypeScript owns orchestration and inexpensive calculations. Hardware choice and
implementation language are separate decisions. This supersedes the October 31
GPU-only requirement and older blanket CPU/GPU parity requirements. The dated
records below retain the scope and results of their original checkpoints.

Select a stage's backend before execution. A GPU failure reports the actual reason,
drains its owners and permits safe retry; it must not silently restart equivalent
CPU processing. Preserve originals, committed edits, completed outputs, source
leases, cancellation, revision checks and resource admission throughout failure
and retry. Reuse the established pipeline and its owners.

Default to the same backend on both platforms. Retaining competing platform-specific
backends requires explicit user approval supported by a very large, perceptible
workflow benefit. Do not infer that approval from a historical platform exception.
The [stage inventory](processing-stages.md) records production ownership, domains,
capabilities, resource limits, reference tests, remaining duplication and removal
checkpoints. Keep it current with code; unexplained duplication blocks completion.

Optimize user-visible completion time, responsiveness and image quality. Machine
utilization diagnoses bottlenecks; maximizing utilization is not an acceptance
criterion. Follow [performance decisions](performance-decisions.md) for matched
cold/warm workflow measurements and bounded adoption/rejection decisions. Reuse
existing Rust, C++, WASM SIMD and native libraries. Rewrite substantial JavaScript
image math only when profiling demonstrates worthwhile benefit.

Keep established algorithms, precision, memory, quality and performance gates.
Backend removal never justifies weakening tolerances or changing image semantics.
Independent compact numerical and photographic references remain outside production
bundles. Exact identity/copy operations, bounded coefficient/LUT preparation,
analytic geometry, sampled statistics and inexpensive pixel queries are useful CPU
work, not competing renderers. Scheduler redesign, new tools and denoising research
remain separately scoped tasks.

## Consolidation checkpoint — 2026-11-03

The [inventory](processing-stages.md) records the implemented removals and remaining
gates. Dead CPU presentation and raster recovery workers/IPC are gone. Detail,
fractional crop, resize, RAW preparation, proofs and point rendition now use their
selected GPU owners without equivalent CPU restart. Raster/authored HDR preserves
its own output semantics and independent SDR primary. Native full HDR masks are
common to macOS arm64 and Linux x64; sampled CPU analysis remains inexpensive work.
Merge adopted-stage restarts and rejected camera/reference executors are retired;
historical master bytes and truthful recomputation availability remain protected.

The bounded Float32 mask candidate and macOS Rust codec-host replacement failed
their unchanged exact gates. Their evidence stays retained and neither triggers
another optimization experiment. Keep the accepted native codec hosts. Decoder,
remaining analysis/CPU-kernel and platform acceptance checkpoints keep #32 open.

## Historical GPU-only migration — superseded policy, retained evidence

The following records describe the October 31–November 1 implementation and its
actual verification. Their GPU-only prescriptions are superseded by the decision
above. They do not establish current backend availability after removal; consult
the [stage inventory](processing-stages.md) for the current state.

<a id="current-implementation-and-bounded-migration"></a>

## Historical implementation and bounded migration

GPU-only migration is **not complete**. Current scope after the focused
detail/crop cleanup and November 1 export/presentation continuation:

| Path                                                | Current implementation                                                                                                                                                                                        | Migration requirement                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Detail preparation shared by preview/export         | Default/automatic production requests now select strict Dawn/WGSL; the GPU owner contains no CPU editing repair. Explicit CPU diagnostic selection and the legacy generic automatic executor remain           | Remove remaining explicit/legacy CPU routes separately; preserve independent references and clear unsupported-domain handling          |
| Fractional crop/straighten shared by preview/export | Default/automatic requests select strict GPU; near-cutoff alpha now produces an explicit precision refusal instead of CPU repair. Identity/integer paths remain exact copies                                  | Preserve the declared alpha limitation; remove remaining explicit/legacy executors separately                                          |
| HDR preview presentation                            | `PhotoPreview` uses `HdrPresenter` and reports explicit failure with GPU retry; it no longer creates `HdrCpuPresenter` or automatically substitutes an authored SDR primary on GPU failure                    | Preserve pending edits, source/target identity and safe disposal; retained legacy CPU modules remain separate cleanup                  |
| Raster preview presentation                         | Existing `PreviewPresenter` GPU paths retain their legacy worker fallback                                                                                                                                     | Migrate separately with explicit capability/retry handling                                                                             |
| Scene-linear RAW/merge export rendition             | Default/automatic execution uses the existing complete GPU shader and propagates GPU faults; explicit CPU diagnostics remain                                                                                  | Remove remaining explicit legacy routes separately                                                                                     |
| Raster/authored-HDR rendition                       | Distinct authored-source rendition logic remains CPU                                                                                                                                                          | Migrate supported domains while preserving authored primary/source semantics                                                           |
| Export reduction/enlargement                        | Default/automatic Lanczos3 selects the bounded GPU row-cache stage; small integration passes on both Radeon adapters and full-size SDR/HDR enlargement passes on RX 7900 XTX. Explicit CPU diagnostics remain | Preserve independent references, sequential phase budgets and explicit frozen-policy refusal; idle performance validation remains open |
| Curves, final-size proof and output sharpening      | Not yet enabled product features                                                                                                                                                                              | Implement their production processing on the GPU without adding a parallel CPU backend                                                 |

The first bounded migration routes preview and export detail filtering through
the shared `spatialExecutionBackend`: unset, `auto` and `gpu` select strict GPU processing.
Existing explicit environment selection `cpu` remains a legacy reference/
diagnostic route; ordinary production requests cannot silently take that route.
The GPU owner copies neutral tiles exactly without device initialization and
refuses active positive alpha below `2^-20` or non-finite GPU RGB instead of
recomputing on the CPU. Supported shader math, settings and cache identities
remain unchanged. Existing verified cache variants can still be reused with
their recorded lineage; reuse does not relabel old CPU pixels as GPU-computed.

The selected `detail-gpu-policy`, `spatial-detail-owner`, `detail-frame-gpu`,
`detail-preview-cache-gpu` and `detail-export-gpu` checkpoint passes **898 checks,
zero failures/skips, 52.49 seconds**:
`artifacts/verification/2026-10-31T19-32-44.621Z-check-VASoz0/summary.md`.
This includes eight default/automatic refusal/cleanup cases and nine GPU owner/
frame/cache/export cases. Actual adapter: RX 7900 XTX, RADV Mesa 26.2.4. The
integrated GPU, real full-source RAW/HDR, foreground interaction and performance
were not newly tested by that invocation. Preview proof/rendition CPU routes remain separate work.

### Crop/straighten and available adapters

Crop preview and both HDR-file/raster-frame export adapters now use the same
strict spatial-backend policy. `createCropGpu` no longer imports or calls the CPU
resampler. It retains the existing `2^-20` coverage floor and conservative
`16 × floor` classification margin, but refuses the former repair domain.
This includes some fully transparent fractional outputs when the source window
contains partial coverage. That is an explicit supported-domain limitation;
do not claim equivalent fractional-alpha support or silently change the cutoff.
Identity and integer-aligned crops still copy source words without interpolation.
Supported GPU equations, geometry/settings versions and cache identities are
unchanged. Legacy cached results retain their provenance.

The discrete-GPU selection `crop-gpu-policy`, `detail-gpu-policy`,
`crop-filter-gpu`, `crop-preparation-gpu` and `crop-frame-gpu` passes **902 checks,
zero failures/skips, 47.09 seconds**:
`artifacts/verification/2026-10-31T19-44-13.118Z-check-r40rSN/summary.md`.
It covers sixteen default/automatic refusal cases and five crop GPU cases,
including the six unchanged near-cutoff vectors now explicitly refused.

The integrated Radeon was then selected per process with
`DRI_PRIME='pci-0000_18_00_0!'`, after verifying PCI `1002:164e` and Mesa's device
selection layer. No system setting changed. The
[Mesa selector documentation](https://docs.mesa3d.org/envvars.html#envvar-DRI_PRIME)
defines `!` as exposing only the selected Vulkan device. An isolated Dawn probe
and actual test metadata confirm RADV RAPHAEL_MENDOCINO, Mesa 26.2.4, rather than
the discrete GPU or software adapter. Probe/source/log evidence is retained in
`artifacts/professional-editing/integrated-detail-probe-bg9c13ko/`.

- Detail owner/frame/cache/export: **890 passed, zero failures/skips, 54.41 s**,
  `artifacts/verification/2026-10-31T19-40-17.634Z-check-QKTT7p/summary.md`.
  All three small preview variants retain exact alpha and zero display-code
  difference under the unchanged floating tolerance.
- Crop filter/preparation/frame: **886 passed, zero failures/skips, 44.51 s**,
  `artifacts/verification/2026-10-31T19-45-47.093Z-check-6minHB/summary.md`.
  The GPU-owner case records its actual integrated adapter annotation.

Invocation counts overlap through the same 881 fast checks and are not additive.
These are small numerical/ownership checks, not full-source, presentation,
contention or performance acceptance. After the user made the desktop idle,
`professional-editor-native --foreground` passes **883 checks, zero failures/skips,
78.23 s**, with inspected real-Sony minimum-size/Console-open captures:
`artifacts/verification/2026-10-31T19-47-16.142Z-check-WoHjVX/summary.md`.
This native correctness check does not establish sustained performance or
physical color calibration.

Implement any future denoising pilot and final filter on the GPU. Reuse one bounded,
source-wide estimator to derive frozen parameters rather than implementing two
estimators: the existing sampled statistic can initially run once on the CPU per
immutable prepared source. This is parameter derivation, not a second denoising
backend. Its four directions cap samples at 65,536 pairs each and reuse two source
rows; an equivalent GPU weighted-median/MAD implementation is additional work.
Measure that stage before deciding whether moving it is worth the cost. Merely
setting an existing `backend: 'gpu'` option does not remove internal filter CPU
recovery. Retain versioned old edits and cache identities. Remove legacy
fallbacks incrementally with their affected tests; do not claim all of #32 is done
after migrating one feature.

### Strict scene-linear export rendition

The existing GPU-eligible scene-linear RAW/merge branch now propagates failures
for both default/automatic and explicit GPU execution. Its shader already
implements white balance, Light, Saturation/Vibrance, mixer and grading for SDR
and HDR rendition, including the rendition before an actual resize. Initialization,
admission, tile or deferred-HDR failure drains pending early JPEG work, closes
the converter and propagates the original error. It never rerenders the source
on the CPU. Existing shader math, settings, resize and output tolerances remain
unchanged. Retained detail preparation survives a failed attempt and can be
reused by a later GPU attempt against the frozen source.

Ordinary raster exports and authored gain-map HDR sources with `source.display`
retain their distinct legacy CPU rendition logic. This change does not pretend
the scene-linear shader implements their source semantics. Explicit CPU
diagnostics remain, as does the CPU Lanczos3 row resizer.

The discrete-GPU selection `export-gpu-policy`, `export-gpu`,
`export-enlargement-gpu`, `detail-export-gpu`, `export-resources-gpu` and
`creative-color-export` passes **900 checks, zero failures/skips, 53.32 s**:
`artifacts/verification/2026-10-31T19-55-53.111Z-check-dsXfqa/summary.md`.
Six policy cases cover initialization refusal in default/automatic SDR/HDR
requests and preservation of the two legacy source domains. Thirteen GPU cases
retain independent CTL/creative-color/packing limits and verify later-tile
retirement, deferred encoder draining, resource refusal and retained-detail retry.

The same five GPU targets pass on the integrated Radeon: **894 checks, zero
failures/skips, 73.05 s**:
`artifacts/verification/2026-10-31T19-57-04.350Z-check-NGK30N/summary.md`.
The actual adapter annotation confirms RAPHAEL_MENDOCINO/Mesa 26.2.4. The budget
warning retains all assertions; creative-color cases take 10.79/8.20 s and this
is correctness evidence, not a matched performance measurement. Counts overlap
the same 881 fast checks. Combined real-source edit/export/restart verification
also passes in its separate focused selection after these policy changes:
**883 checks, zero failures/skips, 99.92 s**,
`artifacts/verification/2026-10-31T19-59-26.702Z-check-9x6X1C/summary.md`.
It covers recorded real RAW/raster/synthetic encoded ISO/genuine v4-source
functional paths with small native export crops. Strong-noise photographic
quality, sustained responsiveness and the rest of the GPU migration remain open.

Existing C16 Python/reference work is offline research. Its GPU prototype now
passes small numeric references but fails the unchanged edge limit and gives
little visible cleanup on the ISO 6400 photograph. It is not a production
candidate. Do not add another production CPU denoiser or extend the CPU-only
photographic execution driver. The bounded
[published-method review and Vulkan BM3D trial](features/denoising-method-review.md)
reuse an existing GPU implementation. Photographic grain removal improved, but the fixed
setting fails both retained edge gates; the trial is stopped and no replacement
is integrated. Resolve the noise/domain/control and reproducibility decision
before another filter cycle, preserving the retained requirements.

## Hardware and verification scope

Test the user's available machine. On this Bazzite host, PCI/DRM inspection finds
an AMD Navi 31 discrete adapter and Radeon 610M integrated graphics. Their presence
does not prove either implementation's capability or acceptance. Record actual
GPU execution, selected adapter, limits and failures when testing; include both
adapters when available, as #32 requests. Add support for other user hardware when
needed instead of building speculative compatibility matrices.

Use existing targeted tests and independent reference images/vectors. Preserve
HDR/SDR output, alpha, quality, history, cancellation, resource limits and the
existing applicable performance gates. Do not require a full-frame production
CPU/GPU parity matrix. Do not rerun unchanged proofs just to create a new report.
Follow [performance and effort decisions](performance-decisions.md) before costly
optimization or expanding this migration.

## Strict HDR presentation and retry — 2026-11-01

`PhotoPreview` no longer instantiates the legacy `HdrCpuPresenter`. Active GPU
failures hide the main, retained and clipping surfaces, clear editing readiness,
report presentation stage `failed`, and show the actual reason with **Retry GPU**.
The edit owner flushes the last valid draft before controls disable, preserving
one ordinary history entry. Retry waits for GPU disposal, creates a fresh canvas,
restores keyboard focus after readiness and refreshes the existing capability
probe through the unchanged preview preference. Healthy target changes keep the
GPU owner/source upload and use its existing target update path.

An already-presented authored HDR JPEG retains its HDR working-source demand
through GPU capability loss on the same HDR monitor. The real effective display
target can still report SDR/unavailable; source retention does not invent display
capabilities. Explicit SDR selection, a different monitor, or healthy no-headroom
reporting release the hold. A loss report cannot trigger an automatic retry loop;
automatic recovery requires usable GPU capabilities. Legacy raster fallback and
the unused HDR CPU implementation remain separately scoped migration work.

The selected `hdr-jpeg-ui`, `hdr-content-ui` and `interactive-preview-lifecycle`
checkpoint passes **895 checks, zero failures/skips, 92.20 s**, explicitly in
foreground mode:
`artifacts/verification/2026-11-01T09-55-19.640Z-check-ZgxqoU/summary.md`.
This comprises 883 shared fast checks, four HDR JPEG cases, two content cases and
six native lifecycle cases. It covers real pipeline rejection/device loss,
resource drainage with zero CPU rendering requests, exact source/history/view,
single pending-edit persistence, GPU/capability retry, normal source reuse and
stale completion after cancellation/photo switching. The three retry proofs each
compare nine composited samples with the generation-bound current-target pixel
API; maximum differences are **1/1/1**, within the unchanged one-code limit.
Native error UI was visually reviewed at 1100 × 700. The routine-budget warning
retains all assertions; the longest functional case is 6.61 s.

The new authored-HDR device-loss case fails against the prior build, then passes
against the fix; both direct receipts are preserved. Earlier attempts also
exposed and fixed healthy-owner recreation, disabled-input draft persistence and
premature focus restoration. The old proof incorrectly read a transient WebGPU
drawing buffer and selected a fixed sRGB oracle for Display-P3 output. It now
captures the actual composited frame, binds the current target/generation and
converts its already-rendered primaries into the capture domain. No production
shader, numeric threshold or reference sample changed.

Two HDR JPEG cases require native monitor HDR headroom and carry reasoned
`@foreground` tags: hidden Wayland windows selected the authored SDR primary and
could not exercise those HDR paths. Background selection defers them explicitly;
it never opens a visible window automatically. These are Bazzite hardware/UI
correctness receipts, not sustained-performance, physical-luminance, other-OS or
integrated-renderer acceptance. Real monitor changes during a GPU fault were not
physically exercised by this selection. Strong-noise quality remains open.
