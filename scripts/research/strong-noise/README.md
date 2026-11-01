# Strong-noise research checkpoint

This source-only checkpoint preserves the unfinished Comparison 7 work for a fresh
checkout. It does **not** enable a new application denoiser. Persisted NR version 1,
its output and all existing edit history remain unchanged. Further strong-noise work is separately scoped by TODO #39; see
[the task index](../../../docs/features/professional-editing.md).

Candidate study suites require an explicit `npm run verify -- --target <id>`
selection. Normal `--full`/`--all` runs retain production detail-quality checks
and the cheap `strong-noise-study-audit` guard, but do not rerun unadopted methods,
known rejected candidate quality gates or studies needing local approval evidence.
An explicit candidate run retains every original assertion and failure threshold.

`patchwise.py` estimates complete 3×3 patches under bounded 7×7 matching weights,
publishes 27 normalized scalar deltas per center to Float32, then gathers
overlapping estimates before the own-strength blend and stable inverse. The
full-source directional MAD estimator and rejected pixelwise comparator are in
`pixelwise.py`. These are original independent mathematical prototypes, separate
from application processing. Primary reference:
[Buades, Coll and Morel](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm).
No GPL implementation was imported.

## Current quality decision

All tested C7–C14 adoption candidates are rejected by mandatory quality gates.
Their independent numerical passes remain valid for their exact scopes, but
do not enable a stronger public denoiser. C13 clears two previously failing
edges, then fails four required anchors at 3.396–4.301% leakage against the
fixed 3% limit. All eight declared edge cases completed; later flat/texture
stages did not run. C14 then completes its first two edges but fails both at
3.1373% leakage against the same 3% limit; its later 6/24/12 stages stop. Keep the
full feature goal active.

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
geometry to 136 x 136. The separate [C9 methodology](../../../assets/tests/references/detail/strong-noise/texture-population.md)
and `comparison9.json` now declare the entire fresh population. Before any C9
candidate import, `qualification.py` must qualify all 64 inputs without candidate
code and bind their exact clean/entering hashes to the reviewed declaration.
Every `run.py --comparison 9 --execute` requires that successful receipt and its
explicit SHA-256. The declaration records no executed qualification or output;
later run evidence belongs in the processing ledger and ignored artifacts.
Original accepted small-chart regressions and all failed C8 receipts remain
required historical evidence. Never silently reinterpret C8 as accepted.

The qualified C9 fresh population passed for k .55, and its 64 GPU results agreed
with the frozen CPU outputs. The later high-noise GPU run was interrupted after
410 of 624 measurements, but already contains four mandatory color-edge failures
against the unchanged 3% limit. A separate archived-source CPU replay reproduces
all four failures and agrees with every retained GPU channel. In the strongest
case the input passes at 2.56% and filtering worsens it to 4.17%. The k .55 policy
is therefore rejected; neither GPU precision nor a different texture population
explains those failures. Do not resume its rejected matrix or edit historical
declaration pins after the camera/documentation updates. Detailed receipts and
the prospective next-policy rationale belong in the processing ledger.

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

`gpu.ts` / `gpu-wgsl.ts` provide an **unenabled, noise-only research GPU owner**.
It uses three passes, a 256-pixel tile, halo 5 and 27 scalar Float32 estimates per
center. Six reusable buffers total 11,550,384 bytes; conservative owned numeric
storage including the source copy, returned tile and uniform is 13,731,184 bytes.
The caller separately admits and protects its complete source. It does not
estimate from a tile or change public v1 settings/pixels. Tiny positive alpha
below 2^-20 is explicitly refused pending equivalent Float64 recovery.

The first scoped hardware checks matched 558 independent Decimal80 configurations
(5,298 RGB channels; largest tolerance ratio below .009) on the RX 7900 XTX, with
132 required tiny-alpha refusals. Whole/tiled output is bit-identical on an
additional signed/HDR fractional-alpha chart. Admission/neutral/cancellation and
image limits also have focused checks. These small vectors do not prove noise
quality, full-source performance, recovery or integration. Run the explicit
`strong-noise-gpu` target; the initial impossible-dimension test and corrected
exact-case rerun remain preserved in local evidence.

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

## Retained-run failure audit

