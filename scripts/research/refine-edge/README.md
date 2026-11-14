# Refine Edge research tools

Offline-only implementation of [#77](https://github.com/VaclavKlima/Irodori/issues/77).
The [findings](../../../docs/features/refine-edge-research.md) reject both frozen
candidates for broad adoption. These tools do not enable application behavior,
open a managed library or provide CPU inference fallback.

## Inputs and outputs

Use the committed `assets/tests/references/refine-edge/` protocol, native crops
and Cascade source manifest, plus the existing twelve-scene object-selection
corpus. Hash all input bytes; retain original prompts and once-oriented neutral
SDR source grids. All paths in case manifests are absolute. Each case records
source RGBA, baseline raw R8/PNG, candidate and Feather raw R8 paths/hashes,
dimensions, Automatic admission snapshots and stage timings. Fractional R8 values
must not be thresholded. Never overwrite an existing research destination.

The completed local run is under
`artifacts/research/refine-edge/2026-11-13T19-41-14Z/`; read its `summary.md` first.
Do not rerun a rejected candidate just to reproduce a historical pass/failure.

## Reproduce a separately authorized study

Install locked npm dependencies and prepare the current native prerequisites per
the root README, then build. Keep Python/model dependencies in an ignored,
isolated environment; the recorded reference environment used Python 3.12.16,
Torch 2.8.0+cpu, torchvision 0.23.0+cpu and ONNX 1.23.2. Package versions are
retained with the Cascade export receipt and `cascade/python-packages.json`.
CPU execution is limited to explicit
export traces, numerical oracles and the existing manual representation reference.

Choose a **new** directory under ignored `artifacts/research/refine-edge/`.
Before any candidate execution, write a `freeze-receipt.json` containing `frozenAt`
(UTC ISO timestamp), `protocolSha256`, `cropsPath` (repository-relative),
`cropsSha256`, and `candidateOutputsInspected: false`. Hash the exact committed
protocol/crop bytes; keep a copy of those bytes with the receipt. The runner
refuses changed hashes. Preserve invocation histories and earlier failures.

Prepare originals with the existing isolated source adapter:

```sh
refine_study=artifacts/research/refine-edge/NEW-RUN
npx esbuild src/main/preview-process.ts --bundle --platform=node --format=esm --packages=external --outfile="$refine_study/preview-process.mjs"
node scripts/research/object-selection/prepare-inputs.mjs --root . --inputs assets/tests/references/object-selection/inputs.json --output "$refine_study/prepared" --preview-module "$refine_study/preview-process.mjs"
node scripts/research/refine-edge/run-guided.mjs --study "$refine_study" --stage baseline
node scripts/research/refine-edge/run-guided.mjs --study "$refine_study" --stage guided
node scripts/research/refine-edge/render-proofs.mjs "$refine_study/guided/cases.json" "$refine_study/proofs-development"
```

`--ids d01-fog-dog,d06-wig,d08-flamingo` limits the initial development evaluation
to the three sentinels. A subsequent development invocation retains completed
cases and validates their bytes. The runner uses bundled Node and owned children;
it never starts Electron. Its console log path and all per-case sources are saved.

After development review, write an immutable `development-decision.json`, then a
`confirmation-release.json` with `candidateId`, the three explicit `ids`, matching
protocol/crop hashes, `developmentDecisionSha256`, `previouslySeen: true`, and
`tuningAllowed: false`. Run baseline and guided stages with
`--allow-confirmation --ids h10-shore-pine,h11-robin,h12-glass`. No tuning follows
release. The review may still reject adoption; preserve those outputs too.

`render-proofs.mjs` requires passed cases, checks source/coverage/protocol hashes,
refuses existing/overlapping output, and writes Fit/native overlays, masked +1 EV
diagnostics, alpha PNGs and a proof index. Individual native panels retain one
source pixel per output pixel. Diagnostics are not application RAW/HDR exports.

For the other local adapter, use a new `--study` directory plus `--prepared`,
`--baseline-manifest` and `--freeze-receipt` pointing to the existing frozen
inputs. Set a process-local Mesa adapter selector, and verify actual Dawn and
separate ORT physical-device receipts; an environment variable alone is not proof.
Do not regenerate the full corpus to repeat one numerical case.

## CascadePSP and manual reference

Clone only the pinned Cascade revision from `cascade-sources.json` into ignored
artifacts. The official checkpoint remains private. The single-attempt command is:

```sh
research_python=artifacts/sky-selection/python-env/bin/python
"$research_python" scripts/research/refine-edge/cascade-study.py --source "$refine_study/cascade/source" --output "$refine_study/cascade/attempt-01" --export-python "$research_python" --cpu-export-trace
```

The export trace uses unchanged FP32 `L=900` upstream processing and synthetic
input. Unsupported adaptive pooling ends this candidate: no alternative shape,
opset or architecture trial. An exported graph alone would remain unqualified
until strict WebGPU and original-model parity evidence exists. The completed
study never reached that stage. A setup-only failure may reuse an integrity-checked
`--checkpoint` in a fresh attempt; preserve both receipts and do not count setup
as a model trial. A model-specific adoption license remains unresolved.

The actual model-free base/correction preservation check is:

```sh
"$research_python" scripts/research/refine-edge/check-manual.py --study "$refine_study" --output "$refine_study/manual-reference"
```

It imports the existing reference unchanged and uses actual dog baseline/guided
coverage plus the committed two-stroke document. It does not measure application
history, latency or production geometry registration.

## Focused checks

```sh
npm run verify -- --target refine-edge-research --target refine-edge-research-gpu
```

Both targets are explicit-only; the GPU group is exclusive. Missing photographic,
runtime, license or cancellation evidence never becomes a pass. The numerical
suite checks the existing independent OpenCV bound, fractional values, odd native
tails, buffer-limit refusal/cleanup and same-device retry. Neither passing tests
nor complete local research activates #78. Foreground runs require user approval.

## Separately authorized exact pooling continuation

The [November 14 follow-up](../../../docs/features/refine-edge-pooling-followup.md)
has its own frozen protocol and retains the earlier study unchanged. Use a fresh
directory for every stage. The exporter verifies the pinned source/checkpoint,
copies the exact generator/protocol into each output, and changes only ONNX
pooling representation. Synthetic eager Torch outputs remain independent.

```sh
refine_followup=artifacts/research/refine-edge/NEW-POOLING-RUN
"$research_python" scripts/research/refine-edge/cascade-pooling-export.py --stage pooling --output "$refine_followup/export/pooling"
"$research_python" scripts/research/refine-edge/cascade-pooling-export.py --stage global --source "$refine_study/cascade/source" --checkpoint "$refine_study/cascade/attempt-02/official-v1.0-model.pth" --output "$refine_followup/export/global"
node scripts/research/refine-edge/cascade-runtime.mjs --manifest "$refine_followup/export/global/model-manifest.json" --pooling-manifest "$refine_followup/export/pooling/model-manifest.json" --output "$refine_followup/runtime-global"
npm run verify -- --target refine-edge-pooling
```

The local stage is conditional on earlier gates; it was not run after the global
session refusal. No per-aspect export grid is permitted. Graphs remain FP32,
opset 17, bounded to 600 MB / 12,000 nodes; original pooling bounds/overlaps and
model weights are preserved. Model outputs require original Float32 multiplication
then truncation for R8, rather than the guided filter's rounding policy.

`cascade-runtime.mjs` bundles the existing resource observers into a new owned
Node child. It runs the tiny pooling graph first in that same ORT-only process,
observes physical PCI activity, resolves Automatic resource capacity, and only
then attempts the global session with dimension overrides and optimization.
Every inference/reference value must pass unchanged FP32 and one-byte R8 bounds;
CPU fallback remains disabled. The parent limits the child to 240 seconds and
retains exact outputs, logs, profile/device evidence and refusal reasons.
An explicit `--verbose` diagnostic changes logging only; it never changes provider
or acceptance rules. No model/photographic pass follows from pooling success.

The completed compatibility run is under
`artifacts/research/refine-edge/2026-11-13-cascade-pooling-followup/`.
Its runtime refused the full model before inference. The 24 logged CPU candidates
are Shape-derived metadata, not demonstrated heavy CPU kernels. Preserve that
distinction and the frozen contract's failure; no metadata exemption was applied.

## Separately authorized audited metadata continuation

The [metadata follow-up](../../../docs/features/refine-edge-metadata-followup.md)
preserves those strict-session failures and explicitly selects CPU EP for
bounded dimension bookkeeping. All learned feature/image operations must be
native WebGPU. `cascade-metadata-extract.py` reads ORT 1.31.1's complete finalized
FlatBuffer snapshot without creating a new session; `metadata-audit.mjs` rejects
CPU feature data, incomplete maps, unknown assignments and metadata escaping
shape-control ports. `cascade-metadata-runtime.mjs` saves and audits that map
while the original session is alive, before model inference. Reloading the
snapshot or inspecting only a post-run profile cannot substitute for this proof.

```sh
refine_metadata=artifacts/research/refine-edge/NEW-METADATA-RUN
node scripts/research/refine-edge/cascade-metadata-runtime.mjs --manifest "$refine_followup/export/global/model-manifest.json" --pooling-manifest "$refine_followup/export/pooling/model-manifest.json" --output "$refine_metadata/audit-only"
node scripts/research/refine-edge/cascade-metadata-runtime.mjs --execute --manifest "$refine_followup/export/global/model-manifest.json" --pooling-manifest "$refine_followup/export/pooling/model-manifest.json" --output "$refine_metadata/global-execute"
"$research_python" scripts/research/refine-edge/cascade-pooling-export.py --stage local --source "$refine_study/cascade/source" --checkpoint "$refine_study/cascade/attempt-02/official-v1.0-model.pth" --output "$refine_metadata/export/local"
node scripts/research/refine-edge/cascade-metadata-runtime.mjs --execute --manifest "$refine_metadata/export/local/model-manifest.json" --pooling-manifest "$refine_followup/export/pooling/model-manifest.json" --output "$refine_metadata/local-execute"
npm run verify -- --target refine-edge-metadata
```

Commands document conditional stages, not permission to restart stopped research.
Create the parent evidence directory first; each output must be new. Without
`--execute`, the tiny pooling preflight runs to bind physical resource admission,
but full-model inference does not. The runtime has a 240-second owned-child
limit and no CPU image retry. Its saved audit, source/snapshot/map hashes,
worker bundle, profile and numerical receipt retain the exact session evidence.
ORT runtime and generated Python parser must both be version 1.31.1.

Only after both numerical stages pass, `cascade-photo.py` adapts the exact
upstream high-resolution algorithm to audited GPU forward calls. Native Torch
CPU preparation/tiling is an explicitly selected research stage; it never
constructs a CPU learned model. The helper currently reads the retained global
export and baseline from the earlier fixed evidence roots, and local export and
numerical receipts from `--study`. It records their hashes and does not imply a
self-contained production implementation. The exact prior source/corpus must
remain available; no photographic input or graph is fabricated on a cache miss.

```sh
timeout 600 "$research_python" scripts/research/refine-edge/cascade-photo.py --study "$refine_metadata" --id d08-flamingo --output "$refine_metadata/photo-d08"
node scripts/research/refine-edge/render-cascade.mjs "$refine_metadata/photo-d08/result.json" "$refine_metadata/proof-d08"
```

`--photograph` is internal to each audited call and requires a passed same-graph
synthetic numerical receipt. Photo outputs have no fabricated alpha reference
and cannot serve as synthetic numerical receipts. `render-cascade.mjs` retains
the frozen Fit/native crops, original SAM and Feather comparators, overlay and
diagnostic +1 EV views. Generated results remain private and unreviewed until
actual visual inspection; execution success never promotes quality.

The completed run is
`artifacts/research/refine-edge/2026-11-14-metadata-followup/`.
Both numerical stages passed; flamingo and robin ran with six and ten audited
learned calls respectively. The robin's retained upper mealworm selection left
the exclusion requirement unmet. Expansion stopped before fence, wig and the
full corpus. No further photo/model loop is part of this deliverable. Parent
image storage was conservatively added in a retained post-run admission
supplement for those small completed cases; future calls reserve it before load.
Model terms, broad quality, other-device execution and product integration remain
unqualified. No weights, exported graphs, photographs or proof images are added
to Git by these tools.
