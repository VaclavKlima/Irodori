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

The local frozen study completed 88 initial measurements: narrow C .024/C .040
passed 22 selected cases each; broader C .080 failed four fine-color cases. Both
survivors then passed 160 nominal, 64 examined-seed regression and 64 fresh-seed cases
each. C .040 also passed 52 high-noise cases at σ .08 / seed 1 / both primaries / strengths 75 and 100.
The other high-noise levels/seeds, independent precision, GPU, native photographs,
legacy compatibility, resources and performance remain unverified. These are
synthetic research results, not a new application acceptance pass.

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

`reference/` contains an **unexecuted** separately derived direct Decimal80 draft,
its input plan, integer binary32 rounding vectors and a strict comparison checker.
No reference-generation approval is included in this checkpoint: a new approval
must bind the current generator, plan and equation hashes. The checker retains
the strict pre-final-RGB tolerance and exact intermediate-word assertions. Do not
claim its planned transparency/HDR/scaling coverage as completed verification.

Original research equations and synthetic recipes follow the existing CC0-1.0
reference-generator convention. No photographs or generated evidence are stored
here; the reviewed camera originals and permission notices are under
`assets/tests/images/raw/sony-zv-1a/`.
