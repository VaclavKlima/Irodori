# Whole-mask edge controls

## Delivery and scope

This is the first edge-quality portion of [TODO 54](README.md#task-54). It adds
nondestructive shaping to existing brush and indicated-object masks. Image-guided
Refine Edge/matting, recovered hair/fur/feather detail, gradients and additional
local operators remain separate work. [Bazzite verification](README.md#task-69)
is a device follow-up; current-device acceptance is recorded below.

Enabled on Mac after the focused checks below. The development app was restarted;
read-only before/after checks confirm the same active photo, revision 78, four
mask identities and every prior setting, with neutral edge defaults and settings 15. No photo edits or imports were performed in the user library for acceptance.
Private readbacks remain under `artifacts/research/mask-edges/2026-11-08/`.

## Coverage controls

Open **Masks → Coverage → Mask edges**. **Feather** accepts 0–64 native-source
pixels in 0.5-pixel steps. **Expand/Contract** accepts −16…+16 pixels in integer
steps; positive expands the selected area and negative contracts it, including
inverted masks. These values use the canonical uncropped source grid, independent
of zoom, crop, lens mapping and output enlargement. They are separate from the
manual brush's Size and Feather percentages.

The controls affect the complete selected coverage: generated base, ordered
Paint/Erase corrections and inversion are composed first, then Expand/Contract
and Feather run. Original base content and correction strokes stay unchanged.
Changing these modifiers can therefore reshape manual corrections too. One Reset
returns both values to zero in a single photo-wide Undo step. Duplication and AI
refinement retain the settings; replacing the AI base retains manual corrections.

Slider/numeric feedback is immediate. Exact coverage updates on release, Enter or
blur; the photograph remains on its previous complete result while preparation
is pending. Edge-enabled brush strokes show immediate cursor/path feedback and
prepare exact coverage on stroke completion. Ordinary zero-edge brush feedback
keeps its existing live behavior. Escape, pointer cancellation and invalid input
restore confirmed values. Valid drafts flush before mask/tab/photo navigation;
external revisions invalidate stale drafts. Saving uses busy/read-only semantics
and preserves focus. Object-selection proposals retain their exclusive Use mask /
Cancel workflow. Errors report their reason and provide Retry GPU; no equivalent
CPU filter or automatic quality reduction runs after failure.

## Shared GPU stage

A single native Dawn/WebGPU implementation prepares complete canonical coverage
for browser SDR/HDR presentation, mask overlays, histograms, Console inspection,
JPEG proofs and frozen exports. Presentation samples that R8 result without
repeating Paint/Erase or inversion. Processing requires no image color samples,
model inference or repeated RAW decoding once authoritative geometry is known.

Expand/Contract is exact grayscale disk dilation/erosion with integer offsets
`dx² + dy² <= radius²`. Feather is a normalized separable Gaussian with sigma
`radius / 3` and support `ceil(radius)`, at most 129 samples per axis. Each stage
replicates the full-source border; fully empty/full masks remain constant and
crop/viewport borders never become mask edges. Float32 strips quantize to R8 once.
At zero/zero the complete new stage is bypassed, preserving the existing pixels.

Full-width 128-row cores retain a halo of `abs(shift) + ceil(feather)` and use
absolute canonical coordinates. Owned buffers retire after queue completion;
submissions check cancellation between strips. Managed admission includes exact
packed brush geometry, source/derived R8 data, Float32 strip buffers, readback,
encoding/transport bounds and existing renderer reservations. Existing image,
atlas, RAM and GPU ceilings remain in force. Oversized requests fail explicitly.

## Ownership, API and persistence

The main-owned coverage service accepts only confirmed photo IDs, revisions and
mask IDs. Paths and worker control remain privileged. It validates source and
revision again before publication, serializes worker work, fences cancellation
and drains owned jobs before deletion/shutdown. AI proposals use a separate
trusted preparation path and final proposal validation; the inference worker
retires before edge processing to avoid overlapping its model allocation.

Disposable derived coverage is keyed by algorithm version, canonical source,
native dimensions, base content, stroke content, inversion and edge values.
Light/name/order and crop/lens-only changes reuse it after authoritative
validation. Derived files share the existing preview disk budget. Returned PNGs
remain bounded to 8 MiB each and 32 MiB per response. Frozen output retains its
own immutable settings and assets; later Editor changes cannot retarget it.

Settings **15** / catalog **25** add `edge: { featherPx, shiftPx }` to each mask.
Migration gives all existing masks neutral values across current settings and
all history snapshots, preserving revisions, cursors, branches, timestamps and
immutable content. Derived coverage never enters durable descriptors/history.
The existing partial mask-update operation and capabilities expose these fields
through UI/API/MCP. Global presets and Copy/Paste continue preserving destination
masks. Neutral Before bypasses local edits.

## Verification

### Focused macOS acceptance — November 8, 2026

Focused acceptance uses macOS arm64, Apple M4 Pro and the common native Dawn
backend. The following receipts retain their exact selection; they are not a
comprehensive checkpoint or physical HDR certification.

- The independent GPU references cover gray coverage, ordered Paint/Erase,
  inversion, exact disk shape, replicated empty/full borders, fractional Feather
  and strip boundaries. The four cases passed in focused reruns:
  [strip reference](../../artifacts/verification/2026-11-08T18-32-11.301Z-check-PrOUK3/summary.md),
  [disk/borders](../../artifacts/verification/2026-11-08T18-32-33.671Z-check-PdCAEF/summary.md),
  [worker cancellation/timeout and PNG](../../artifacts/verification/2026-11-08T18-33-16.701Z-check-CEoAow/summary.md),
  [20 MP maximum settings](../../artifacts/verification/2026-11-08T18-38-22.457Z-check-CWzCTK/summary.md).
  The disk/border invocation also retained a subsequently corrected worker-test
  grayscale decode failure. The unchanged one-code R8 tolerance remains in force.
  At 5496 × 3672, maximum modifiers took 482 ms cold and 473 ms warm in the numeric
  kernel case, with identical R8 hashes and 14,445,205 explicit GPU allocation
  bytes. These exclude process startup/PNG encoding and are not measured physical
  RAM/VRAM peaks or full photographic workflow timings.
- [Eight service and three actual managed MCP cases](../../artifacts/verification/2026-11-08T18-59-19.395Z-check-EBdUSw/summary.md)
  pass, 11/0/0 in 10.90 s. They cover stale source/revision rejection, cache
  validation/release, request-specific cancellation, late final-validation abort,
  resource refusal, actual preview/pair delivery, AI refinement retaining manual
  corrections and edge settings, history/restart, and raster/authored-HDR frozen
  proof/export agreement within the existing two-code bound.
- [Geometry ownership and pending Before](../../artifacts/verification/2026-11-08T19-01-10.937Z-check-VJf9jF/summary.md)
  pass, 4/0/0 in 26.25 s, including type checking, lint, formatting and build.
  Same-photo foreground preparation preserves a required authoritative geometry
  read; settings changes and removal still cancel it. Neutral Before renders
  actual matching RGB pixels while a real coverage response is held pending.
- [The production SAM 2 Sony RAW case](../../artifacts/verification/2026-11-08T19-02-08.549Z-check-OvAyum/summary.md)
  passes, 1/0/0 in 10.35 s, with actual native 5496 × 3672 coverage, HDR presentation,
  revision-bound local-Light histogram and settled neutral Before/After. Its
  initial coverage read may join automatic renderer work; it does not establish
  isolated cold-worker timing.
- [Foreground UI and Sunflower fidelity](../../artifacts/verification/2026-11-08T19-02-48.394Z-check-vfz81s/summary.md)
  pass, 4/0/0 in 14.76 s. Whole-mask inputs, one-step Reset, manual correction
  retention, draft cancellation/external revisions, navigation and restart pass.
  Native 1100 × 700 Console-open geometry, independent scrolling and captures
  are included; the changed surface is visually inspected against the retained
  Sunflower reference.
- [The authored-HDR and cropped synthetic merge-master case](../../artifacts/verification/2026-11-08T19-05-22.622Z-check-VWdB8J/summary.md)
  passes, 1/0/0 in 4.30 s. Ordered Paint/Erase, inversion, fractional rotated crop
  and nonzero modifiers retain the two-code decoded proof/export bound and
  visibly differ from neutral edges. This verifies the merge-master domain, not
  real merged-photograph boundary quality. A test-data mode typo in its initial
  run was corrected; the subsequent standalone type check passes.
  [The additional foreground top-of-section capture](../../artifacts/verification/2026-11-08T19-03-58.362Z-check-2ED8ec/summary.md)
  passes its UI case and confirms the heading and Feather input remain visible
  after scrolling to the top; that invocation retains the corrected test-data
  failure in its separate merge case.

The initial affected batch retained 1004 passes, seven failures and 34
platform-skipped cases; the failures led to the corrected validation, request
ownership, export admission and renderer-array-identity fixes above. The
[later fast Node run](../../artifacts/verification/2026-11-08T18-57-05.089Z-check-fsiXub/summary.md)
has 949 passing Node cases and the same 34 platform skips; its one failing UI
case is resolved by the geometry-ownership receipt. Historical unrelated
platform skips remain incomplete. Existing object-selection acceptance and
photographic quality limitations remain in the [selection brief](object-selection.md).

[Bazzite TODO 69](README.md#task-69) covers both available Radeon adapters and
native Wayland behavior. Windows, real merged-photograph edge-quality review,
image-guided matting and physical HDR measurements remain unverified. Edge
softening/shifting does not recover missing fine detail or prove physical alpha.
