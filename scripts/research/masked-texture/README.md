# Masked Texture feasibility prototype

Research tooling for [#80](https://github.com/VaclavKlima/Irodori/issues/80).
This does not add an application setting, UI control, history migration, export
operation or MCP capability. The selected candidate and all gates are frozen in
[`protocol.json`](../../../assets/tests/references/masked-texture/protocol.json).
Photographic masks are partial manual treatment regions, not object segmentation.

The isolated native Dawn device runs the sampled local-Laplacian residual and
existing mask coverage in WGSL. Small scalar Python arrays provide independent
float64 references; Python never processes a photograph. Image preparation and
SDR proof use the existing production owners with neutral point edits. Sources
are never overwritten. There is no CPU feature fallback or reduced-resolution
retry.

## Reproduce on the current device

Use Node 24+, installed dependencies and the normal native/build prerequisites
from the repository README. Prepare `out/main/preview-worker.js` with the normal
development build before the photographic stage. All output directories below
must be new, with an existing parent. Generated files stay outside Git.

```sh
node scripts/research/masked-texture/run.mjs --stage numeric --output artifacts/masked-texture/my-numeric
node scripts/research/masked-texture/run.mjs --stage photo --numeric artifacts/masked-texture/my-numeric --output artifacts/masked-texture/my-photo
node scripts/research/masked-texture/gallery.mjs artifacts/masked-texture/my-photo
npm run verify -- --target masked-texture-prototype
```

The first stage checks 19 frozen reference cases, procedural response/step gates
and a bounded impulse support probe. Failure prevents photographs. The photo
stage requires the same protocol, entire bundled implementation and lockfile as
the successful numeric receipt. It verifies tracked original hashes/notices,
native prepared/source proof identity, alpha/hidden/zero-coverage words and
zero-coverage production proof pixels. The simultaneous LLF/proof/comparator
allocations must fit unchanged Automatic RAM and conservative 2 GiB VRAM policy.
Each owner has a ten-minute limit and process-group cleanup. No foreground app
or browser opens automatically.

The original runner selects only the primary flamingo. It renders −25/+25 and explicitly labelled
stress −100/+100 independently for each frozen region, with Neutral and existing
global sharpening 50/1/50 as comparisons. The combined proof materializes true
bottom-to-top plumage +25, reflected legs +10, ripples −25 results. The latter
regions are spatially disjoint; numeric overlap/order cases provide a separate
small-array check. This does not qualify general production stack integration.

## Supplemental skin and foliage proof

The user's first-gallery feedback selected +25 for feathers and reflected legs,
found no clear ripple difference, and preferred the existing combined appearance.
That supplied the planned first-image benefit gate. A separate, source-only
`supplemental-cases-v1.json` freezes the existing anonymous forearm/hair JPEG and
authenticated forest v4 scene-linear master, one partial radial region each,
two native crops and two untouched controls each. The original protocol and
flamingo selections remain unchanged. The source audit/freeze precede any
supplemental candidate output.

Run one explicitly selected case at a time, inspect it before proceeding, and use
the unchanged numerical receipt as the prerequisite:

```sh
node scripts/research/masked-texture/supplement.mjs --output artifacts/masked-texture/my-skin --cases assets/tests/references/masked-texture/supplemental-cases-v1.json --cases-sha256 54627d431ba43057c03be9c1b8993f4e42d9ac96839745e3a9a470fadb8a6ec0 --numeric artifacts/masked-texture/2026-11-14-prototype/numeric-04 --case forearm-skin-hair
```

For foliage use another fresh output directory and `--case forest-merge`. Its
private retained master path must exist and match the manifest and all tracked
originals. Missing/different source data is incomplete verification; it does not
authorize regeneration, source replacement or a lower-resolution run. The runner
rejects source/output overlap before creating destinations, rebuilds the original
numerical bundle in memory to prove unchanged transitive math, and pins its own
bundle independently. Capture stdout/stderr outside the fresh destination for
preflight failures that precede result reporting.

Each completed run writes its own self-contained `gallery.html`, native working
and original-production proof checks, unchanged coverage controls and simultaneous
LLF/proof/comparator memory admission. The forest candidate preserves Rec.2020 and
refreshes the whole-image plus 64-row HDR strip hashes; only the unchanged SDR
proof is assessed. This is not physical HDR, merge/deghost correctness or general
RAW/edit-stack acceptance. Frozen ±25 and stress ±100 strengths remain unchanged.

The two supplemental runs completed in 10.44 s and 18.93 s on RX 7900 XTX;
all eight exact unmasked photographic gates passed. User review prefers Neutral /
Fit for skin; foliage has no clear Fit difference, with global sharpening 50/1/50
or Texture +25 preferred at native scale and no winner selected. The fixed study
stops here, preserving the original method and evidence. Skin-softening and ripple
benefit remain unestablished, with no blanket quality or feature adoption.
See `artifacts/masked-texture/2026-11-14-supplements/user-feedback-01.json` and
`research-conclusion.md` for the exact feedback and bounded conclusion. The next
proposed work is integration design, not further tuning. No app feature is enabled.

The gallery embeds the exact native PNGs and receipts in one HTML file, avoiding
browser sandbox access to sibling files. Native mode uses one source pixel per
CSS pixel; optional Fit changes only viewing scale. Generated evidence remains
unreviewed until a separate photographic assessment is recorded. A numeric pass
does not establish visual benefit, photographic HDR acceptance or performance.

## Method and limits

The pinned Halide example and applicable MIT notice are recorded in the frozen
protocol; retain [`HALIDE-LICENSE.txt`](HALIDE-LICENSE.txt). This mathematical
adaptation uses finite-level clamp boundaries, alpha-weighted signed-asinh
luminance, 97 anchors and only bands 1/2 of a four-level pyramid. It is not
Halide virtual-source-edge parity or another editor's proprietary Texture tool.
No Halide runtime/compiler is added.

Full native buffers are bounded to 24 million pixels and may be refused earlier
by actual device limits or memory policy. Cancellation is checked at bounded GPU
fences. The proof admits finite visible RGB, alpha in [0,1] and |asinh(Y/0.18)|≤6;
unsupported sources are explicitly refused rather than clipped. Hidden RGB is
preserved. The mask blends the reconstructed luminance change once.

Arbitrary active Light/Color/curves, tiled/composed halos, RAW/photographic HDR,
all mask kinds, UI/history/export/restart and other devices remain unqualified.
The source preparation precedes point edits, so neutral-only proofs cannot
establish the insertion point for those broader workflows. Stop after this
candidate and review; no result-driven tuning or automatic candidate cycle.

See the [feature plan](../../../docs/features/masked-texture.md) for remaining
integration work and the dated evidence checkpoint.