`gpu-study.py` now records cumulative mandatory failures with every durable result
and reconstructs terminal reporting from complete retained rows after child
cleanup, including interruptions. It also reconstructs the CPU evidence descriptor
from its pinned CPU rows before launching a GPU child. New execution requires new
source pins; old declarations and outputs stay unchanged.

The standard-library-only audit command reads a retained run and writes to a
separate fresh directory. It imports no candidate, estimator or GPU:

```sh
python3 scripts/research/strong-noise/study-audit.py --run-dir /path/to/retained/run --output-dir /path/to/new/audit-directory
npm run verify -- --target strong-noise-study-audit
```

The report retains mandatory/CPU-agreement failures, malformed or interrupted
tails, incomplete selections, recorded child closure and before/after metadata
hashes. It refuses an existing output directory or one inside the original run.
Interrupted/rejected data returns exit 1. The audit reports recorded gates rather
than revalidating source content or photographic quality; it cannot adopt an
operator or turn an unfinished study into a completed one. Numerical CPU/GPU and
photographic acceptance remain separate.

## Rejected C10 diagnostic

The separate `comparison10.json` and
[mean-guard policy](../../../assets/tests/references/detail/strong-noise/patch-mean-guard.md)
freeze an authored covariance-corrected chroma patch-mean floor. The independent
Decimal80/rational helper checks pass, including overlapping/clamped/fractional
coverage and tiny positive alpha. The first four-case filtering stage nevertheless
fails all four unchanged 3% edge gates (3.523892–3.902423%). C10 is rejected;
later flat/texture stages and a GPU port were not run. The failed declaration,
source/input pins and outputs remain under ignored artifacts. Public NR v1 and
every C7/C8/C9 rejection remain unchanged.

The subsequent newly frozen C9 k .40 eight-case edge selection also failed four
required gates (3.268155–3.376292%). Exact archived CPU replay reproduces them and
matches the GPU. Both C9 noise-scaled policies are rejected; their earlier fresh
or screen passes remain insufficient. Preserve all source/input/output pins and
do not continue their matrices or reuse a rejected subset as acceptance.

## C11 chroma-only uniform spatial hypothesis

`comparison11.json` and the [uniform-search policy](../../../assets/tests/references/detail/strong-noise/chroma-uniform-search.md)
declare one unenabled candidate that removes only chroma's Gaussian spatial
multiplier inside the same bounded search. Luminance retains its Gaussian prior
and original chroma guide. The separate CPU module and independent Decimal80
full-operator reference are implemented; no public operator version changes.

The explicit `strong-noise-chroma-uniform` target passes four service cases:
108 core, 84 alpha, 12 asymmetric and 180 C=0 identity configurations. It checks
1,908 pre-final/final RGB channels each and 50,058 exact published stage words;
the C=0 comparisons also preserve 87,750 old-C9 stage words exactly. The
asymmetric checker rejects a Gaussian-chroma substitution. These are small
numerical proofs, not quality acceptance. Including shared cheap/static/build
checks, the run passes 875 checks in 69.92 seconds; its routine budget warning
and evidence remain at `artifacts/verification/2026-10-30T13-39-32.604Z-check-yzpvdy/`.

The separately frozen first eight-edge CPU stage completed in 69.832 seconds
with four required leakage failures (3.081310–3.322926% versus the unchanged
3% limit). **C11 is rejected**. Its passing mathematical checks do not override
this result. The other edge gates and frozen pins pass; later flat/texture
stages and GPU execution were not run. Prospective GPU source/tests remain
unexecuted research. The failed initial invocation-helper preflight and separate
repaired declaration are preserved in the processing ledger. No photograph,
fresh holdout, resources, performance or application acceptance is established.

## C12 wider-chroma hypothesis rejected

`comparison12.json`, `chroma-wide-patchwise.py` and the
[wider-search policy](../../../assets/tests/references/detail/strong-noise/chroma-wide-search.md)
retain luminance's radius3 Gaussian behavior and test chroma radius10 uniform
support. The independent `strong-noise-chroma-wide` target passes120 core,
84 alpha,12 asymmetric and180 C=0 identity configurations, including an explicit
farther sample and wrong-radius/Gaussian counterfeits. Old public NR v1 remains
unchanged.

