# Pilot-guided pointwise chroma: prospective C15 research policy

The algorithm and publication design below are selected for one CPU research
experiment. This is not an enabled application operator or an adoption result.
C14 remains rejected. Independent source, input-plan and exact-word-oracle review
must precede reference generation; every quality gate remains unchanged.

The independent exact-word checker will use a separately authored host-Float64
graph adapter for ordered feature/gather/addition and final point estimation,
consuming only independently computed pilot publications. It shares the pinned
Python/libm substrate, imports no candidate, and makes a host-runtime agreement
claim rather than a portable correctly-rounded transcendental theorem. Separate
Decimal80 strict RGB and bound checks remain required. Every guide/E scalar must
be exactly representable at its declared Float32 publication boundary before its
word is compared; E zeros are canonical and visible guide zero signs follow IEEE.
Explicit Float64-add-to-Float32 tie, sign and zero seam vectors are required.
This oracle design selection does not approve an unreviewed implementation or
numerical generation.

## Motivation and limits of the evidence

The retained C13 weight ledger attributes its row 0 right-edge failure to a
combination of concentrated same-column mass and signed source noise. Increasing
the chroma target/gather extent in C14 reduced that failure, but both selected
strength-75 cases still exceed the unchanged 3% leakage gate. C14 is rejected;
using its pre-inverse estimate as an internal guide would not adopt its RGB
output or reinterpret its rejection.

The approved hypothesis is to estimate similarities on a preliminary feature guide while
averaging original noisy features. A pointwise final matcher avoids requiring
entire edge-straddling patches to align. This changes the chroma estimator as one
mechanism; it is not merely a different bandwidth or another patch-size sweep.
The guide remains dependent on the original noise, so independence, unbiasedness,
or guaranteed edge preservation must not be assumed.

Primary research supports investigating this separation:

- [Salmon, Willett and Arias-Castro, preprocessed Yaroslavsky filter](https://josephsalmon.eu/papers/SSP12.pdf): similarities from a preliminary estimate govern averaging of original noisy data. Its scalar piecewise-smooth noise model and theoretical assumptions do not establish our signed/HDR or texture quality.
- [Dabov et al., BM3D](https://webpages.tuni.fi/foi/GCF-BM3D/BM3D_TIP_2007.pdf): second-stage matching uses a basic estimate, while filtering original noisy groups. Its collaborative transforms and Wiener estimator are not proposed here.
- [Lebrun, Buades and Morel, NL-Bayes](https://www.ipol.im/pub/art/2013/16/article.pdf): second-stage groups are located in a basic estimate and applied to original noisy patches. Its covariance estimator is not proposed here.

These are algorithm-inspiration citations, not claims that their results transfer
to this experiment. No third-party implementation, copyleft code, package, image
or learned model is imported or proposed for copying.

## Baselines read for this draft

| Source                                                                                                | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/research/strong-noise/comparison14.json`                                                     | `1aa98d1f270c21e578beb58dcf0751c07ea2d603ef74581a89466febdb74271a` |
| `scripts/research/strong-noise/chroma-full-patchwise.py`                                              | `780e2bf713f43da251bc046fbbe59eccb44686bde7b02bc4a4808d0021e15b5c` |
| `assets/tests/references/detail/strong-noise/chroma-full-patch.md`                                    | `1c2dbb76446080d86f7828047b3248161390627dbb7dc32e12eec1280c80f350` |
| C13 boundary ledger `c13-boundary-effective-weights-draft-20261030/run-1024-owners-v1/diagnosis.json` | `5a053128643fd85bc760ee727aa9d9673526f4d90fc036966c38864f6728c48d` |
| C14 `run-context-edge-regression-h8gqmt_m/results.json`                                               | `34453e019c326f23b3cf56e8f530c9b235f0fc794cb4134da36b96bb22d883a1` |
| C14 `run-context-edge-regression-h8gqmt_m/summary.json`                                               | `9efe471a1dc392375897904309ed3ac18a65901eda3702b280323b8f37d09da1` |

Artifact paths in this table are relative to
`artifacts/detail-research/strong-noise/`. A future declaration must bind the
original C12 freeze, the existing C14 44-record selection audit, all six older
rejection/diagnosis records, the C14 rejection, every transitive implementation
and reference source, and the actual runtime. This draft does not replace those
receipts or freeze mutable handoff/status documents.

## Source coordinates and arithmetic conventions

The source is the unchanged prepared Float32 RGBA grid with its original
primaries. Let alpha(p) in [0,1] be its original alpha word. Only visible pixels with
alpha > 0 enter feature arithmetic; hidden RGB is never encoded or compared.
Hidden final RGBA is copied exactly. Preserve original RGBA/alpha zero signs.
All clamping is global, per coordinate, before forming an image index.

For a visible source pixel, using the existing luminance coefficients k:

```text
K = .18
Y(p) = fsum(kR*R(p), kG*G(p), kB*B(p))
s(p) = hypot(Y(p), K)
F_L(p) = asinh(Y(p)/K)
F_A(p) = asinh((R(p)-Y(p))/s(p))
F_B(p) = asinh((B(p)-Y(p))/s(p))
```

The approved CPU arithmetic contract is Float64, nearest-even, retaining the original
operation order. The independent oracle must use Decimal80 with independently
derived primaries. RN32 means nearest-even binary32 publication; C32 additionally
canonicalizes any rounded delta zero to +0. Generic guide publication uses RN32
and preserves its result's IEEE zero sign; only hidden guide sentinels are +0.

**Exact guide-word oracle remains a numerical prerequisite.** The guide is RN32
of the declared Float64 operands and operation graph: source feature evaluation,
Float32 pilot E words promoted to Float64, ordered Float64 outer accumulation,
division, and the final Float64 feature-plus-proposal addition. RN32 of an ideal
Decimal80 feature plus an ideal real-valued sum is not automatically the same
word near a binary32 tie. The independent plan must provide either an independently
validated exact Float64 operand/order model or certified rounding intervals that
determine the unique RN32 result. Feature/transcendental operands and any interval
assumptions need their own review, rather than copying candidate outputs as truth.
An interval crossing a rounding boundary is unresolved precision, not permission
to choose the candidate word or add a stage epsilon. This caveat also applies
where a new exact final E-word oracle needs the declared Float64 accumulation
model. Keep the existing Decimal80 strict RGB checks as a separate requirement.

Estimate (vL,vA,vB) once from the original complete prepared source with the
unchanged frozen global directional-MAD contract. Never estimate from the guide,
an ROI, a tile, the viewport, or the current amount. Define:

```text
H = sqrt(.024*.024 + .4*.4*(vA+vB))
hC(C) = H*(C/100)^2
B(a) = (a/50)^2 for 0 < a < 50, otherwise 1
```

The separate C=0 bypass below precedes guide construction and avoids division by
zero. No new amount knob, coefficient search, variance multiplier or automatic
policy selection is proposed.

## Approved pass 1: fixed pre-inverse C14 feature guide

For C > 0, run the exact feature-estimation portion of the cited C14 operator at
fixed internal amounts L=100 and C=100, with the same original source and frozen
variance. This fixed pilot does not depend on the user's amounts. It retains
C14's original L3 matching/targets/Gaussian radius-3 search, C5 matching/targets,
uniform radius-10 search, original noise corrections, alpha/self rules, Float32
center publications, actual-center outer denominators and original loop order.

Use its mandatory 59-word center publications and gathered Float64 feature
proposals Delta14_L/A/B. At these internal amounts B=1. For each visible p:

```text
G_k(p) = RN32(F_k(p) + Delta14_k(p)), k = L,A,B
```

The addition is Float64, followed by exactly one guide RN32 per component. The
C14 center delta words must already have been published before its outer gather;
do not replace them with unrounded center estimates or apply a second pilot
blend. Store the complete immutable three-component guide before pass 2 reads
it. Never update it in place during final estimation.

This is **not** C14 output RGB, a re-encoding of its rounded RGB, a display frame,
or a camera JPEG. No stable inverse or RGB round trip is part of guide creation.
For alpha=0, store three +0 guide sentinels and do not read them in matching.

## Approved pass 2: pointwise guide weights, original-value estimates

For each visible owner p, enumerate dy=-10..10 outermost, dx=-10..10 innermost.
For every offset d, set v=clamp(p+d). Repeated offsets that clamp to the same
physical pixel remain distinct contributions, exactly as in existing searches.
Skip alpha(v)=0 before reading its guide or original features. Promote stored
guide words to Float64 and compute:

```text
DL = (G_L(p)-G_L(v))^2
DC = (G_A(p)-G_A(v))^2 + (G_B(p)-G_B(v))^2
W(p,d) = alpha(v)*alpha(v) * exp(-DL/(.08*.08) - DC/(hC(C)*hC(C)))
```

DC is the sum of two squared opponent differences. Do not divide by two, three,
patch area, neighbor count, or estimated variance. DL has its existing .08
guidance scale, and DC uses the existing amount-dependent hC. Spatial weight is
uniform inside radius 10. There is no patch-distance computation in this final
matcher and **no original 2v subtraction from guide distances**. Pilot residuals
are correlated and have unknown variance; no zero-residual-noise claim is made.

The squared alpha is an explicitly approved design choice: it retains the existing neighbor
alpha and target-sample alpha factors when center=target=p and q=v. It is not a
new alpha-confidence estimate. There is no self cap, neighbor-maximum replacement
or removal of d=0. The **single enumerated d=0 offset** has weight alpha(p)^2,
so the Float64 normalizer is positive even for the minimum positive Float32 alpha.
At a global boundary, other distinct offsets may also clamp to p. Keep all those
contributions: coalesced physical self mass is
`sum(W(p,d) for clamp(p+d)=p)/Z`, not merely `alpha(p)^2/Z`. Do not deduplicate
them, cap that coalesced mass, or describe it as just the d=0 weight.
A future GPU path must separately
prove equivalent tiny/subnormal-alpha behavior; flushing weights to zero or
relaxing word checks is not authorized.

Starting with Z=N_A=N_B=+0, accumulate for each offset in the stated order:

```text
Z   += W(p,d)
N_A += W(p,d)*(F_A(v)-F_A(p))
N_B += W(p,d)*(F_B(v)-F_B(p))
E_A(p) = C32(N_A/Z)
E_B(p) = C32(N_B/Z)
delta_A(p) = B(C)*Float64(E_A(p))
delta_B(p) = B(C)*Float64(E_B(p))
```

Both numerators use the **original F**, never G or a filtered RGB value. The same
Z normalizes both. Do not multiply alpha again after W. There is one chroma
estimate per owner: no C25 outer gather, neighboring-center confidence weighting,
or repeated application of B(C). The guide changes weights only.

## Original L feature proposal, bypass and final inverse

The L feature proposal delta_L and its nine published center E words must be byte-identical to
the original C9 luminance-only computation at the user's L, using the same
original source and variance. The pilot's fixed L=100 proposal never replaces
the user's L feature path. Preserve all-grid Float64 proposal and nine-word identity
under nonzero C. For L=0, semantic L words and delta_L are +0.

This identity concerns the original pre-inverse L proposal and E words. It does
**not** claim byte identity for a luminance dot product remeasured from final
rounded RGB: different chroma changes and RGB32 publication can change that dot
product's rounding even when the L feature proposal is unchanged.

For C=0, dispatch the exact unchanged C9 route before allocating/computing the
guide. Preserve original output/proposal bits and physical legacy 27-word stage
when present. The neutral L=C=0 route may have no physical stage; do not fabricate
one to satisfy a new layout label.

Use the existing stable difference, with the original Y and s:

```text
D(x,s,d) = 0 if d=0, otherwise
           2*x*sinh(d/2)^2 + hypot(x,s)*sinh(d)
dY = D(Y, K, delta_L)
dA = D(R-Y, s, delta_A)
dB = D(B-Y, s, delta_B)
Rout = R + dY + dA
Gout = G + dY - (kR*dA + kB*dB)/kG
Bout = B + dY + dB
```

Here G in the RGB equations is the original green channel, not guide G_k.
Retain the existing Float64 operation order and pre-final evidence. Publish
final RGB to Float32 once and copy alpha exactly. If all changes are zero, copy
the original RGBA words rather than reconstructing them. No clipping, tone map,
guide RGB inverse, epsilon identity test or new fallback is introduced.

## Logical publications, source support and resource limits

| Phase/publication  | Approved semantic footprint                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| Pilot C14 center E | Existing L9 + C25 A/B = 59 Float32 words per actual center                            |
| Immutable guide G  | Three Float32 words per source pixel: L,A,B                                           |
| Active final stage | Original L9 center words, then owner E_A,E_B: 11 Float32 words per pixel              |
| C=0                | Exact physical legacy 27 words, or no neutral stage; any semantic mapping is separate |

The final two chroma slots are owner estimates, not C14 target-offset slots.
An independent checker must declare this new layout rather than reinterpret 59
words. These are logical publication boundaries, not a peak-memory measurement.
Guide storage alone is 12 bytes/pixel; final logical stage storage is 44
bytes/pixel if materialized. Pilot C14 can require its existing 59-word buffer,
Float64 accumulators, original features and source/alpha buffers. Releasing or
reusing phase buffers needs an explicit lifetime/accounting design before any
application/GPU admission. Do not claim peak memory is merely the guide plus
final stage or increase existing managed-RAM/VRAM/codec caps.

With a provided frozen source-wide variance descriptor:

- The original L feature path keeps filtering halo 5 and original-value proposal radius 3.
- Pilot G_L needs halo 5; pilot G_A/B need halo 14.
- Final matching reads G at owners and radius-10 neighbors. Its source support
  reaches 10+14=24 for chroma and 10+5=15 for L guidance.
- Final original-value chroma proposals still use only radius-10 source samples.
- Overall NR filtering halo is therefore 24, not 13 or 14. Composing the existing
  maximum sharpening halo 9 later requires 33, not the old combined 23.

The global estimator itself depends on the complete source; halo 24 is not a
locality claim for independently re-estimated tile/ROI variance. No cropping of
the guide to old halos, private expanded cache variant without identity, or
whole-source memory/performance claim is approved.

Positive normalized original-value weights preserve the existing local proposal
bound using original F ranges: L3 and C10. For C component k with maximum visible
original difference R_k within radius 10, the bound remains
`B(C)*(R_k*(1+2^-24)+2^-150)` when R_k>0, otherwise zero. Guide quantization can
change weights but cannot widen that original-value convex range. This is not a
bound on photographic bias, noise, texture retention or the global estimator.

## Required comparisons if root approves a declaration

Keep all 44 exact C12 frozen source/row/input/full-estimator/old-metric/comparator
records. Reuse the existing C14 selection receipt as evidence, then produce a
new independently audited selection/freeze for any actual experiment.

| Stage                   | Source and exact row order                                                                | Required complete passing predecessors |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| First two context edges | edges: 0,2                                                                                | none                                   |
| Other six edges         | edges: 1,3,4,5,6,7                                                                        | first two                              |
| Flat stress             | flatStress: 4,5,10,11,28,29,34,35,52,53,58,59,76,77,82,83,100,101,106,107,124,125,130,131 | both edge stages                       |
| Texture regression      | qualifiedTextures: 12,13,20,21,48,49,52,53,56,57,60,61                                    | both edge stages and flats             |

Every selected stage must complete every row and preserve partial/error evidence.
Any required failure rejects the experiment and blocks later stages. Retain
leakage <=3%, existing width/noise/bias gates, texture 0.90..1.05, exact alpha and
finiteness; no gate, input, threshold or earlier rejection is waived. C14's later
quality stages remain unexecuted/rejected-by-prerequisite, not presumed passes.

Before quality, independently review an original Decimal80 two-stage reference,
input plan, source hashes and exact F32 publication rules. Retain all existing
small recipes, primaries, strengths/asymmetric controls, hidden/partial/common-
scale/tiny-alpha and signed/HDR coverage. Add a prospectively frozen halo-24
dependency witness and guide/final-publication tie cases. Group counts must be
derived and approved from that new plan; do not silently inherit C14's 144 core
count. Exact guide words, pilot E words, final E words, legacy C0 presence/words,
all-grid L feature-proposal/E identity and existing strict pre-final/final RGB tolerances
remain required. No stage/guide-word epsilon is authorized.

Required meaningful counterfeits include raw-source guidance instead of the
declared pilot, averaging guide values instead of original F, RGB-re-encoded
guidance, missing intermediate publication, insufficient halo, and different
alpha/self semantics. They must fail actual guide/stage/RGB comparisons at
prospectively selected mathematical vectors, not just metadata or imports.

On fixed retained boundary samples, explanatory coalesced weights should report
self/same-column/other-same-side/cross-side mass, Neff, signed original noise and
clean transport together. Do not optimize Neff or select a favorable ROI. The
clean truth is evaluation-only and must never enter guide construction or
weights. A better explanatory decomposition cannot override a required gate.
Fresh populations, photographic quality, equivalent GPU/CPU, compatibility,
full-source resources, responsiveness and performance still precede adoption.

## Design decisions resolved and approval still required

The fixed C14 pre-inverse L=C=100 guide, pointwise metric/scales, no original
variance subtraction from guide distances, squared neighbor alpha, uncapped
per-offset self, original-value accumulation, and pilot59/guide3/final11
publication/zero semantics are root-approved prospectively. C14 remains rejected
as an output operator; its use as guidance is still a hypothesis.

Still required before any numerical execution:

1. Review the independent exact Float64 operand/order or certified-rounding
   strategy for guide and final publication words, including binary32 ties.
2. Review the complete independent numeric plan, halo-24 witness, counterfeit
   observability and exact group/coverage counts. No approved counts, reference
   vectors or executed new-operator outputs exist.
3. Review actual implementation source, its dependency hashes and precise plan
   binding, then issue separate explicit generation/check approval. The source
   names in the ignored comparison15.json draft are intended future paths only.
4. Review phase lifetimes, full-source admission/cancellation/cache identity and
   equivalent GPU precision separately. No existing halo/admission contract is
   sufficient merely because the comparison inputs are small. CPU research does
   not authorize a production CPU fallback, GPU port or public adoption.

Keep the inherited 44 cases/gates and all older rejections, including C14's
complete first-stage results/summary/cleanup, bound in any future freeze.
Changing approved mechanics after observing results is a new prospective
hypothesis requiring new source/plan approval, not an unrecorded sweep.
