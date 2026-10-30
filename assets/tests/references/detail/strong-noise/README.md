# Source-variance chroma bandwidth: numeric reference inputs

The [C8 input plan](noise-scaled-input-plan.json) contains original synthetic
numeric recipes and independently supplied feature-variance coefficients for
Irodori's unadopted strong-noise research. It contains no photographs, source
metadata, observed sensor calibration or generated acceptance results.

These numeric recipes, equations and their original reference generator are
dedicated to the public domain under **CC0-1.0**:
<https://creativecommons.org/publicdomain/zero/1.0/>. This exception applies to
these original research inputs/code and generated numeric vectors; it does not
relicense application code, photographs or third-party resources.

Provenance: all 15 source recipes, both primaries, 23 control combinations and
four alpha/hidden-pixel pair checks are preserved from the checked C7 direct
Decimal80 input plan. The C8 plan records the shared generator and original plan
hashes. Its additional authored equation is
`hCMax = sqrt(0.024^2 + k^2 * (varianceA + varianceB))`, for both predeclared
factors `0.4` and `0.55`. Each supplied variance is converted through its exact
Float64 word, then the C8 width is computed independently in Decimal80. These
coefficients are mathematical inputs, not an estimate from an image or ROI.

The generator is
[noise-scaled-reference.py](../../../../../scripts/research/strong-noise/reference/noise-scaled-reference.py).
It imports only the separately checked direct Decimal oracle, never candidate,
application or estimator code. A fresh approval must bind its source, shared
generator, input plan and ASCII canonical math hashes before generation. The
checker invokes the separate C8 candidate with its base and factor, rather than
substituting the oracle's compiled width into the fixed-width C7 engine.

Keep generated reference JSON, logs and comparison results under ignored
`artifacts/`; retain failed evidence. Exact staged words, whole-grid alpha and
hidden/neutral copies, unchanged strict pre-final and final RGB tolerances, and
paired invariance checks remain mandatory. These small numeric cases do not
accept photographic quality, calibration, resources, performance or public NR
version 2. No numeric reference generation is claimed by this notice.