The separately frozen eight-edge CPU stage nevertheless fails two required
gates: seed `0xDEADBEEF` at strength100 leaks3.9534937% /3.9534908% in the two
primaries. All eight cases completed in700.397 seconds on one low-priority
Python worker; six passed. Input/output hashes, source copies and all fixed
limits remain unchanged. The longer search does not qualify the candidate.
Later flat/texture stages and GPU execution were not run. No production
performance, photographic or application acceptance follows from this screen.
See the processing ledger for declarations, failed outputs and next diagnosis.

## C13 larger matching context rejected after anchor regressions

`comparison13.json`, `chroma-context-patchwise.py` and the
[matching-context policy](../../../assets/tests/references/detail/strong-noise/chroma-matching-context.md)
change only chroma matching from 3x3 to 5x5. The radius 10 uniform chroma search,
3x3 targets, original luminance arithmetic, estimator, coefficients and every
quality limit remain unchanged. Source halo 13 includes matching context beyond
the unchanged L3/C10 proposal bounds.

The explicit `strong-noise-chroma-context` target passes 132 core, 84 alpha,
12 asymmetric and 180 C=0 configurations, with 2,052 strict pre-final RGB
comparisons and 58,158 exact stage words. All-grid L identity and old C=0
properties pass; five wrong matching/search/spatial/context operators fail
actual numerical comparisons. The complete target includes 875 passing checks
in 179.78 seconds and retains its routine duration warning.

The prospective quality screen retains the exact 44 previous inputs and gates,
independently verified by hashes, estimator objects and metric records. Its
first two cases are the known C12 failures. All six other edges, 24 flats and 12
textures remain mandatory after passing prior stages. The frozen hard stage
passes 2/2 in 182.882 seconds, with leakage 2.994219% / 2.994215% against the
unchanged 3% limit. Both are the same examined realization in different primaries.
Independent saved-output metric replay agrees exactly; all 196 pins and 58
archived copies remain intact. The remaining six anchors complete in 563.382
seconds with four required leakage failures: seed 1 at strengths 75/100, both
primaries, 3.396–4.301% against the same 3% limit. Rows 4/6 and all other edge
gates pass. Independent output/metric/source audits confirm the rejection;
all eight edge cases completed. No later flat/texture stage or GPU execution ran.
Public NR v1 stays unchanged.

The retained-output diagnosis places the failing error before the inverse,
largely retaining a noisy boundary column's mean chroma error. Clean-step
geometry also shows that matching5/target3 removes the flat-side center family
available to matching3/target3 at the first edge columns. A reviewed direct
boundary diagnostic now measures that restriction: row 0 right same-column mass
increases 66.13% to 98.23%, other same-side-column mass falls 32.00% to 0.86%.
It verifies 1,024 owners/2,048 components against retained outputs in about
16 seconds, with no filter import or alternate RGB output. All 322 pins and
reconstruction/decomposition checks pass. See the processing ledger for scope,
arithmetic assumptions, hashes and retained signed contributions.

## C14 complete chroma patches rejected

`comparison14.json` and the
[complete-patch policy](../../../assets/tests/references/detail/strong-noise/chroma-full-patch.md)
declare one change: estimate and gather the full 5x5 chroma patch, retaining
C13's matching/search, coefficients, estimator, inverse and original luminance.
The active semantic stage is L9+C50=59 Float32 words, source halo 14 and unchanged
L3/C10 proposal bounds. C=0 retains the exact old C9 route. All 44 examined
inputs and every gate remain mandatory. The restored flat-side center family is
only one of five; improvement is unproven. The explicit
`strong-noise-chroma-full` target passes all four reference groups and six
numerical counterfeits, 875 checks in 410.57 seconds. This covers 2,088 strict RGB
components and 226,678 exact semantic stage words, old raw C0 identity and
whole-grid unchanged L. Routine timing warnings remain.

