# Strong-noise research checkpoint

This source-only checkpoint preserves the unfinished Comparison 7 work for a fresh
checkout. It does **not** enable a new application denoiser. Persisted NR version 1,
its output and all existing edit history remain unchanged. The professional-editing
goal remains active; see [the handoff](../../../docs/professional-editing-handoff.md).

`patchwise.py` estimates complete 3×3 patches under bounded 7×7 matching weights,
publishes 27 normalized scalar deltas per center to Float32, then gathers
overlapping estimates before the own-strength blend and stable inverse. The
full-source directional MAD estimator and rejected pixelwise comparator are in
`pixelwise.py`. These are original independent mathematical prototypes, separate
from application processing. Primary reference:
[Buades, Coll and Morel](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm).
No GPL implementation was imported.

## Current quality decision

The reserved sigma .10 / seed1 / maximum-strength colored-edge case now rejects
both narrow C7 policies: leakage3.453% and3.331% exceeds the unchanged3% limit.
Earlier passes and these failures remain preserved, including exact frozen-source
archives. The precision pass establishes numerical agreement, not photographic
quality or adoption. Every C7 deployable is currently rejected.

Comparison8 changes only the maximum chroma bandwidth:
`sqrt(.024² + k² * (varianceA + varianceB))`, using the same frozen whole-source
estimate. The finite hypotheses use k .40 and .55; luminance maximum remains .024.
The primary paper's `h = kσ` motivates the noise scale; our opponent coordinates,
variance sum, bandwidth floor, strength transfer and finite search remain authored
policies that require their own verification. No new self cap, patch radius,
guide, estimator, source amplitude or quality tolerance is introduced.

Its first screen is15 declared sources × four policies =60 measurements: four
maximum-noise cases at sigma .10, the prior sigma .08 colored edge, and five
nominal fine-detail/star cases in both primaries. Fixed C7 .040/.080 are rejected
comparators. All original nominal/color/high-noise gates remain mandatory;
C7's examined fresh seeds become regression, with separately declared new C8
fresh seeds. Both C8 hypotheses are now rejected under this protocol: after 320
nominal and two 128-measurement regression selections passed, the 128-measurement
fresh selection had four required failures. The same period-4 luminance input
realization failed for both factors and primaries: entering projection was about
1.060304, output about 1.060434, above the unchanged 1.05 limit. These are shared
noise realizations, not four independent observations or evidence favoring a
factor. The first screen's narrow pass does not override these failures.

The small nominal chart has 384 interior samples. For period-4 amplitude .03 and
independent Gaussian sigma .012, the clean-relative projection's noise standard
deviation is about .02887; its +5% ceiling is only 1.73 standard deviations from
identity. A larger, separately frozen texture population and candidate-independent
input qualification are proposed next. The optional `population` helper in
`cases.py` preserves nominal amplitude/noise while changing only periodic texture
geometry to 136 x 136. It is unfinished scaffolding: there is no C9 protocol,
qualification gate or runner selection, and no C9 sources or outputs were generated.
Original accepted small-chart regressions and all failed C8 receipts remain
required historical evidence. Never silently reinterpret C8 as accepted.

```sh
python3 scripts/research/strong-noise/run.py --comparison 8 --plan --stage screen
python3 scripts/research/strong-noise/run.py --comparison 8 --freeze
python3 scripts/research/strong-noise/run.py --comparison 8 --execute --declaration PATH --stage screen
```

C8 outputs stay under `artifacts/detail-research/strong-noise/comparison8/`.

The earlier local frozen study completed 88 initial measurements: narrow C .024/C .040
passed 22 selected cases each; broader C .080 failed four fine-color cases. Both
survivors then passed 160 nominal, 64 examined-seed regression and 64 fresh-seed cases
each. C .040 also passed 52 high-noise cases at σ .08 / seed 1 / both primaries / strengths 75 and 100.
These historical passes precede the required failures recorded above. Remaining
high-noise levels/seeds, GPU, native photographs, legacy compatibility, resources
and performance remain unverified. The precision evidence below establishes
numerical agreement only; these synthetic studies do not accept the application.

Original declaration SHA-256:
`6de48d3f65783c770226a56be8657c81dd496c9e4cc6447529baf4f7ec8687cb`.
Machine-local declarations, failed/successful outputs, source preparations and
logs remain under ignored `artifacts/`. This portable runner deliberately makes
no historical-output hash attestation from absent local reports. It preserves
the synthetic recipes, equations, numerical gates and holdout definitions.

Use Python 3.10 or newer. Plan selection before running expensive cases:

```sh
python3 scripts/research/strong-noise/run.py --plan --stage screen
python3 scripts/research/strong-noise/run.py --freeze
# Use the declaration path printed by --freeze:
python3 scripts/research/strong-noise/run.py --execute --declaration PATH --stage screen
```

`--plan` creates no artifacts. Freeze/execution write only under
`artifacts/detail-research/strong-noise/`; execution uses the shared verification
lock and does not launch Electron or import a library. The policy/recipe
selection is explicit, and a mandatory failed gate rejects that candidate. A
research driver exit 0 means the requested measurements finished; inspect its
`summary.json` failures before interpreting results. There is no automatic
winner or adoption.

`reference/` contains a separately derived direct Decimal80 generator, input plan,
integer binary32 rounding vectors and a strict comparison checker. The explicit
`strong-noise-reference` target now passes the converter's 1537 vectors and all15
synthetic recipes for the selected C .040 candidate. It verifies exact stage
words, strict pre-final and final RGB, whole-grid alpha/transparent/neutral copies,
hidden RGB independence, tiny/subnormal common-alpha scaling and one-axis cases.
The two selections contain414 and322 configurations, with one shared pair anchor;
these counts overlap. C .024 is not covered by this executed precision selection.
This does not prove GPU, full-source, estimator, photograph or quality holdouts.
The separate `strong-noise-scaled-reference` target also passes all 15 recipes
for both C8 factors, including independent Decimal80 bandwidth compilation and
exact stage words. Numerical agreement and quality rejection are separate results.

`src/shared/detail-noise-estimate.ts` is a bounded CPU foundation for the frozen
whole-source directional MAD estimate, independently checked by the registered
`strong-noise-estimate` target. It is not selected by public noise reduction.
The caller owns source authenticity, immutable leases and source/cache admission;
the estimator charges only its own numeric storage and records supplied provenance.

The independently reviewed numerical revision uses
`normalized-patch-estimates-f32-zero-v1`: only a published E value that rounds to
zero is canonicalized to positive zero. Original RGBA/alpha copies and the generic
IEEE converter preserve signed zeros. The Decimal oracle retains tiny exponential
contributions instead of imposing an arbitrary -300 cutoff. Bounds alone round
outward. Quality settings and all RGB/quality tolerances remain unchanged. The
original local C7 declaration/code/results stay intact; source/output
correspondence must be checked when relying on those prior results.

Run the explicit reference target without a desktop window:

```sh
npm run verify -- --target strong-noise-reference
```

Every generated reference binds its exact plan, generator and equation hashes.
The registered target stores fresh outputs under its ignored verification run;
no generated reference is automatically committed or treated as adoption.

Original research equations and synthetic recipes follow the existing CC0-1.0
reference-generator convention. No photographs or generated evidence are stored
here; the reviewed camera originals and permission notices are under
`assets/tests/images/raw/sony-zv-1a/`.
