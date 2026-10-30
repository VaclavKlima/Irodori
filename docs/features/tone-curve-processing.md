# Tone-curve processing decision

**Phase 3 research in progress, 2026-10-25.** This record fixes the first candidate
and its numerical gates before production/history/UI integration. It does not
close the [tone-curve acceptance](tone-curves.md). The user is playing; keep
research CPU work small and defer foreground or substantial GPU measurements.

## Coordinates and interpolation

Store 2–16 finite points per Master/Red/Green/Blue curve in linear reference-white
units. Both coordinates are bounded to −16…+64, with strictly increasing input
positions separated by at least 1e-4. Negative conversions and at least 16× white
are explicit parts of the mathematical domain. A curve with every input equal to
its output is an exact bypass at every brightness, independently of point count.

Compare straight segments with shape-preserving cubic Hermite interpolation.
The cubic candidate uses the weighted harmonic interior slopes described by
[Fritsch and Butland](https://doi.org/10.1137/0905021) and the documented one-sided
endpoint limit in [SciPy's PCHIP reference](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html).
The implementation is original; no SciPy dependency or source code is copied.
Monotone point sets must not introduce reversals or segment overshoot. Intentional
nonmonotone output points are allowed, with local extrema at their knots.

Use linear-light coordinates for interpolation. A signed logarithmic graph
`sign(x)*log2(1+abs(x)/0.18)` is a display coordinate only, with its explicit inverse.
It makes shadows and HDR inspectable without adding logarithms/exponentials to
every pixel or changing stored mathematical points. Plot ranges may change
transiently; numeric point editing always exposes off-plot points.

## Tails and Master behavior

Do not clamp at the first/last point or extrapolate a cubic indefinitely. For
positive distance d beyond an endpoint, tangent m, and the neighboring interval's
positive input span h, extend with
`distance = d + (m - 1) * h * d / (h + d)`. Add this to the right endpoint's output,
or subtract it from the left endpoint's output. Its derivative joins at m and tends
to 1. For monotone data, m is nonnegative and the tail stays monotone, including a
flat endpoint. Thus a flat SDR endpoint does not silently cap every HDR value.

The first Master candidate maps linear XYZ Y and retains CIE Lab/D65 a and b,
using the same signed low-end continuation as color intensity. This avoids division
by luminance near black, permits an explicit black lift, and states its hue/chroma
semantics without claiming universal perceptual uniformity. RGB curves then map
their own linear working channels independently, intentionally allowing hue changes.
Order: source preparation → white balance → Light → Master/RGB curves → global
intensity → mixer/grading when implemented → existing output mapping.

## Frozen gates and acceleration

An independent Decimal80 oracle must derive slopes and evaluate Hermite basis
functions directly, independently of production coefficients. Freeze Float64 error
at `2e-12 + 2e-11*abs(reference)` and retain the existing GPU channel tolerance
`2e-6 + 2e-5*abs(reference)`. Verify knots, extrema, dense monotone ramps, both tails,
C1 joins, near-black/signed inputs and values through and beyond 16× white.
Monotone derivative tolerance is −1e-10, and segment-envelope tolerance is 1e-11.
Compare linear and cubic derivative continuity explicitly; no threshold is widened
to fit a candidate. Photographic appearance and real HDR acceptance stay separate.

Compile bounded per-segment coefficients once per parameter change and evaluate
inside existing GPU passes. Pan/zoom must reuse that compiled data and the image
texture. No generated LUT is persisted. Ordinary Float32 positions/coefficients can
lose accuracy for closely spaced, steep segments; test compensated high/low scalar
evaluation before accepting a GPU port. A small reusable parameter texture/buffer
is allowed, with explicit accounting and equivalent native/JS CPU evaluation. It
must not cause another image upload, image pass, readback or RAW decode.