The frozen first quality stage completes **2/2 edges in 264.406 seconds**, on
one low-priority CPU worker. Both fail `edgeLeakage <= 0.03`:
`0.031373091629910886` / `0.03137312234449121`. **C14 is rejected**; later
6/24/12 stages and a C14 GPU port stop. All 202 pins, 64 archived copies and
both output hashes verify unchanged; cleanup releases the owned lock with zero
children and no execution error. Evidence:
`artifacts/detail-research/strong-noise/c14-full-patch-screen-draft-kzUT9uyq/run-context-edge-regression-h8gqmt_m/summary.md`.
All 44 examined cases and every original gate remain required. The numerical
pass establishes arithmetic only; public NR v1 remains unchanged. No
photographic, resource, GPU, performance or public adoption is established.
See the processing ledger for exact receipts and source-only GPU resource limits.

## C15 pilot-guided pointwise chroma: arithmetic passed, quality pending

The [prospective policy](../../../assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md)
and `comparison15.json` select one experiment after rejected C14. A fixed
pre-inverse C14 feature estimate guides pointwise similarities; the final
chroma estimate averages original feature values. Original L feature proposals
and the exact C0 legacy route remain unchanged. The source-reviewed
`chroma-pilot-pointwise.py` implementation is research only, disconnected from
application edits. Its complete arithmetic selection now passes; photographic
and public adoption remain unaccepted.

The independent verifier and `strong-noise-chroma-pilot` service target now use
separate Decimal80 mathematics and a host-Float64 publication graph. Exact guide/pilot/final words, publication
representability, coefficient bits, original alpha, L/C0 identity and unchanged
RGB tolerances remain required. Host-runtime/libm agreement is not a portable
correct-rounding theorem. The new source halo is 24, or 33 when composed with
maximum sharpening; existing resource admission is not sufficient by default.

All 44 retained quality cases and their original gates remain mandatory. The
first C15 retained-quality stage passes, but an alternate-seed edge in the next
stage fails: **C15 is rejected for adoption**, as recorded below. A GPU port and
production adoption are not supported. The earlier publication-only case passes its 15 guide, 15 delta and 15 normalization
seams plus six independent coefficient words in 0.85 seconds overall; this
does not exercise the denoising operator. Its external reviewed freeze contains
only the `publication` group; core generation under that freeze is refused.
The separately reviewed complete target now passes **876 checks in 849.71
seconds**, with no failures/skips/interruptions, including 156 core, 84 alpha,
12 asymmetric, 180 identity and 15 publication configurations and the declared
numerical counterfeits. Summary:
`artifacts/verification/2026-10-31T08-49-21.018Z-check-FBppKa/summary.md`.
Its `IRODORI_C15_NUMERIC_APPROVAL` grants all five groups; the earlier scalar-only
approval does not. The duration warning remains and is not a production timing.
The user authorized CPU research while playing; GPU and desktop work remain held.

The C0/original-L compatibility proof is against C9 research, not shipped public
NR v1's `.048/.16` bandwidth policy. Preserve every old v1 edit and snapshot.
Versioned adoption, migration, cache identity, frozen exports/batches and
capability/resource changes remain design-only.

`pilot-screen.py --plan` previews the unchanged 2/6/24/12 retained sequence
without creating artifacts or importing a candidate. A quality freeze requires
all five actual numerical groups and eight meaningful counterfeits, the complete
registered-target result, full runtime/source identity and an independent
44-record selection receipt. A publication-only approval returns incomplete
exit 2 before archive or invocation creation. The source-reviewed driver retains
exact prior-receipt ancestry and separate computation/archived metric models.
No quality execution is implied by its metadata preflight.

The separate `strong-noise-pilot-screen` target initially passed five isolated
ownership/save cases in 1.54 seconds. With the destination regression below,
the registered target passes **877 checks in 47.80 seconds**, including six
isolated guard/assembly cases, with no failures/skips/interruptions:
`artifacts/verification/2026-10-31T09-18-36.205Z-check-lBMG5B/summary.md`.
Its fake lock namespace never uses the repository invocation lock or a
processing runtime. This is guard verification, not filter cancellation or
quality acceptance.

