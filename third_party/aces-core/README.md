# ACES 2 core

The unmodified CTL sources are pinned to [aces-aswf/aces-core revision
069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80](https://github.com/aces-aswf/aces-core/tree/069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80).
Copyright Contributors to the ACES Project, Apache-2.0; see [LICENSE](LICENSE).

`python3 scripts/generate-aces.py` followed by `npx prettier --write src/shared/aces-{core,data,wgsl}.ts` generates the forward CPU port, per-pixel
WGSL, and storage layout. CTL arrays have value semantics and zero initialization;
the generator preserves these and explicit float-to-integer truncation. CTL matrix
rows become WGSL matrix columns, preserving its row-vector multiplication.
Preparation includes the official reach, cusp, and upper hull gamma tables. Pixel
rendering retains AP1 limiting, JMh conversion, tonescale, chroma compression,
gamut compression, and conversion into limiting primaries. No photographic LUT or
fitted approximation replaces the reference algorithm.

Luma uses Bradford adaptation from Rec.2020/D65 to ACES2065-1/D60. Nominal
reference white is 100, and nominal peak is 100 × effective headroom (1–100).
Output remains relative linear RGB; white limiting and extended sRGB encoding
follow rendering. These parameters are not measurements of physical display nits.

Independent test results are generated with `node scripts/generate-aces-reference.mjs`,
which adapts unmodified CTL to C++ Float64 without importing the application port.
The shader uses `scripts/aces-precision.wgsl` for compensated cone responses and
explicit `frexp`/`ldexp` rounding boundaries on fast-math backends. These retain
reference equations; they do not introduce a fitted curve or photographic data.
