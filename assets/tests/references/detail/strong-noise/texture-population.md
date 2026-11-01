# C9: prospective texture-population methodology

This is a separately declared source-population measurement for the unchanged C8
mathematics. It is not a new denoiser, an acceptance claim or a reinterpretation
of C8. Both C8 candidates remain rejected under their original frozen protocol.
Their small fresh sources, required/cohort labels and failed results remain
unaltered. Original accepted 32x24 nominal, C4 and C7 regressions stay mandatory
with the same sources, strengths, metrics and quality limits.

The old nominal interior contains 384 samples. For period 4, amplitude 0.03 and
intended independent Gaussian sigma 0.012, the entering clean-relative amplitude
projection has standard deviation `sigma/(A*sqrt(N/2))`, about 0.02887. Its +5%
ceiling is only about 1.73 standard deviations from identity. This is a noisy
clean-restoration score; it does not by itself isolate an operator's contrast
gain. [NIST's centered least-squares formula](https://www.itl.nist.gov/div898/handbook/pmd/section4/pmd431.htm)
gives the corresponding slope expression. The calculation is an IID design
approximation, not a certification of PRNG independence or nonlinear output noise.

[comparison9.json](../../../../../scripts/research/strong-noise/comparison9.json)
freezes two new seeds, `0x85EBCA6B` and `0xC2B2AE35`, both primaries, sigma 0.012,
and scene-specific strength 50. Only luminance periods 2/3/4/6/8 and opponent A/B
periods 2/4 use 136x136 nominal grids: 36 sources with 128x128 metric interiors.
Period-2 amplitude remains 0.024 and all other periodic amplitudes remain 0.03.
The other 28 fresh sources remain 32x24, including their original star positions,
edge geometry and boundary recipes. Enlarging a texture never selects the
high-noise generator branch. All four border pixels and all quality limits,
including clean-relative texture retention **0.90–1.05**, remain unchanged.

At the larger period-4 interior, the same input projection SD is about 0.004419;
the unchanged upper gate is about 11.31 SD away. Other periods use their actual
centered pattern energy. This improves the measurement's ability to separate
input phase noise from transfer effects. It does not stabilize unrelated edge
column means or individual star peaks automatically, relax another gate, or
replace native photographic review and resource/performance acceptance.

Before **any C9 candidate import or filtered output**,
[qualification.py](../../../../../scripts/research/strong-noise/qualification.py)
must generate and qualify all 64 declared fresh inputs using only the source
recipes and baseline coordinate/metric model. It records complete clean and
entering Float32 hashes, dimensions and unchanged identity texture projections.
Nontexture inputs retain source/geometry validation; identity is not expected
to satisfy a denoising residual gate. No candidate or source estimator runs.

Any applicable identity texture failure blocks the entire C9 study. Do not
discard failing inputs, choose alternate seeds, subtract phase noise, normalize
amplitudes or repeatedly qualify until a favorable population appears. Both the
qualification and all filter invocations use frozen source pins and the shared
invocation lock. Every C9 filter invocation requires a successful receipt and
its explicit SHA-256 from the same declaration; selected fresh sources must
regenerate both source hashes before filtering. Partial candidate/stage runs
remain partial, and alternatives are not silently accepted.

Plan without creating source images or artifacts:

```sh
python3 scripts/research/strong-noise/run.py --comparison 9 --plan --stage fresh-population
python3 scripts/research/strong-noise/qualification.py --plan
```

After reviewing source and declaration, the research owner may explicitly freeze
and execute qualification, inspect its receipt, then invoke a selected filter
with `--qualification RECEIPT --qualification-sha256 SHA256`. Generated input
charts, receipts, failed evidence and outputs stay under ignored `artifacts/`.
No qualification, C9 source/output or acceptance is claimed by this document.

The original synthetic recipes and numeric methodology follow **CC0-1.0**, as
documented in the [adjacent notice](README.md). No photographs or application
code are relicensed by this numeric-reference notice.
