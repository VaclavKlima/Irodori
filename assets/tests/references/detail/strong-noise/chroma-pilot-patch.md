# Pilot-guide patch comparison: prospective C16 research policy

This prospective policy records one root-selected CPU research design after C15's
mandatory quality rejection. It does not implement or publish a new operator.
Implementation, independent numeric plan, source/reuse review, generation,
quality execution, GPU work and application adoption remain unapproved.
The companion `comparison16.json` pins the evidence read for this draft.
All C7-C15 rejections and unchanged quality thresholds remain in force.

## Why test spatial context

C15 completed its first two and subsequent six retained edge rows. The alternate-
seed strength75 cases fail the unchanged 3% edgeLeakage gate in both primaries;
later 24 flat and 12 texture stages are blocked by prerequisite failure.
The exact two-row diagnostic at `c15-boundary-ledger/freeze-cvewf6vh` reproduced
both complete RGBA32 outputs byte-for-byte and captured identical fixed guides.
Its summary SHA-256 is
`1c7fc7235ab444026c2a5061cdf8ae68dfb1c31fbb7ac3b793345ba2fc287749`.

For the failing sRGB strength75 right boundary, mean opposite-true-side mass is
7.921522671266194e-30. Mean A clean transport is -1.5178830414797062e-18,
weighted original noise is -.01831195369793477, and final transformed target
error is -.018311953922833683, with maximum decomposition closure residual
4.839878497975292e-16. This resolves the earlier final-output-only ambiguity for
these replayed owners: the failure is same-side weighted-noise mean, with
negligible actual cross-edge transport. The edgeLeakage score is a boundary-
error metric, not a direct measurement of cross-edge weight mass. Strength100
passes on the same source and guide; neither result is independent-noise evidence.

