# C12: wider chroma search with unchanged luminance

C11's independent arithmetic passed, but four of its eight required edges
failed the unchanged 3% leakage limit. It remains rejected. This separate,
prospectively declared hypothesis tests a larger chroma neighborhood; no C12
quality or application acceptance is claimed.

## One changed factor

Relative to C11, increase only chroma's uniform search radius from 3 to 10:
21×21 candidate positions. Keep luminance's original 7×7 Gaussian search,
including its corrected chroma guide. Both retain the original 3×3 matching
patch, frozen whole-source variance, corrected distances, .024 bandwidth bases,
k .40 chroma scaling, strength transfer and stable inverse. With d=(dx,dy):

```
w_L = exp(-(dx^2+dy^2)/8)*alpha[q]
      *exp(-D_L/h_L^2-D_C/.12^2) when max(abs(dx),abs(dy)) <= 3; otherwise 0
w_C = alpha[q]*exp(-D_L/.08^2-D_C/h_C^2)
      when max(abs(dx),abs(dy)) <= 10; otherwise 0
```

The [primary NLM presentation](https://www.ipol.im/pub/art/2011/bcm_nlm/revisions/2011-09-13/bcm_nlm.htm)
uses 21×21 or larger searches and explains why stronger noise requires more
similar samples. That supports testing wider support, not adopting these
authored channel-specific equations or claiming that this radius suffices.
No third-party code is imported. There is no radius sweep or coefficient tuning
after results are observed.

Retain all 441 chroma offsets, including global-edge clamped duplicates and
the original d=0 alpha self mass. Do not silently deduplicate boundary samples.
The 27-word Float32 center stage, alpha-weighted outer gathering and component
inverse stay unchanged. C=0 must preserve research C9 k .40 exactly; this is not
an identity claim about the public v1 operator. All-zero and transparent source
copies keep their original words.

Wider support raises both computation and the risk of distant false matches.
The chroma source halo becomes 12 prepared pixels (search 10 plus two matching/
aggregation patch steps), while luminance needs 5. A future GPU owner must
account for this larger source window and keep bounded storage/cancellation.
No existing production allocation, halo, rendering version or saved edit changes
under this declaration. GPU implementation and performance remain separate.

## Independent arithmetic and fixed regression sequence

[comparison12.json](../../../../../scripts/research/strong-noise/comparison12.json)
binds the same examined 8 edge, 24 flat and 12 texture inputs, entering/clean
Float32 words and full-source estimator descriptors as C11. Preserve every
earlier failure and metric. Complete all eight first-stage edges before judging
the stage; any mandatory failure rejects C12 and prevents later stages.

Before quality filtering, independently enumerate the radius-10 chroma patches
in Decimal80. Do not reuse C11 output as the new reference. Check both primaries,
signed/HDR, clamping, one-dimensional geometry, alpha/hidden RGB, asymmetric
controls, exact C=0 identity and every published stage word. Per-component local
bounds cover radius 3 for luminance and radius 10 for chroma. Include source
support beyond radius 3 so substituting the old neighborhood is detected.
Freeze all source/reference/driver/runtime/input hashes before execution.

The unchanged leakage <=3%, noise/bias, texture 0.90..1.05 and numeric limits
remain mandatory. Passing this finite screen would still require the full
original/fresh/high-noise/dosage populations, CPU/GPU recovery/equivalence,
photographic review, resource/performance evidence and versioned application
integration. No new public denoiser is enabled here.

Original equations and synthetic recipes follow the adjacent CC0-1.0 reference
notice.
