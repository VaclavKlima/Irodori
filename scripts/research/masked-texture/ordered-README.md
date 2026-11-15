# Ordered masked Texture proof

Internal research for [#80](https://github.com/VaclavKlima/Irodori/issues/80),
following the [integration design](../../../docs/features/masked-texture-integration.md).
No application setting, worker command, UI/history migration, public capability
or complete preview/export integration is enabled by these tools.

## Reproduction

Use Node 24+, installed dependencies and the repository's native/build
prerequisites. The compiled preview worker is required for the real photo;
the registered verification builds it. Use fresh output directories with an
existing parent; retain generated evidence outside Git.

```sh
npm run verify -- --target masked-texture-order-model --target masked-texture-order-gpu
node scripts/research/masked-texture/order-run.mjs --stage numeric --output artifacts/masked-texture/my-ordered-numeric
node scripts/research/masked-texture/order-run.mjs --stage photo --numeric artifacts/masked-texture/my-ordered-numeric --output artifacts/masked-texture/my-ordered-photo
```

The first command already creates a full numeric receipt under its GPU test's
`numeric-run/` output directory. Reuse that path as `--numeric` instead of running
the second command when the processing bundle/protocol/dependencies are unchanged.
For an implementation failure rerun only its exact numeric case first with
`--case CASE_ID`; that produces `passed-case`, never a full photo prerequisite.
Each owned run has a ten-minute limit and process-group cleanup. No window opens.

The active protocol is `assets/tests/references/masked-texture/order-protocol-v2.json`.
It pins 14 procedural cases, the independent generator/dependencies, unchanged
LLF policy and prospective photo controls. The photo requires the full passing
numeric receipt and identical bundled implementation/lockfile. No failed,
partial or differently compiled proof can unlock it. Source/output overlap is
refused for the original; originals and earlier evidence are never overwritten.

## What runs

- `ordered-point.mjs` reuses the actual production global-point and local-mask
  WGSL declarations. Explicit layouts support unused precision bindings; GPU
  errors are checked before accepting readback. No CPU point/filter counterpart
  is introduced.
- `ordered-core.mjs` obtains **unblended** Texture by running the unchanged
  `gpu.mjs` with full coverage. It drains that owner before applying shared
  Balance → Light → saturation → one final root blend. It evaluates actual final
  coverage and skips spatial work for zero/disabled/empty Texture. It retains
  the extra unblended candidate and charges it rather than claiming a fused
  two-prefix implementation.
- A final GPU selection preserves the single-pass shared point-prefix words
  outside the Texture union and at alpha zero. Per-root zero-coverage/alpha and
  Texture-only hidden-RGB checks remain separate. Existing Light/Color can change
  hidden RGB; Texture must not bypass those legacy point semantics.
- `ordered-consumer.mjs` invokes the **unchanged** production `createPointGpu`
  for the actual legacy native output. A separate research adapter keeps the
  actual rendition math and selects prepared pre-rendition RGB explicitly using
  the known unused uniform lane. The old point expression remains runtime-live
  for its existing binding layout; neutral adjustments are not used as a fake
  render-only contract. The exact seam/flag layout is checked and recorded.
- Another GPU word selection restores actual native legacy output outside the
  union/at alpha zero. Both native Float32 SDR RGB and packed RGBA8 are checked.
  Visible inside-union words must equal the candidate and must actually differ
  from legacy somewhere; an all-legacy output cannot pass unnoticed.
- Prepared lineage binds the original Float32 hash, grid policy, dimensions,
  geometry/point context, ordered Texture amounts and prepared data hash. Wrong
  parent/context and resource/domain/alpha refusals are explicit.

The tests independently read saved Float32 arrays, union, raw/legacy working
prefixes and actual consumer evidence. CPU reference math is restricted to small
procedural arrays: Decimal80 point math, scalar float64 LLF and independent
Hermite crop interpolation. No CPU implementation processes a photograph.

## Fixture correction and retained failures

`order-protocol-v1.json`, its reference and generator remain unchanged. The first
GPU run stopped on unused scene precision binding 3; the explicit-layout/error
reporting correction passed its exact failed-case rerun. A later registered run
passed ten numeric cases, then rejected a synthetic local exposure of 0.125 EV:
the real application accepts hundredths. That invalid setup produced no filtered
output for the rejected case.

Version 2 corrects only four generator exposure sites to 0.12 EV, expanded into
eight fields across four cases. It retains every source pixel, root/mask/crop,
Texture strength, method, tolerance and photo control. The other ten cases and
negative-control witnesses are identical. Actual production validators now
preflight all numeric/refusal/photo controls, and tests preserve v1 as a negative
contract witness. This was an input-contract correction, not output-driven tuning
or a relaxed validator. Both versions and all failed runs are retained.

## Checkpoint — 2026-11-15

RX 7900 XTX / RADV Mesa 26.2.6, background isolated Dawn:

- 14 independent GPU cases pass, including overlapping/reordered roots, active
  global/local Light/Color, two spatial roots, zero/disabled/empty bypass,
  signed/above-white and partial/hidden alpha. Three cases also pass actual GPU
  odd-origin crop, quarter-turn and 7° straighten plus canonical coverage mapping.
- 28 actual native-consumer checks pass, with separate working-prefix and
  actual rendered-output guards. Wrong parent/context, post-global domain,
  invalid alpha and exhausted resource budget refuse explicitly.
- Registered model/GPU targets: **1,078 passed, zero failures/skips, 81.61 s**,
  including ordinary cheap/static checks. The routine 60 s warning is retained;
  assertions were not cut and no performance acceptance is inferred.
- The same bundle's gated 2344×2708 flamingo proof takes **6.69 s**, executes
  three Texture roots with the frozen active Light/Color context, and preserves
  **5,948,928** outside-union pixels exactly in the working-prefix and native
  actual-consumer comparisons. Four untouched controls also pass. The original
  source, manual masks and native crops are unchanged.
- Its self-contained gallery has nine native crops plus three Fit images.
  The isolated HTML-only check loads all 12 images, verifies PNG/embedded receipt
  hashes, native sizing and Fit toggle without missing requests or script errors.
  Compare **active Light/Color legacy** with **active Light/Color + ordered
  Texture**. Original Neutral also omits the selected point edits and is context.

Evidence: `artifacts/masked-texture/2026-11-15-ordered-proof/summary.md`; final
registered verification lives at
`artifacts/verification/2026-11-15T10-29-20.815Z-check-q48nHx/summary.md`.
No commit/push, foreground run or full checkpoint was selected.

### User review — 2026-11-15

The user prefers **Active Light/Color + ordered Texture** for feathers, ripples,
reflected legs and the overall Fit view. The exact feedback and reviewed gallery
hash are retained in the proof root's `user-feedback-01.json`; `user-review.md`
records the scoped conclusion without rewriting earlier technical receipts.
This supports the frozen combination on this photograph. It does not establish
absence of halos/color shifts, broader quality, a new default strength or full
app integration; the earlier skin/foliage findings remain unchanged. No controls,
sources or masks were retuned. Shared preview/export consumed-stage integration
is the proposed next deliverable and is not selected by this feedback alone.

## Explicit limits

This is an internal shared-point/rendition seam proof, not new production
`PreviewProcess`/export-service integration or a persisted `PreparedMaskStack`
API. Global WB/curves/mixer/grading and vibrance are neutral in this matrix;
white is 1. The scene-linear cases feed the actual **SDR** rendition: native HDR
planes, headroom/encoding metadata, authored HDR/SDR pairs, Electron presentation,
histogram/analysis consumers and other adapters/devices remain unqualified.
Only analytic radial coverage is exercised; bases/ranges/edges are explicitly
refused by the research helper. General masks, worker publication/cancellation,
cache reuse, frozen exports, UI/history/restart and interactive speed require
their own selected delivery. Tiny transformed cases do not imply a full-source
transformed-photo or tiled/composed-halo pass.

Full-frame admission still uses unchanged Automatic RAM/conservative 2 GiB GPU
policy and actual buffer limits. Source, current/probe/global/candidate/readback,
coverage/union, compatibility prefix/native outputs and codec ownership are
charged. A 24 MP ceiling is not a promise of admission. No CPU feature fallback,
precision repair, clipping/normalization or lower-resolution retry is available.
The photograph was inspected for obvious insertion artifacts and the scoped
user preference is recorded above; broader visual quality and the user's
earlier limited preferences are not silently promoted.