The single hypothesis is to replace only the final pointwise guide comparison
with a 5x5 spatial guide-patch comparison, retaining owner-only original-value
estimation. It may change selection correlated with residual guide noise; it
provides no independence, unbiasedness, edge preservation or HDR guarantee.
[Dabov et al., BM3D, Section III Step2 andIII-B2](https://webpages.tuni.fi/foi/GCF-BM3D/BM3D_TIP_2007.pdf)
uses matching within a basic estimate to locate noisy blocks for its second
stage. That supports investigating pilot-patch context; its collaborative
transforms, Wiener estimator and Gaussian-noise results are not this operator.
No third-party implementation, package, image or learned model is copied.

## Unchanged source, controls and components

Use the same original prepared Float32 RGBA source, primaries and independently
verified coefficient words. Preserve alpha and signed-zero source words. Only
visible source pixels enter original feature arithmetic. Hidden owners bypass
all feature/guide reads and copy original RGBA exactly. L and C controls are
integers 0..100, as enforced by the shared application validator; this declaration
does not introduce continuous or tiny positive fractional controls.

Keep the existing Float64 encoded source features, original luminance coefficients
and operation order:

```text
K=.18
Y=fsum(kR*R,kG*G,kB*B); s=hypot(Y,K)
F_L=asinh(Y/K)
F_A=asinh((R-Y)/s); F_B=asinh((B-Y)/s)
H=sqrt(.024*.024+.4*.4*(vA+vB))
hC(C)=H*(C/100)^2
B(a)=(a/50)^2 for 0<a<50; B(a)=1 for 50<=a<=100; amount0 bypasses
```

The variance descriptor is the unchanged frozen full-source directional-MAD
estimate from original prepared features. Do not re-estimate from a guide,
viewport, crop, tile or user strength. Preserve the .024 base bandwidth, .4 sigma factor,
quadratic hC strength mapping, .08 final luminance guidance and the existing
single post-publication strength blend. No 2v guide-distance subtraction,
coefficient sweep, extra variance correction or fallback is introduced.

For C>0 use the exact C15 fixed C14 feature-estimation pilot at internal L=C=100:
original C14 center 59 RN32 publications, ordered Float64 outer gather/division,
then `G_k=RN32(F_k+pilotProposal_k)` through one Float64 addition. Complete the
immutable three-component Float32 guide before final matching. Preserve generic
visible IEEE guide zero signs; hidden sentinels are +0 and never read in matching.
No pilot RGB inverse, rounded-RGB re-encoding, unrounded center substitution or
additional blend enters the guide. C14 remains rejected as a final output operator.

The user's original L feature proposal and its nine center E words remain exact
research-C9 identity. The fixed pilot L=100 must not replace that user-L path.
For C=0, dispatch the unchanged research-C9 route before guide construction,
preserving physical 27 words when present and no fabricated neutral stage.
This identity is against research C9, not shipped public NR v1 (.048/.16). It is
also not an assertion of exact final-RGB dot-product luminance identity.

## Changed final comparison: direct 5x5 guide patches

For each visible owner p, start `Z=NA=NB=+0` and enumerate search offsets in
`dy=-10..10` outer, `dx=-10..10` inner order. For each offset d:

1. Set `v=globalClamp(p+d)` in each axis. If alpha(v)=0, skip before patch
   construction and before any guide or original-value reads for that neighbor.
2. Start `Q=SL=SC=+0`. Enumerate 25 matching offsets with `uy=-2..2` outer,
   `ux=-2..2` inner order. Form `a=globalClamp(p+u)` and
   `b=globalClamp(v+u)`, then `q=Float64(alpha(a))*Float64(alpha(b))`.
   If q=0, skip before either guide read.
3. For every nonzero-q entry, promote the stored guide components to Float64
   and perform these operations in the stated order:

```text
dL=GL(a)-GL(b); dA=GA(a)-GA(b); dB=GB(a)-GB(b)
Q  += q
SL += q*(dL*dL)
SC += q*((dA*dA)+(dB*dB))
```

4. If Q=0, W=0 without a substitute denominator, pseudocount or fallback.
   Otherwise evaluate:

```text
DL=SL/Q; DC=SC/Q
W=alpha(v)*alpha(v)*exp(-DL/(.08*.08)-DC/(hC*hC))
Z  += W
NA += W*(FA(v)-FA(p))
NB += W*(FB(v)-FB(p))
```

Every addition, multiplication, subtraction, division and exponential follows
the declared direct Float64 graph. No prefix-sum reassociation, fsum reduction,
FMA substitution, reciprocal rewrite, approximate exponential, channel divisor
or additional 25 divisor is approved. The only patch normalization is actual Q.
Original feature values enter NA/NB; guide values govern similarities only.

The clamping is center-first: clamp p+d to physical v, then clamp v+u. Computing
`clamp(p+d+u)` instead is a different boundary operator. Retain all enumerated
search-offset duplicates and all 25 matching-sample duplicates after clamping.
Do not deduplicate, renormalize boundary multiplicities or pad with hidden data.

For every visible owner and visible neighbor, central u=0 contributes
`alpha(p)*alpha(v)>0` in Float64, so Q>0. The Q=0 branch is defensive, not a
fallback used for admitted visible pairs. For the single d=0, and every other
enumerated offset clamping v=p, the two physical guide patches are identical,
DL=DC=0 and
W=alpha(p)^2. These self contributions remain uncapped, unreplaced and distinct.
Minimum positive Float32 alpha is retained in Float64 weights. Different GPU
flush-to-zero behavior is not authorized by this CPU design.

After the search, publish exactly one chroma owner estimate per component:

```text
EA=C32(NA/Z); EB=C32(NB/Z)
deltaA=B(C)*Float64(EA); deltaB=B(C)*Float64(EB)
```

The unchanged B(C)=(C/50)^2 for integer 0<C<50, otherwise 1 for C>=50,
is applied exactly once after C32 publication. C=0 bypasses this entire pass.
C32 means nearest-even binary32 with any rounded delta zero canonicalized to +0.
The guide uses generic RN32 instead. There is no chroma target patch, C25 target
publication, final chroma outer gather, extra alpha factor or second blend.
The final active layout remains original L9 followed by owner EA/EB:11 words.
Pilot59, pilot Float64 proposals, guide3, final11 and pre-final RGB diagnostics
retain their distinct meanings; centerDeltas must describe final11 when active.

Use the unchanged stable original-source inverse with original Y and s, exact
operation order, one final RGB32 publication and exact alpha copy. All-zero
changes copy original RGBA words. No clipping, tone mapping or epsilon identity
is added. Original-value convex proposal bounds remain L3/C10, with the existing
outward publication bound; a larger guide dependency does not enlarge the
original values being averaged.

## Dependency support and resource limits

Original user-L retains source halo 5. The unchanged pilot's GL needs source
halo 5 and GA/GB need 14. The new matcher reads guide patches centered at search
neighbors ±10 with matching taps ±2, so guide query radius is 12. Therefore final
chroma source halo is 12+14=26; L guidance reaches 12+5=17. Existing maximum
sharpening halo 9 composes to 35. These are not the old 24/15/33 requirements.

For an interior output tile of side N, logical needed guide side is N+24, pilot
center side N+28, and original source side N+52 before global-image clipping.
These support extents do not approve buffer allocations or materialization.
The full-source variance descriptor still depends on the entire prepared image.

Keep pilot59, guide3 and final11 logical publications. Guide 12 bytes/pixel and
final 44 bytes/pixel are not total peak memory: pilot centers, Float64 gathers,
features, alpha/source, phase overlap and codec/GPU storage remain separate.
Full-source lifetimes, admission/refusal, cancellation, cache identities and a
GPU equivalent require later design and evidence. Do not raise existing caps
or introduce a production CPU fallback through this research declaration.

## Compositional numerical verification proposal

The C15 full five-group proof retains 447 logical configurations:
core 156, alpha 84, asymmetric 12, C0 identity 180 and publication 15. Keep all of them,
including existing halo 24, signed/HDR, hidden/partial/common-scale/tiny-alpha,
asymmetric, self/clamp, exact stage and strict RGB assertions. Add a new source-
halo 26 witness and a patch-versus-pointwise witness, each numerically observable
at the selected owner's published stage/guide/RGB rather than geometry or
metadata alone. The old halo 24 proof is insufficient for the new support.
Also retain center-first clamping and
nonuniform matching-q observability. Derive and review new group counts before
approval; retaining 447 is a baseline, not an approved final C16 count.

The companion manifest binds the old 13 C15 mathematical sources and actual five
comparison/reference/approval receipts. Old references contain exact original
RGBA bytes/hash, dimensions, frozen variance, coefficient words, independent
pilot59 words, Float64 pilot proposals and guide3 words. They may supply an
unchanged independent prefix only under exact matching input/component/runtime
keys. Include all RGBA words, alpha and zero signs, dimensions, primaries and
coefficient bits, variance descriptor, source graph, Python executable, math
extension and loaded libm identities/hashes. A changed host cannot silently
reuse host-Float64 guide words as portable truth.

The changed final patch graph needs an independent host-Float64 oracle and
separate Decimal80 strict pre-final/final RGB and bounds. Recompute new final E2
and RGB expectations; old C15 final E2/RGB do not certify this comparator. Never
substitute candidate-produced prefixes as independent truth. Actual composed
candidate output must agree on pilot59, pilot proposals, guide3, user-L9/proposal,
new final11 and final RGB. Preserve exact C0 stage presence and all 15 publication
seam vectors; no stage or guide epsilon is allowed.

If later separately approved, memoizing the actual fixed prefix across controls
can avoid repeated unchanged work. The public composed entrypoint must still
run for every logical configuration and validate the actual source. Cache keys
must include all immutable input/component/runtime identities; report unique
prefix evaluations separately from logical uses. Isolate canonical/mutant caches
and preserve source mutation and bypass observability. This draft approves no
cache implementation, new helper API or numeric execution.

Retain all eight meaningful C15 counterfeits: raw-source-guide,
guide-values-instead-of-original, unpublished-pilot, unpublished-guide,
rgb-roundtrip-guide, short-halo23, linear-alpha and capped-self. Add actual wrong-
pointwise-final-metric and halo25-insufficient-for26 counterfeits. Review witnesses
that fail real guide/stage/RGB comparisons, rather than only metadata rejection.
Old C15 full approval is component provenance; it is not C16 generation approval.

Canonical generation and comparison retain the complete declared group and all
459 currently planned configurations, including the 447 inherited ones. Named
counterfeit checks may use only their prospectively declared witness scenes,
with both primaries, every group control and all selected points in those scenes.
They use the same full independent reference and retain the same numerical
failure predicates, including selected-owner RGB witnesses for shortened halos.
Each negative receipt must report its actual configuration/coverage counts,
`comparisonScope=counterfeit-witness-only`, `completeGroup=false` and the full
plan count. Such a receipt cannot satisfy a canonical proof or quality prerequisite.
An unobserved fault is incomplete verification. Full reference/prefix provenance
is still checked; only unrelated candidate invocations and paired-scene checks
are omitted from that named negative probe. No canonical assertion is removed.

## Mandatory retained quality protocol

Preserve all 44 complete C12 records: source/row order, original clean/entering
Float32 bytes, hashes, full frozen estimator descriptors, old metrics, comparator
outputs and every required gate. A new independent selection/freeze must verify
that identity; do not select only passing rows or reinterpret them as fresh data.

| Stage           | Exact rows                                                                               | Required complete passing predecessors |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| Context edges 2 | edges 0,2                                                                                | none                                   |
| Other edges 6   | edges 1,3,4,5,6,7                                                                        | context edges                          |
| Flat stress 24  | flatStress 4,5,10,11,28,29,34,35,52,53,58,59,76,77,82,83,100,101,106,107,124,125,130,131 | both edge stages                       |
| Texture 12      | qualifiedTextures 12,13,20,21,48,49,52,53,56,57,60,61                                    | both edge stages and flats             |

Finish every row in a selected stage. Any required failure rejects the candidate
and blocks later stages. Retain failed/partial/error evidence, exact predecessor
receipt lineage, source/output pins and cleanup accounting. Keep leakage<=.03,
all existing width/noise/bias gates, texture .90..1.05, exact alpha and finite
output. Every C7-C15 rejection remains preserved, including C15's complete 2+6
edge results/summaries/cleanup, frozen declaration and exact two-row ledger.
A regression pass would not establish fresh populations, photographs, GPU/CPU,
resources, history compatibility, responsiveness, speed or public acceptance.

## Readiness and next review

Only this prospective mechanism/publication design is selected and reviewed.
These working-tree policy files contain no new implementation, numeric plan or
reference output. Root and independent review must examine the source, reuse bindings,
arithmetic graph, added witnesses/counterfeits and exact group counts before
any separate generation approval. Quality requires a complete successful new
math proof plus a newly approved independent selection/freeze. Desktop/GPU work,
production migration and public operator adoption remain separately unapproved.