The first complete quality freeze failed its destination contract: a retained
source-loop variable shadowed the output directory, overwriting the old C9
`comparison9/run-jtxn_2oh/declaration.json` and placing 81 new source files there.
The bad freeze is rejected; no candidate filtering started. Root preserved the
incident evidence and restored the original declaration exactly, SHA
`fda6afcce721ebbfbbe4c9a5718b94d6a5f3337a43566a13c570b08de4e909b0`.
Recovery verification rechecks 221 freeze pins, 158 selection-evidence items and
192 original C9 files; the original archive is unchanged and the extra source
directory is absent. Evidence:
`artifacts/detail-research/strong-noise/c15-freeze-recovery-et2u8g1x/recovery-verification.json`.
The misdirected declaration/files remain quarantined. The independently reviewed
fresh-destination fix is now published at driver SHA
`d27c0f57b23a842d016eabbfd6030f9da347c7cf6f9b985881f387a8ff3386fc`.
One actual archive-assembly regression passes 1/1 in 0.812 seconds:
`artifacts/verification/playwright-1793438308691-525247d0-d0d6-4a5a-bf65-ff1b664fd966/playwright/summary.json`.
The corrected candidate-free freeze contains 44 records, 221 pins and 81 source
copies, with its own invocation lock retired:
`artifacts/detail-research/strong-noise/comparison15-retained/freeze-k7yqo6oi/declaration.json`,
SHA `9709b26a1f0132278a66de13235d27b6620dd9f5eff119fdfbfbfe935aa3843b`.
Independent read/hash review passes all pins/copies, full record/stage order and
mathematical bindings/proofs, with the original C9 evidence unchanged. The first
two retained edges pass 2/2 in 328.111 seconds, with leakage
`0.021970112987365398` / `0.021970128139770333` against the unchanged `0.03`
limit in sRGB / Rec.2020:
`artifacts/detail-research/strong-noise/comparison15-retained/run-context-edge-regression-egtqw4ge/summary.json`,
SHA `2ed460d890326ae08a8c33fae4d0395519b68e79ecf25a11923c49250e86cb1d`.
The six remaining edge anchors use that exact predecessor. Row 4 (alternate
seed, sRGB, strength 75) fails leakage `0.04573674205118607 > 0.03`; row 5 at
strength 100 passes with `0.01970787692101685`. **C15 is rejected.**
The selected six-row stage completed 6/6 in 951.620 seconds, exit 1, in
`artifacts/detail-research/strong-noise/comparison15-retained/run-edge-regression-anchors-eiirs64x/`.
Row 6 reproduces the failure in Rec.2020 (`0.04573668328419722`); row 7 at
strength 100 passes (`0.01970781306363343`). Across eight examined edges, six
pass and two fail. Pins/copies/outputs verify and the owned lock retired without
children; complete summary SHA
`cb7b6ea77199dad33cb8a7639c9c3930522a27db850e30cefdbbe001c5889ae8`.
Later flat-stress and texture stages are blocked, not presumed passes. No GPU
port or adoption follows. Retain the failure, recovery and complete stage evidence.

The selected C16 guide-patch CPU/reference research subsequently passed all459
canonical configurations across separate selected service cases, including the
required numeric counterfeits. The exact19-source approval and individual receipts
are recorded in `docs/professional-editing-handoff.md`. This is mathematical
research, not photographic quality or GPU acceptance. Under the user's
2026-10-31 [GPU-only direction](../../../docs/gpu-processing.md), do not extend the
CPU-only quality execution driver or build another production CPU denoiser.
Continue with a bounded GPU implementation and the retained quality references;
keep existing candidates and failures as evidence rather than ongoing backend
obligations. No passed C16 retained-selection audit or quality freeze exists yet.

The subsequent bounded GPU-only prototype is implemented in `pilot-patch-gpu.ts`
and `pilot-patch-wgsl.ts`, with registered numeric and retained-context quality
targets. Its small independent RGB/alpha checks pass focused hardware reruns,
but the first two retained quality cases fail normalized edge leakage
0.04315065 / 0.04315071 against 0.03. C16 GPU is rejected for adoption; no later
quality stages or application integration ran. Preserve the failed
`artifacts/verification/2026-10-31T18-11-11.582Z-check-REGG4e/summary.md` and
the [current handoff](../../../docs/professional-editing-handoff.md) details.
The portable CC0 synthetic inputs in `pilot-patch-quality/` under the shared
reference asset directory preserve original bytes, hashes and metric provenance.
Further algorithm work awaits the user's quality/effort decision, following
`docs/performance-decisions.md`; do not automatically create another candidate.
