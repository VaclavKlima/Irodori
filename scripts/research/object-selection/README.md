# General object-selection research

These offline tools implement the bounded feasibility study for the selection and manual-refinement portion of [TODO 54](../../../docs/features/README.md#task-54), shared with TODO 66. They do not activate an application tool, install a production dependency, open a managed library, or provide an inference fallback. See the [findings and remaining gates](../../../docs/features/object-selection-research.md).

**Delivery update, November 8:** the subsequent [Mac implementation](../../../docs/features/object-selection.md)
adopts the qualified SAM 2 export through the application's shared native-WebGPU
worker. Its intentionally bundled graphs and notices live in
[`assets/app/object-selection`](../../../assets/app/object-selection/README.md).
The no-bundling and two-device qualification instructions below describe the
original research stage; current delivery follows the user's device-by-device
policy, with Bazzite verification in [TODO 69](../../../docs/features/README.md#task-69).
Research downloads, alternate models and generated artifacts remain outside Git.

## Frozen inputs and execution policy

- [protocol.json](../../../assets/tests/references/object-selection/protocol.json) defines the runtime, twelve distinct scenes, development/holdout split and qualification rules.
- [inputs.json](../../../assets/tests/references/object-selection/inputs.json) records source hashes, fixed normalized prompts, intended objects, privacy/permission status and the fixture-only commit. Three holdouts require explicit release; do not retarget prompts after inspecting results.
- [model-sources.json](model-sources.json) pins upstream commits, checkpoint hashes and licenses. Keep downloads, source checkouts, exported graphs, embeddings and generated proofs under ignored artifacts. Do not add weights to the application bundle.
- Select native ONNX Runtime WebGPU before inference. Set `extra.session.disable_cpu_ep_fallback` to `1`, retain native profiling, and refuse a CPU-only graph. Every profiled inference node must belong to `WebGpuExecutionProvider`. A failed GPU session never retries on CPU.
- Python model execution is an explicitly requested export/reference diagnostic after the GPU gate. Its outputs on synthetic and photographic inputs are numerical oracles, never photographic quality/performance results or a production fallback. NumPy/PyTorch proof and brush helpers are research references, not production per-pixel implementations.

The recorded Mac run used host Node 24.8.0, application-bundled Node 24.20.0, isolated `onnxruntime-node@1.31.1`, Python 3.12.12 and the exact [export requirements](requirements-export.txt). The original plan mentioned ORT 1.30 documentation; the actual released 1.31.1 package and native binding hashes are recorded in receipts. The root package manifest and lockfile were unchanged. A fresh setup must retain its own package lock, package integrity, machine/runtime information and receipts rather than copying a success claim from this machine.

## Reproduction order

Use fresh output directories. The commands below assume `study` is an ignored artifact directory and `research_python` is an isolated Python 3.12 environment with the pinned requirements. They are examples for explicit research execution, not an automatic download or installation script.

1. Create the small numeric and unsupported-operator models with `make-probe-model.py`. Install the exact ORT package in `study/runtime-node`, independently of the application. Run `run-runtime-probe.mjs <runtime-root> <model> <output> normal runtime`, then the CPU-only graph with `refuse runtime`, and the supported graph with `cancel runtime`. The wrapper always launches the application's bundled Node. Stop if strict GPU execution, numeric comparison, refusal or owned-child cleanup fails.
2. Retrieve only the pinned upstream source commits and checkpoint URLs. Verify SHA-256 before loading, and preserve upstream licenses with the downloaded files. `export-models.py --help` lists the required source, checkpoint, output, GPU receipt and explicit CPU-export-reference arguments. Export the original int64-label components first. Preserve any refusal receipt.
3. The accepted compatibility variant uses **exact float32 categorical labels** `-1, 0, 1, 2, 3`. Re-export only the decoder with `--label-dtype float32`, `--reuse-encoder-manifest` and `--original-reference-manifest`. Require exact output agreement with the original int64 reference, then run the actual model probe. This is an input-type compatibility change, not reduced model precision or an altered segmentation algorithm.
4. Bundle the existing source-preparation controller into ignored artifacts, then prepare tracked originals through the isolated application processing worker:

   ```sh
   npx esbuild src/main/preview-process.ts --bundle --platform=node --format=esm --packages=external --outfile=artifacts/research/object-selection/preview-process.mjs
   node scripts/research/object-selection/prepare-inputs.mjs --root . --inputs assets/tests/references/object-selection/inputs.json --output artifacts/research/object-selection/prepared --preview-module artifacts/research/object-selection/preview-process.mjs
   ```

   The adapter verifies Git tracking and original bytes. Its images are full-native, once-oriented neutral SDR without lens, crop or local edits; RAW is decoded from sensor data. It preserves the preparation identity and native dimensions. This step prepares photographs without running either segmentation model, including for the holdouts. Preparation, tensor preprocessing and final coverage costs are separate from inference timing.

5. Run `prepare-case-inputs.py` for each candidate using the prepared manifest. Default selection is development only. SAM 2 uses its official antialiased bilinear tensor resize and encoder normalization; EfficientSAM uses its official bilinear `F.interpolate` and encoder normalization. Both independently resize X/Y to 1024 × 1024 without letterboxing; EfficientSAM antialiasing is false and SAM 2 antialiasing is true. Boxes occupy two categorical prompt slots; positive/negative points occupy the remaining slots. Six is the study limit; overflow is refused, never truncated. SAM 2 prior-mask inputs remain zero for this study, including the refined stage; EfficientSAM has no prior-mask input.
6. Attach original upstream int64-label numerical references with `make-cpu-references.py --cpu-reference-diagnostic`, passing the same model's successful strict-GPU receipt. Then run the two candidates sequentially with `run-runtime-probe.mjs ... normal corpus <cases.json> <protocol.json> <explicit-comma-separated-case-ids> development`. Do not overlap timing runs with another GPU operation or CPU reference generation. The runtime checks fixture hashes, all output samples against the fixed `1e-3` absolute/relative tolerance, and native profile assignment before publishing a result.
7. Freeze graph hashes, preprocessing, prompts and reconstruction before releasing the three holdouts. The tensor-preprocessing, CPU-reference and proof tools require `--allow-holdout`; the runtime requires explicit IDs and `holdout`. Preserve the release receipt. Do not tune against held-out results.
8. `render-proofs.py` renders only passed GPU results. Both models use the same policy: highest returned predicted-IoU candidate, first on ties; bilinear 256 × 256 logits to native size with `align_corners=false`; threshold zero to R8 coverage. The overlay and +1 EV linear-sRGB SDR diagnostic are reviewed at Fit and native crops. This is semantic binary coverage, not a calibrated confidence/alpha matte, actual RAW edit/export, or automatic fine-edge matting. Keep outputs outside Git, with original photographer attribution when distributing adapted image material.
9. Run the independent manual-correction reference:

   ```sh
   "$research_python" scripts/research/object-selection/manual-refinement.py --self-test --output artifacts/research/object-selection/manual-refinement
   ```

   It keeps immutable content-addressed R8 bases separate from ordered normalized Paint/Erase strokes. Reload and history do not require model execution. `--base`, `--strokes` and `--output` also accept an actual native coverage PNG and a scripted demonstration document. The self-test includes scalar/tile-seam references, order/inversion, model-free reload, same-grid AI-base replacement, Undo/Redo and stale/tampered-content refusal. Its timing and memory are CPU reference measurements, not Editor latency. The committed `assets/tests/references/object-selection/manual-dog-strokes.json` supplies the two illustrative real-photo strokes for the saved SAM 2 dog coverage; these are demonstration corrections, not ground-truth annotations.

## Checks and qualification

The explicit `object-selection-research` verification target registers the six fast research-gate tests. It is excluded from default production regression selections. Model, native-runtime and photographic commands are deliberate research operations, not silently added to normal tests. The verification runner also selects its standard fast prerequisites; retain a focused invocation receipt when selecting only the research and verification-registry suites.

`qualification.ts` counts only reviewed, permitted, tracked, non-private distinct scenes. Equal hashes or multiple exposures cannot pad the cohort. Both required platform receipts, export/reference parity, native photographic review and manual correction evidence must be present. Even complete evidence returns only `qualified-for-implementation-planning`, never production activation. Real human-portrait hair, timed human correction effort and physical alpha remain separately unverified; an isolated wig does not establish portrait quality.

No production mask schema/history, GPU coverage sampling, preview/export path, inference scheduling, download/retry UI, click/box interaction or Console mutation is implemented by this directory. Those changes need their own coherent follow-up and affected checks after the common Mac/Radeon backend is qualified.
