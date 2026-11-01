# C13: larger chroma matching context

C12 completed all eight declared edges, but both second-seed maximum-strength
cases exceeded the unchanged 3% leakage limit. Its passing arithmetic and six
passing edges do not override that rejection. A read-only reconstruction from
retained pixels shows both failing chroma targets already exceed the limit
before the inverse's luminance-scale coupling; that coupling reduces their
error. Matching/estimation bias is the next hypothesis to investigate.

## One algorithm change

Relative to C12, chroma weights use a 5×5 matching patch instead of 3×3. Both
corrected luminance and opponent distances in that weight use the same 5×5
coverage. Luminance weights retain their original 3×3 matching statistics,
radius 3 Gaussian search and fixed chroma guidance. Chroma search remains the
same radius 10 uniform window. The estimated target patch and outer gathering
remain 3×3, publishing the same 27 Float32 words per center.

For each matching radius m, globally clamp corresponding source coordinates
`i=clamp(c+r)`, `j=clamp(c+d+r)` for `r` in the square `[-m,m]^2`. Use pair
coverage `a=alpha[i]*alpha[j]`, normalized by `S_m=sum(a)`. Compute raw squared
L and opponent-vector distances and their existing noise-bias sums separately.
Identical global coordinates contribute zero variance bias. Correct each
distance with the original `max(raw-bias,0)` rule, independently for each m.

```
w_L = exp(-(dx^2+dy^2)/8)*alpha[q]
      *exp(-D_L^(1)/h_L^2-D_C^(1)/.12^2) for max(abs(dx),abs(dy)) <= 3
w_C = alpha[q]*exp(-D_L^(2)/.08^2-D_C^(2)/h_C^2)
      for max(abs(dx),abs(dy)) <= 10
```

Keep C12's .024 bandwidth bases, k .40, frozen whole-source estimator, strength
transfer, original self/alpha rules, stable inverse and all 441 chroma offsets,
including clamped duplicates. No C10 mean guard, self cap, new estimator or
post-result coefficient sweep is included. C=0 retains exact research-C9
behavior. For nonzero C, preserve luminance's old pad1 prefix arithmetic/order
instead of changing it incidentally when chroma's padding grows.

The [primary NLM presentation](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm)
explains that larger matching patches make patch comparison more robust at
higher noise. Its domain, parameters and complete-patch estimation differ from
this authored, separate-channel operator. It motivates this finite experiment;
it does not establish quality in our feature domain. No third-party code is
imported.

Larger context may still select incorrect patches or suppress texture. Source
support grows to halo 13 (search 10 + matching 2 + gathering 1), or 22 when combined
with the existing maximum sharpening halo 9. Proposal-value bounds remain L
radius 3 and C radius 10 because the estimated samples retain their old offsets.
Pixels outside those proposal bounds can affect matching weights; a smaller
source lease would therefore be incorrect. All GPU resources, cancellation and
performance still require a separate implementation and measurement.

## Independent arithmetic first

Generate independent Decimal80 matching statistics for m=1 and m=2; do not
relabel C12 outputs. Check all original signed/HDR, clamping, transparency,
asymmetric, identity and exact stage-word cases. Retain the existing wide
proposal-range vector and add a matching-context vector whose changed source
pixel lies outside a target's radius 10 proposal samples but inside halo 13.
Counterfeits using 3×3 chroma matching, 5×5 luminance matching, the old search or
Gaussian chroma weights must fail actual stage/RGB comparisons. Keep every
existing numeric bound and exact unchanged-luminance/C=0 property.

## Fixed examined regression sequence

[comparison13.json](../../../../../scripts/research/strong-noise/comparison13.json)
retains all 44 examined input/estimator records. The newly declared ordering is:

1. The two C12 failing maximum-strength edges, rows 5/7, in both primaries.
2. All six other edges, including their passing anchors.
3. All 24 high-noise flat cases.
4. All 12 qualified texture regressions.

Every stage must complete its declared rows. A required failure rejects C13
and stops later stages. A full screen pass still requires all 44 inputs and
every earlier gate; beginning with known failures removes no required assertion
or source. Later stages require exact completed passing receipts from this
declaration. Freeze equations, driver/runtime, independent proof bytes,
input/estimator hashes and the retained C12 rejection/diagnosis before filtering.

Leakage <=3%, unchanged noise/bias and texture 0.90..1.05 gates remain mandatory.
Passing this examined screen would still require the original/fresh/high-noise/
dosage populations, equivalent CPU/GPU recovery, photographs, compatibility and
full-source resource/performance acceptance. Public NR v1, original pixels and
history stay unchanged. No C13 generation, quality run or application adoption
is recorded by this source declaration.

Original equations and synthetic recipes follow the adjacent CC0-1.0 reference
notice.
