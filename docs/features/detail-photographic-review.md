# Native photographic sharpening review

## Scope — November 14, 2026

This bounded current-device continuation of
[#43](https://github.com/VaclavKlima/Irodori/issues/43) reviews the existing saved
Detail sharpening operator. It adds the reviewed anonymous skin/body-hair input
and selected control extremes to the retained standard-setting photographic
evidence. Noise-reduction research, export-only output sharpening and performance
studies retain their separate owners. No processing algorithm, control mapping,
cache version, numerical threshold or resource policy changes.

The [fixed protocol](../../assets/tests/references/detail/photographic-sharpening-v1.json)
is frozen before active rendering. All variants use Luminance/Color noise 0/0,
As Shot white balance and neutral point edits. Filtering precedes crop extraction:
each PNG pixel is one pixel from the finished full-native frame, preserving all
neighboring source pixels. Generated images and evidence stay outside Git.

| Variant           | Amount | Radius | Threshold |
| ----------------- | -----: | -----: | --------: |
| Neutral           |      0 |      1 |        50 |
| Standard          |     50 |      1 |        50 |
| Fine, unprotected |    100 |    0.5 |         0 |
| Wide, unprotected |    100 |      3 |         0 |
| Wide, protected   |    100 |      3 |       100 |

These selected extremes characterize the existing manual range; they are not
recommended defaults or a parameter sweep. The original standard-setting noise,
edge, alpha and numerical gates remain unchanged. Real photographs provide no
clean/noisy ground truth, so displayed texture/grain changes are qualitative
evidence, not percentages of noise removed or recovered detail.

## Sources and exact native crops

| Source                                 | Working dimensions | Native 512 × 512 crops                                               | Meaning and limits                                                                                                                                            |
| -------------------------------------- | ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zephyris, archived `ArmHair.jpg`       | 4272 × 2848        | Skin: left 2800, top 350; hair contours: left 1150, top 1000         | Reviewed skin/body hair, authored processed SDR JPEG; no face/scalp-hair, RAW or clean-reference claim. CC BY-SA 3.0.                                         |
| AURA, ESO `eso0106a.jpg`               | 651 × 651          | Central stars: left 69, top 69; faint/edge stars: left 0, top 139    | Published processed U-band telescope JPEG; the central optical cross predates Irodori. No photometry, astrophotographic RAW or physical HDR claim. CC BY 4.0. |
| Retained forest `sony-merge-v4` master | 3645 × 5465        | Foliage: left 1760, top 1760; deghost transition: left 2344, top 281 | Genuine master from the tracked, reviewed Sony DSC03277/278/279 bracket. Project testing permission; no general open-content license.                         |

The [forearm manifest](../../assets/tests/images/raster/wikimedia/forearm-hair/manifest.json),
[starfield manifest](../../assets/tests/images/raster/eso/observed-starfield/manifest.json)
and [forest manifest](../../assets/tests/images/raw/sony-zv-1a/forest-bracket/manifest.json)
retain original hashes, attribution, privacy review and permission. Historical
portrait inputs are ineligible for new acceptance under the current fixture
policy. Their earlier evidence remains preserved and was not rerun.

The retained master comes from the passing October 31 acceptance invocation. Its
manifest, Float32 asset and motion mask are checked before and after this review,
and its source identities must match all three tracked unchanged originals.
The master is read without recomputing a retired merge executor. The selected
boundary was found from the retained source mask alone before filtering: at
native center (2600, 537), vertical samples at y - 32 and y + 32 span 255 to 0. The cropped master maps to that mask with offset (+15, 0). The 512-pixel
region contains both endpoints and feathered intermediate values. This qualifies
review of a reference-fallback blend transition, not known-truth motion removal.

## Photographic findings

The primary and independent agent reviews cover all six native boards. At
50/1/50, the skin/body-hair effect is very restrained, hair paths remain in
place, leaf contours retain their structure, and the inspected stars retain
their visible positions and single outlines. No obvious new broad halo,
smearing, rectangular processing seam or deghost-transition discontinuity was
found at that setting. This is bounded qualitative review, not human approval
or a guarantee for every photographic subject.

At 100/3/0, skin and starfield grain becomes substantially more conspicuous,
hair/leaf contrast grows and compact stars gain hard dark rims. Threshold 100
suppresses much of the weaker grain emphasis but does not eliminate strong-edge
rims at maximum Amount/Radius. The fine-radius extreme has a smaller visible
effect in these crops. These stress observations do not imply a newly broken
numerical or geometry contract, and the extreme settings are not recommended
as defaults. No algorithm change or threshold relaxation is justified by this
review. The safe action is to retain the standard starting point and inspect
strong settings at native scale.

In the subsequent gallery review, the user found Neutral less grainy and
Standard crisper on the starfield. The leaves looked blurry in both Neutral
and Standard, and Wide unprotected looked best for that foliage example.
This records a useful subject-dependent preference: the stronger setting can
give soft foliage more definition while its grain/rim tradeoff remains visible
on other subjects. The user suggested that the foliage softness might come
from the photograph; this review does not identify whether capture, source
processing or merging caused it. The feedback does not select a new universal
default or change the frozen numerical gates. The earlier agent findings and
source limitations remain preserved.

The available-device matrix is complete within its declared source/settings
scope. General face/scalp-hair appearance, quantitative star photometry,
clean-reference texture/noise fidelity, physical HDR presentation and other-device
photographic acceptance remain unqualified. Existing historical portrait evidence
does not convert this body-hair input into portrait acceptance.

## Production path and evidence

`scripts/research/detail-photographic-review.mjs` bundles an isolated Node worker
and uses the current `PreviewProcess`. Rasters retain linear sRGB and their
authored display transform; the merge retains scene-linear Rec.2020. Neutral
sources are prepared once. Active settings go through the separate production
`prepareDetailPreview` variant and its GPU proof owner; simply adding Detail
settings to a direct `renderFull` request would not exercise sharpening.

The completed matrix has three sources × five settings = **15 native frames**,
with two crops per frame. All **12 active variants** report GPU filtering,
**8,352 GPU tiles**, zero CPU tiles and zero precision-repair tiles on
`amd-radeon-rx-7900-xtx-radv-navi31`, Mesa 26.2.6. GPU proof requests remain
explicit. Automatic policy uses the conservative unverified-adapter VRAM budget
of 2 GiB and the observed RAM budget of approximately 8.17 GB; no capacity match,
override, opaque peak-memory or iGPU acceptance is claimed.

Generation took **32.277 seconds** including preparation, full-source filtering,
proof rendering, hashing and PNG extraction. This is diagnostic elapsed time,
not a production latency benchmark. The new launcher's initial setup-only failure
loaded TypeScript before bundling; the corrected launcher defers those imports
to its bundled worker. No image processing ran in that failed attempt. The
failure log, successful generator and executed worker are preserved separately.

The local evidence root is
`artifacts/detail-review/2026-11-14-native-sharpening/`.
Read `summary.md` first when the review is complete. `run-02/summary.md` retains
the producer's generated-awaiting-visual-review status; actual visual findings
belong in a separate review receipt. Per-frame results, exact original/source/
protocol/code hashes and native PNGs remain linked from `run-02/result.json`.
Native crop differences are descriptive SDR code changes, not clean-reference
noise or detail scores.

## Reproduction and verification

Build the current native prerequisites and production worker as documented in
the README. Run the helper with the committed protocol, a fresh output directory
and the exact retained master specified in the protocol/evidence:

```sh
node scripts/research/detail-photographic-review.mjs --protocol assets/tests/references/detail/photographic-sharpening-v1.json --master /absolute/path/to/accepted-master --output artifacts/detail-review/NEW-RUN
node scripts/research/render-detail-review.mjs artifacts/detail-review/NEW-RUN/result.json artifacts/detail-review/NEW-PROOFS
```

The renderer validates native crop hashes and dimensions, places them without
resampling and retains source credits, license links and descriptions of changes.
Open the HTML gallery at native scale for comparison; the helper opens no window.
The HTML embeds the exact board PNGs and downloadable protocol/hash data, so a
sandboxed browser can display it when a file portal grants access to only the
HTML file. Source and license links remain ordinary public URLs. A browser check
loads the HTML alone in an otherwise empty directory, decodes all six images at
their native dimensions and verifies their hashes against the reviewed boards.
No user library or automatic imports are involved. Missing/mismatched inputs,
invalid native crop bounds, CPU filter execution or modified sources fail the
run explicitly rather than substituting a different source or backend.

Reuse the already completed numerical, supersession, retry, history/export and
contention evidence recorded in the [detail contract](detail-processing.md) and
[combined processing record](professional-editing-processing.md). Relevant fast
checks cover the new tooling and the existing `detail-quality` target. No broad
checkpoint or whole-source CPU oracle is required for this unchanged operator.
Foreground interaction and physical HDR presentation remain separate checks.

The completed `detail-quality` invocation passes **1,070 checks in 62.98 seconds**,
zero failures/skips: typecheck, lint, format, build, Node and service stages.
The routine time warning was inspected; all ten slowest cases pass. An initial
unused-variable lint failure in the new proof renderer was fixed and passed its
focused lint rerun before the completed invocation. Its generated pixels are
unchanged. The original failure and both captioned proof sets remain preserved;
no extra GPU/photo run followed. Delivery status is tracked in #43, with the
stated photographic limits preserved independently of publication.
