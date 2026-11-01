# C11: chroma-only uniform spatial weighting

This prospectively declared, unenabled hypothesis follows the required failures
of both C9 noise-scaled policies and the separate C10 mean guard. Those failures,
sources, thresholds and declaration epochs remain unchanged. No C11 quality or
application acceptance is claimed here.

## One changed factor

Retain C9 k .40's signed source features, frozen whole-source MAD estimate,
7x7 search, 3x3 matching patch, corrected distances, .024 luminance maximum,
.024 chroma floor, k .40, strength transfer, Float32 per-center stage, overlap
aggregation and inverse. Luminance uses its original Gaussian spatial prior and
original corrected chroma guide. Chroma alone removes the spatial Gaussian:

```
w_L = exp(-(dx^2+dy^2)/8)*alpha[q]
      *exp(-D_L/h_L^2-D_C/.12^2)
w_C = alpha[q]*exp(-D_L/.08^2-D_C/h_C^2)
```

This is an authored separate-channel policy. The
[primary NLM presentation](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm)
motivates testing patch-distance weighting within a bounded search, but its
search dimensions and self weighting differ from ours. Its results do not prove
this variant. No third-party implementation is imported.

The d=0 self contribution remains one before alpha factors. Nonzero offsets that
clamp onto the same source sample gain mass under the new prior; do not claim
unchanged total boundary self weight or silently deduplicate those offsets.
Opaque constant, neutral, transparent and C=0 paths must retain their declared
copy/identity behavior. Do not include C10's mean guard or change a coefficient
after observing a result.

Removing the prior increases relative support from more distant candidates. It
also increases distant incorrect matches; no bias, detail or residual improvement
is guaranteed. The existing support/halo, three GPU passes, 27-scalar stage and
six buffers remain sufficient. New code and occupancy still require measurement.

## Independent arithmetic before filtering

Generate separate Decimal80 full-operator references, not C9 outputs relabeled as
C11. Direct patch sums, normalized center estimates, binary32 publication and
final gathering/inverse must be checked against the existing fixed numeric
bounds. Include both primaries, signed/HDR, all-zero and asymmetric controls,
global clamping, one-dimensional geometry, transparency and tiny positive alpha.
Check all supported C=0 outputs against the unchanged C9 k .40 policy exactly.
Explicit Gaussian/default GPU behavior must retain its old shader and pixels.
Tiny-alpha GPU limitations remain explicit until equivalent recovery is proved.

The research child must bind its spatial policy explicitly, reject unsupported
values or cross-request policy switches, and report it. No implicit production
selection, additional image planes or public NR version change is authorized by
this declaration.

## Finite examined regression screen

[comparison11.json](../../../../../scripts/research/strong-noise/comparison11.json)
declares one candidate and 44 already examined inputs, not new holdouts:

1. Eight edges: sigma .10, seeds 1/0xDEADBEEF, strengths 75/100 and both primaries.
   Complete all eight before judging the stage, including its passing anchors.
2. Twenty-four high-noise flat cases: luminance, chroma and mixed; sigma .10,
   both seeds, strengths and primaries above.
3. Twelve qualified texture regressions: L periods 2/4 and A/B periods 2/4,
   both primaries, seed 0x85EBCA6B and original nominal noise/controls.

Reuse saved clean/entering Float32 words and full-source estimator descriptors.
Freeze equations, reference/driver/runtime and input hashes before filtering.
Keep every old metric mandatory, including edge leakage <=3%, the original
noise/bias gates and texture retention 0.90..1.05. A required failure rejects the
candidate and prevents later stages; a numerical mismatch blocks quality claims
until diagnosed. Preserve every result, including failures.

Passing the screen does not establish adoption. All original regressions, the
full high-noise/dosage matrix, prospectively frozen unseen inputs, independent
CPU/GPU equivalence/recovery, photographic review, compatibility, full-source
resources and sustained responsiveness remain required. Original NR v1 edits,
pixels and history remain unchanged.

Original numeric equations/recipes follow the adjacent CC0-1.0 reference notice.
