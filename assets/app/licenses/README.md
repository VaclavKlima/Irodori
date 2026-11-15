# Processing license notices

`halide-texture-LICENSE.txt` preserves the MIT notice for the sampled local
Laplacian method adapted by `src/main/gpu/masked-texture.mjs`. The implementation
uses the previously frozen `masked-texture-llf-residual-v1` contract; no Halide
runtime is linked or required.

The upstream source pin is Halide commit
`8cfbcdb0a6e718eff70f6dfd04f37dcc78ede5ca`,
`apps/local_laplacian/local_laplacian_generator.cpp` (SHA-256
`36481ce3d3a0bf2e5346303e85857f265d98bc0816cf903f6610bf6339fdea74`).
The frozen research protocol records license pin
`f8dfa0ece6635d3c5b8c65120e6c3aa94a80df77e023f24df35570b70f79ebfc`.
The retained `halide-texture-LICENSE.txt` notice has SHA-256
`27b7b4b829920bb634dcfd9cf0c31cebce99a664b570dfe9a4bb2dc674b770ba`,
matching the retained research notice. These are distinct recorded identities;
the frozen protocol is preserved rather than rewritten during publication.
The original research protocol and attribution remain unchanged under
`assets/tests/references/masked-texture/` and `scripts/research/masked-texture/`.

The frozen Irodori adaptation uses signed-asinh luminance, alpha-weighted finite
Gaussian levels, sampled residual anchors and native-grid reconstruction. It is
not an implementation-equivalence claim for Halide's normalized integer/clipped
operator, and it does not introduce a CPU processing backend.
