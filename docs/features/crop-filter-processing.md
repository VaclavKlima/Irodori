# Crop spatial-filter decision

**Implementation candidate selected; photographic acceptance remains open, 2026-10-25.**
The fixed gates below were recorded before measuring the candidates. They complement the [geometry contract](crop-straighten.md),
not replace real-photo/native acceptance. No application crop edit is enabled yet.

Compare bilinear, the existing Catmull-Rom kernel, and normalized Lanczos3 for
unit-scale rotation/translation. Their smoothing/ringing tradeoff is supported by
[Mitchell and Netravali's original paper](https://www.cs.utexas.edu/~fussell/courses/cs384g-fall2013/lectures/mitchell/Mitchell.pdf).
Irodori's existing kernel is original application code; no paper code or library is copied.
This comparison does not select an enlargement/minification filter.

## Fixed candidate gates

- Exact identity/integer-grid selections bypass filtering and preserve all bits.
- Interior constants and linear/quadratic ramps retain the independent mathematical
  reference within `2e-6 + 2e-5*abs(reference)` per channel. Signed values and 16× white
  remain unclipped. CPU reference evaluation additionally agrees within
  `2e-10 + 2e-10*abs(reference)`.
- A unit-amplitude, 0.2-cycle/native-pixel sinusoid has RMS reconstruction error
  at most 0.03 over independent subpixel phases. Report lower/higher frequencies
  separately; this is not a universal photographic sharpness score.
- A one-dimensional unit step has at most 0.075 overshoot/undershoot. An axis-aligned
  binary quadrant has at most 0.155. These bounds apply to those named charts, not
  every arbitrary binary pattern. Report diagonal/impulse/repeating-detail behavior.
- Adjacent CPU tiles produce exactly the same Float32 bytes as the corresponding
  complete region, with no seam, skipped pixel or repeated-coordinate drift.
- Keep the frozen GPU channel tolerance above, including large source coordinates,
  fractional origins, boundary extension and partially transparent regions. Do not
  widen it if ordinary Float32 affine/weight evaluation loses cancellation precision.

## Observed comparison

The independent generator compares the declared charts; the production kernel is
also exercised on the sinusoid/step/quadrant charts and agrees within 2e-12.

| Candidate           | RMS at 0.2 cycles/pixel | Unit-step overshoot | Quadrant overshoot | Fixed gates                  |
| ------------------- | ----------------------: | ------------------: | -----------------: | ---------------------------- |
| Bilinear            |                0.098703 |                   0 |                  0 | Fails detail gate            |
| Catmull-Rom         |                0.028654 |            0.074074 |           0.153635 | Passes the three named gates |
| Normalized Lanczos3 |                0.011849 |            0.117811 |           0.249501 | Fails ringing gates          |

The declared diagonal-step sample grid has overshoot 0, 0.117004 and 0.157237
respectively. Its impulse minima are 0, −0.073242 and −0.147996, with peak 1.
RMS against the explicit analytic Nyquist-checker continuation is 0.087416,
0.008263 and 0.001136. These are filter diagnostics on known synthetic signals,
not recovered photographic detail or a universal image-quality ranking. The
higher-frequency sinusoid errors also remain in the fixture; Catmull-Rom does
not win every frequency comparison.

Use the existing Catmull-Rom polynomial as the implementation candidate. Its new
shared location leaves lens evaluation arithmetic unchanged. Independent
Decimal80 Hermite-basis vectors cover eight 9×9 Float32 scenes and 648 positions,
including linear/quadratic reproduction, signed/HDR detail, alpha and dark constants.
The CPU and native GPU ports retain the predeclared numeric gates. Real-photo,
PNG/merge-edge appearance and native/performance acceptance still remain required.

## Candidate alpha and boundary policy

For an entirely opaque 4×4 support, evaluate Catmull-Rom RGB separably in linear
working light. If any contributing support alpha differs from 1, use nonnegative
bilinear interpolation of premultiplied RGB and alpha, then unpremultiply. This
prevents negative cubic weights from turning validity/transparent edges into colors
outside the contributing color hull. It deliberately favors stable coverage edges.
The policy change near transparent support needs real-photo/PNG edge acceptance.

At fractional sampling only, coverage whose Float32 result is at most `2^-20`
becomes clear black. This is a coverage guard, not a threshold on dark image values;
opaque faint stars and signed channels are preserved. The cutoff is below one part
per million and keeps near-empty unpremultiplication well conditioned on GPU backends.
Exact pixel copying retains original low-alpha/hidden RGB bits. Output alpha stays
within 0…1. Do not clamp working RGB or apply an SDR transfer curve.

Extend outlying filter taps with the source border pixel. Crop corners themselves
must remain inside the photograph. Fetch a bounded native rectangle with the actual
two-pixel support plus one integer-index guard pixel; do not read or decode the whole
original for each tile. Preserve authenticated strip handling and source leases.

Candidate version: `linear-catmull-rom-alpha-linear-v1`. If it fails the fixed
gates, retain the failed evidence and evaluate a different policy before adoption.
Source preparation, preview and export must share the accepted kernel, phase,
alpha, boundary and version semantics. A new interpolation policy never silently
changes an already accepted nonidentity crop.

## Integration and limits

Use at most 256×256 output pixels per processing tile, explicit source-window
accounting, one active job, cancellation and bounded CPU/GPU ownership. Compile an
affine map once per crop, preserve high/low coefficients where GPU precision requires
them, and reuse the map and source during pan/zoom or downstream color edits.
Pixel-aligned geometry remains a direct-copy path. Any GPU candidate still needs
the native resource/loss/fallback and photographic evidence in the feature brief.

## Implemented worker ownership

[Shared tile processing](../../src/shared/crop-filter.ts) uses Float64 CPU evaluation;
[the GPU kernel](../../src/shared/crop-filter-wgsl.ts) uses compensated coordinates,
weights and accumulation. Both use the same phase, kernel/alpha and boundary policy.
Exact GPU selections use integer storage so signed-zero/hidden-RGB bits survive.
The [GPU owner](../../src/main/gpu/crop.ts) reuses its four buffers and drains active
work before disposal. Managed GPU buffer storage is 4,275,824 bytes, excluding driver
and runtime overhead. Shared admission constants prevent allocation-plan drift.

The discontinuous coverage guard has a specific recovery: a GPU tile containing
coverage at or below 16× the cutoff is reconstructed using canonical CPU coordinates.
Six near-cutoff, large-coordinate cases retain identical Float32 results through this
path. It is reported as precision recovery, not waived error or silently wider tolerance.

[Prepared-asset processing](../../src/main/processing/crop-preparation.ts) freezes the
job/admission context, checks existing/retiring reservations and all incremental image
buffers, and loads/authenticates the prepared source once into admitted RAM (at most
512 MiB). It streams a 64-row output band and bounded tiles instead of allocating a
second full output plane. GPU uploads contain only the needed native window. Integer
crops retain the smaller destination-plus-source-strip exact-copy path; identity does
no extra image allocation or I/O.

The [shared band engine](../../src/main/processing/crop-bands.ts) also serves the
[authored-frame adapter](../../src/main/processing/crop-frame.ts). This borrows a
linear raster frame and preserves its existing display transform, without introducing
Rec.2020 provenance or another full source copy. Streaming charges the input once,
one output band and tile storage in addition to other live/retiring owners. A caller
collecting a retained output must admit that additional full output allocation.
Identity borrows original pixels without a GPU owner. CPU tile boundaries yield to
the worker event loop so timer cancellation can interrupt a long transform.

The [export renderer](../../src/main/export/renditions.ts) now uses those adapters
before output sizing and point/output operations. Prepared HDR data and an authored
SDR primary receive matching crop geometry without mixing their color semantics.
Jobs freeze geometry/admission before awaiting preparation; uncropped source reuse
retains its existing identity. Diagnostics record geometry/filter versions, backends,
tile counts, recovery and admitted memory. The
[preview preparator](../../src/main/processing/crop-preview.ts) publishes cropped
Float32 plus matching display output through the existing main cache. Its source
remains independently leased; point changes reuse the crop, and context/picking can
still request uncropped native data. Worker cache checks distinguish supplied
prepared bytes from the original, while retaining a matching decoded original in
RAM for the first color change. Ordinary application crop controls/history and
production admission/manifest wiring remain unfinished.

Automatic mode can choose CPU on admission/init failure and drains a failed GPU owner
before continuing with the same CPU filter. Forced GPU failures remain failures.
Cancellation, bad hashes, malformed pixels and close failures cannot publish partial
assets; pre-existing output/source files are preserved. The typed main-owned request
runs through the existing isolated Node preview worker, without a renderer path API.

At settings integration, crop version 1 must bind this geometry and filter policy;
a different filter needs a new crop version or an explicit supported upgrade. Record
both versions in cache/export identities. Do not retune saved nonidentity crops.
