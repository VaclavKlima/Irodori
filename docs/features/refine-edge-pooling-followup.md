# CascadePSP exact pooling follow-up

The separately authorized [audited metadata continuation](refine-edge-metadata-followup.md)
subsequently proves full-model execution and reviews two photographic sentinels.
It retains the strict-session refusal below and leaves broad adoption unqualified
because the excluded mealworm is still partly selected.

## Decision — November 14, 2026

The user authorized one bounded compatibility continuation of
[#77](https://github.com/VaclavKlima/Irodori/issues/77), preserving the completed
[earlier study](refine-edge-research.md). The exact pooling replacement removes
the original ONNX export failure. Standalone pooling passes native WebGPU and
the unchanged numerical gate. The full global model still fails the frozen
strict session-creation gate, so local refinement and photographs were not run.
Implementation [#78](https://github.com/VaclavKlima/Irodori/issues/78) remains
blocked; no product capability was enabled.

This is a refusal of the selected execution contract, **not a photographic
quality rejection or proof that heavy model operations require CPU execution**.
The diagnostic evidence identifies only shape-metadata placement candidates.

## Fixed method and completed gates

The [separate frozen protocol](../../assets/tests/references/refine-edge/pooling-followup.json)
retains the original source revision, checkpoint, FP32, opset 17 and `L=900`.
Only the export representation of AdaptiveAvgPool2d changes: each cell uses
`floor(index × input / output)` through `ceil((index + 1) × input / output)`
bounds, followed by Slice, ReduceMean and Concat. Non-divisible windows keep
their original overlap. Shape/Gather/integer arithmetic derives bounds for
dynamic spatial dimensions; trained weights, interpolation and activations do
not change. Eager upstream Torch remains the independent oracle.

The synthetic 76 × 113 input has three coordinate-pattern channels, including
an explicit border channel. Pooling sizes 2, 3 and 6 provide 147 independent
reference values. The [small committed reference](../../assets/tests/references/refine-edge/pooling-reference.json)
records generator, environment and exact bytes/hashes. The maximum eager
lowering/reference error is `5.96e-8`, with zero diagnostic R8 difference.

The standalone graph exports to 99,982 bytes / 1,208 nodes. Both discrete and
integrated process selections pass strict native WebGPU: 112 profiled inference
nodes, 147 compared outputs, no tolerance failures, maximum error `5.96e-8`.
Those independent small probes do not identify a physical adapter by themselves.
The later same-process probe independently proves PCI `0000:03:00.0` from ORT
DRM engine activity and repeats all 147 values before loading the global model.

The single dynamic global export succeeds: 271,541,562 bytes / 4,583 nodes in
50.77 seconds, approximately 3.54 GB peak process RSS. Its inputs are the exact
upstream-padded 608 × 904 tensors derived from a synthetic 600 × 900 source.
One graph names dynamic `H`/`W`; runtime specialization uses the existing ORT
`freeDimensionOverrides`, not repeated model exports. Crop-back and the original
high-resolution orchestration remain external and unqualified.

## Full model refusal and diagnostic limit

Native ORT 1.31.1 refuses global session creation with CPU fallback disabled:

> This session contains graph nodes that are assigned to the default CPU EP,
> but fallback to CPU EP has been explicitly disabled by the user.

The initial failed run took 0.81 seconds including the passing pooling preflight.
One diagnostic rerun changed logging only; graph bytes, dimension overrides,
optimization, provider and disabled-fallback policy were unchanged. It identifies
24 CPU-placement candidates: Gather/Slice nodes whose first inputs come from
Shape. Producer inspection confirms short shape metadata for those reported
candidates. No feature-plane CPU kernel is demonstrated. Session creation aborts
before final assignment/inference, so the log does not establish a complete
provider map or full-model numerical agreement.

The frozen follow-up nevertheless requires a session with CPU fallback disabled
and every profiled inference node on WebGPU. Do not silently convert that failed
gate into a pass. The current production GPU-first policy permits inexpensive
host calculations; qualifying an explicitly bounded metadata path would require
a separately recorded follow-up contract and proof that image/model work stays
on the selected GPU before execution. No such relaxation or extra model trial was
performed here.

Automatic resource admission passed before the refused load: approximately
3.92 GB estimated RAM / 1.96 GB GPU, against 8.17 GB / 6.44 GB Automatic budgets.
Capacity was bound to the actual ORT adapter from the same-process pooling
preflight. No override was used; these estimates are not opaque driver peaks.

## Verification, preservation and resumption

The new explicit `refine-edge-pooling` Node target checks preserved original
hashes, the new frozen contract, target exclusions and all 147 original Torch
values against an independent window calculation and exact Float32 byte hashes.
It does not qualify GPU/model/photo acceptance from synthetic references.
The [research tools](../../scripts/research/refine-edge/README.md) describe the
exporter and owned-child runtime gate. Earlier scripts, protocols, crops,
rejections and photographic outputs remain unchanged.

The evidence root is
`artifacts/research/refine-edge/2026-11-13-cascade-pooling-followup/`.
Read `summary.md` first. It links exact exports, numerical/profiling/device
receipts, the original refusal, diagnostic CPU candidates, verification and
remaining limits. Downloads, exported graphs and raw tensors stay ignored.

Stop at this execution-contract refusal. Local export, local inference, the four
hard photographic cases, the full twelve-scene run, other-device full-model
qualification and production adoption remain unverified. There was no CPU
inference fallback, alternate model, opset/shape sweep, production change or
foreground run. Pretrained-weight redistribution/adoption terms remain unresolved
independently of numerical/export compatibility.
