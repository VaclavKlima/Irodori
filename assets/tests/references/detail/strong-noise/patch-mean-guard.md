# C10: covariance-corrected patch-mean chroma guard

This is an authored, unenabled research policy. C9 k .55 remains rejected after
four required high-noise color-edge failures reproduced by archived CPU replay.
The change below addresses a measured cross-edge chroma proposal, rather than
changing source populations, metrics or acceptance limits. No C10 filtering or
acceptance is claimed by this declaration.

## Frozen change

Keep the C9 source-wide estimator, signed asinh coordinates, 7x7 search, 3x3
patch, spatial sigma 2, .024 luminance maximum, .024 chroma floor, k .55, strength
transfer, self contribution, alpha handling, Float32 estimate publication,
overlap aggregation and stable inverse. The candidate adds only a lower bound to
the **chroma matching** distance. Luminance matching and its old chroma guidance
remain unchanged. Neutral and chroma-zero paths retain their old arithmetic.

For the nine offset pairs at center `c` and displacement `d`, clamp each source
coordinate globally first. Write their source indices as `P_i,Q_i`, their pair
weights as `a_i=alpha[P_i]*alpha[Q_i]`, and `S=sum_i a_i`. Pairs with zero weight
do not read either hidden feature value. For visible coverage:

```
mu_A = sum_i a_i*(A[P_i]-A[Q_i])/S
mu_B = sum_i a_i*(B[P_i]-B[Q_i])/S
beta_j = (sum_{i:P_i=j} a_i - sum_{i:Q_i=j} a_i)/S
V_mean = (v_A+v_B)*sum_j beta_j^2
D_mean = max(mu_A^2+mu_B^2-V_mean, 0)
D_C10 = max(D_C9, D_mean)
```

Coalesce actual global source indices **before** squaring coefficients. This
includes overlapping patches, repeated clamped samples and fractional/zero
alpha. For opaque, unclamped patches the coefficient sum is
`2*(9-max(0,3-abs(dx))*max(0,3-abs(dy)))/81`: adjacent horizontal patches give
`2/27`, disjoint patches `2/9`, and self comparison zero. Never substitute
`2/9` for overlapping or clamped patches. Zero coverage reports zero statistics
and does not propose a match.

The covariance equation assumes independent homoscedastic source-feature noise
with the already frozen component variances. It does not claim calibrated
photographic noise or decorrelation after RAW demosaic/lens correction. The
extra distance cannot increase an individual chroma match weight, but that alone
does not prove better denoising, bias, textures or photographic quality.

## Predeclared diagnostic screen

[comparison10.json](../../../../../scripts/research/strong-noise/comparison10.json)
binds forty **already examined regression inputs** and the one candidate. They
are not new holdouts:

1. All four failed C9 color-edge rows: 292, 298, 317 and 323 from the retained
   high-noise run. Keep both primaries, sigma .10, seed 1/strength 75 and seed
   0xDEADBEEF/strength 100. Complete all four before judging this first stage.
2. Twenty-four high-noise flat regressions: flat luminance, flat chroma and mixed
   flat; sigma .10, both seeds above, both strengths 75/100 and both primaries.
3. Twelve qualified texture regressions: luminance periods 2/4 and A/B periods
   2/4, both primaries, seed 0x85EBCA6B and the original nominal controls/noise.

Reuse the exact saved clean/entering bytes, source hashes and whole-source
estimator descriptors. Do not regenerate sources, re-estimate by ROI or alter a
coefficient, amount or gate. Record the old C9 output as a rejected comparator.
Every original metric remains mandatory, including edge leakage **<=3%**, the
declared noise/bias gates and texture retention **0.90..1.05**. Any required
failure rejects this candidate. Later stages require a passing earlier-stage
receipt; do not execute them to search for a favorable subset after rejection.

Freeze current policy/equation/driver/reference hashes and all selected retained
file hashes before importing the candidate for filtering. Qualify the pure
covariance/mean helper independently with Decimal80 and exact rational
coefficients first. Keep the old C9 declaration/source archives untouched.

Even a complete screen pass is insufficient for adoption. The original accepted
regressions, full high-noise and dosage matrices, prospectively declared unseen
inputs, independent full-operator CPU/GPU references, equivalent recovery,
native photographs, versioned legacy compatibility, resources and sustained
responsiveness remain required. Reuse the existing GPU owner only after the
scalar policy passes the first diagnostic stage. No application feature or NR v1
pixel meaning changes here.

The original numeric policy/recipes follow the adjacent CC0-1.0 reference notice.
No third-party implementation was copied.
