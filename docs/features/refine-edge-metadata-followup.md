# CascadePSP audited metadata follow-up

## Decision — November 14, 2026

The separately authorized continuation of
[#77](https://github.com/VaclavKlima/Irodori/issues/77) resolves the execution
blocker from the [exact pooling experiment](refine-edge-pooling-followup.md).
Both learned stages execute on the RX 7900 XTX with a complete provider audit
before inference and pass the unchanged synthetic numerical gates. The two
completed photographic sentinels show useful boundary improvements, but the
robin still includes part of the explicitly excluded mealworm. Broad adoption
is **not qualified**; [#78](https://github.com/VaclavKlima/Irodori/issues/78)
remains blocked. No application capability was enabled.

The flamingo retains its narrow legs and improves head/beak boundaries. The
robin has a cleaner outline and less mealworm contamination overall, but part
of the upper worm still receives the diagnostic edit. This is an unmet target
exclusion, not a claim that CascadePSP is worse overall than the original SAM
mask. The frozen hard-case stop was applied after that finding: fence, wig and
the full twelve-scene expansion were not run. No parameters or prompts were
tuned in response.

## Explicit execution contract

The [new frozen protocol](../../assets/tests/references/refine-edge/metadata-followup.json)
selects CPU shape bookkeeping explicitly, preserving all earlier strict-session
refusals. The CPU execution provider is enabled; a claim that CPU fallback is
globally disabled would be false. CPU learned/image/feature computation and
retrying GPU failure as CPU inference remain forbidden.

ORT 1.31.1 saves the finalized optimized `.ort` graph during creation of the
original live session. The extractor reads that snapshot without constructing
another session. It accounts for every finalized node, provider, edge, tensor
type and shape. A later reload can repartition the graph and cannot prove the
original assignment. Before the first model `Run`, the audit requires:

- Every learned/image/feature operation belongs to `WebGpuExecutionProvider`.
- CPU nodes are known dimension operations on bounded integer metadata: at most
  16 elements and rank two. Shape may inspect feature dimensions, not values.
- Metadata comes from dimensions or immutable bounded constants and reaches
  verified GPU shape-control ports only. A feature operand, graph output,
  unknown assignment or unbounded lineage causes refusal before inference.
- The audit is bound to the same live session by source/snapshot/map/protocol
  hashes and a session nonce. Post-run profiling checks actual CPU node indices
  against that preapproved set; profiling alone never grants permission.

The global synthetic session has **1,304 finalized nodes: 579 CPU metadata and
725 GPU nodes**. The local stage has **495 GPU nodes and zero CPU nodes**.
The earlier diagnostic's 24 CPU candidates were an incomplete log subset; the
complete audit also accounts for integer pooling-window bounds. No CPU feature
kernel was permitted or observed. The original same-live-session receipts and
worker snapshots remain private evidence.

## Numerical and device evidence

The source revision, checkpoint, exact adaptive pooling, FP32, opset 17 and
`L=900` remain unchanged. Global inputs are the original padded 608 × 904
synthetic tensors; local inputs are 904 × 904 with `inter_s8`. Eager upstream
Torch outputs remain the independent reference. Across all three outputs from
both stages, **4,100,544 values** pass
`abs(error) <= 0.001 + 0.001 * abs(reference)` with zero failures. Maximum
absolute error is approximately `6.77e-6`; the largest diagnostic R8 difference
is one byte under upstream Float32 multiplication followed by truncation.

Model inference takes approximately **1.17 seconds global** and **1.45 seconds
local** for those synthetic inputs. Same-process tiny-pooling preflight and
DRM activity establish actual PCI `0000:03:00.0` on Bazzite/Linux x64. This
qualifies these stages on the available RX 7900 XTX only. Full-model execution
on the integrated Radeon, macOS and Windows remains unverified.

Automatic resource admission passes without overrides. Estimates include model
and managed working storage; opaque GPU residency peaks are not measured. The
completed photographic calls initially omitted the parent image reservation
from their admission formula. A retained post-run conservative supplement adds
that reservation for all 16 calls and still fits the original 8.17 GB RAM
budget (maximum estimate about 5.76 GB). The helper now includes it before load;
this prospective hardening was not rerun as another photographic experiment.

## Actual photographic preparation and review

The [separate photographic contract](../../assets/tests/references/refine-edge/metadata-photos.json)
explicitly selects unmodified upstream native Torch CPU preparation for this
research stage: BGR normalization, area/bilinear interpolation, padding,
`safe_forward`, skip decisions, ordered overlaps and final composition.
No Torch learned model is constructed or executed. Every learned forward uses
the audited native ORT GPU path, with a new same-live-session audit and an
unchanged-graph synthetic numerical prerequisite. The final native coverage
uses upstream truncating R8 conversion. This is a research adapter, not an
accepted production preprocessing/backend or integration contract.

| Case     |           Learned GPU calls | Research elapsed time | Visual finding                                                                     |
| -------- | --------------------------: | --------------------: | ---------------------------------------------------------------------------------- |
| Flamingo |  6 (one global, five local) |               27.30 s | Solid narrow legs retained; useful head/beak boundary improvement.                 |
| Robin    | 10 (one global, nine local) |               45.07 s | Cleaner outline and less worm contamination; upper excluded mealworm still edited. |

These elapsed times include repeated session loads, assignment snapshots,
audits and native preparation. They are not production latency benchmarks.
There is no photographic alpha ground truth or physical transparency claim.
The reviewed diagnostics use the earlier hash-verified neutral SDR sources,
unchanged SAM baselines, production Feather 4 / shift 0, frozen native crops,
red coverage overlays and +1 EV views. Fit and native head/leg/feather crops
remain available privately. The first case is a positive sentinel, not a broad
quality pass; the second triggers the documented stop.

## Verification, evidence and resumption

The explicit-only `refine-edge-metadata` Node target checks the frozen protocol,
preserved earlier contract, complete/noncontiguous assignments, bounded shape
lineage, feature-data refusal, overridable-initializer refusal, unknown or
incomplete maps, exact int64 constants and photographic numerical prerequisites.
It does not rerun models or infer quality from a synthetic test. The
[research tools](../../scripts/research/refine-edge/README.md) document the
extractor, audit, live-session runtime and photographic adapter.

The current local evidence root is
`artifacts/research/refine-edge/2026-11-14-metadata-followup/`.
Read `summary.md` first; `details.md`, `result.json`, `case-review.json`, per-call
receipts and proof indexes retain exact execution, hashes and review limits.
The setup-only failure caused by an undefined ORT snapshot option is preserved
alongside the corrected audit-only and execution runs. Later guard hardening is
distinguished from the exact worker snapshots that produced the results.

The publication audit additionally requires a positive safe-integer completed
inference count in photographic prerequisites. Missing, nonnumeric, fractional
or nonfinite counts are refused; both genuine retained numerical receipts still
validate. This guard correction changes no model mathematics or photographic
result and requires no repeat inference.

The [original study](refine-edge-research.md) and pooling refusals remain
historical evidence, not retroactively passing results. Downloads, models,
raw coverage and generated proofs remain outside Git. Pretrained-weight
adoption/redistribution terms are independently unresolved. Product source
registration, UI/API/MCP, history, cancellation during inference, SDR/HDR export,
other-device execution and production timings are unqualified.

Stop here. A separately selected proposal must address the retained exclusion
and other hard cases, preserve the broad quality gate and resolve model terms
before #78 can resume. This result authorizes no model/parameter sweep or
production enablement. No foreground run or comprehensive checkpoint occurred;
the research checkpoint preceded publication. Delivery status is tracked in #77;
generated evidence remains local.
