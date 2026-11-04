# Tone curves

## Status

**Implemented with focused Bazzite acceptance, November 4, 2026, under #45.** Master, Red,
Green and Blue curves share the photo edit API, version 12 history, preview,
histogram and frozen export. The interactive
[Sunflower study](../design/tone-curves-prototype.html) preceded integration.
The initial focused background selection passes 919 checks in 71.31 s, including
both shader interfaces, migration, real worker sampling, UI/MCP gestures and restart:
`artifacts/verification/2026-11-04T11-12-23.058Z-check-woOQpK/summary.md`.
Photographic, native, warmed performance and bounded integrated-GPU evidence is
recorded below. This does not close unrelated professional-editing gates.

## Goal

Provide precise tonal and channel control across the retained HDR range, including
values above reference white, through the same manual and agent-owned edits.

## Editing

Expand **Curves** below Tonal adjustments in Light. Choose Master, Red, Green or
Blue. Click empty graph space to add a point; drag a point to move it. Endpoints
move too. Inputs stay ordered with 0.0001 minimum spacing; outputs may deliberately
be nonmonotonic. Each channel retains 2–16 points. Delete cannot remove the last
two, and a full channel explains why another point cannot be added.

Coordinates are percentages: **100% means reference white**. Values remain linear
in storage. Both axes display the signed-log mapping
`sign(x) * log2(1 + abs(x) / 0.18)`. Standard shows 0–100%; HDR shows −18–1600%,
with reference white and +1/+2/+3/+4 stops. The initial view follows the current
preview; Fit points includes every authored coordinate. Views never edit pixels,
and the range stays fixed during a graph gesture. The point list exposes every
point, including points outside the graph. Select a row to edit its Input/Output.

Focus the graph: Page Up/Down selects a point, Home/End selects the first/last;
arrows move its input/output by 0.01 percentage points, or 1 percentage point with
Shift. Delete/Backspace removes the selected point. Tab leaves the graph normally.
Numeric fields use the shared commit/cancel behavior: valid typing previews,
Enter/blur commits, invalid departure restores the confirmed value, Escape cancels.
One drag or repeated-key gesture makes one photo-wide history entry. Reset channel
is one edit. **Reset Light** clears all Light controls and all four curves together.
The pinned histogram, photograph geometry and independent inspector scroll remain
owned by the existing workspace.

## Target tones on the photograph

Toggle **Target tones on photo**, then drag up to lighten or down to darken the
sampled tone. Main reads a bounded 5 × 5 region from the oriented, lens-corrected,
uncropped prepared source, retaining source-stage Detail controls. Crop/straighten,
zoom and pan are inverted by the shared source-coordinate mapper. Fully transparent
pixels are ignored; unavailable, empty and out-of-range samples explain the failure.
Master samples luminance after white balance and Light, before Master. RGB samples
the working channel after Master and before its channel curve.

Inputs freeze throughout a gesture. An existing point within six graph pixels is
reused; otherwise dragging adds a point at the sampled input. Clicking without
movement changes neither pixels nor history. Pointer capture survives movement
outside the photograph; Escape restores the starting edit and exits targeting.
Late responses cannot act on another photo, channel, revision or cancelled session.
Sampling acquisition and shader activation have separate timing from warmed dragging.
The interaction follows [Adobe's documented targeted adjustment workflow](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/image-tone-color.html).

## Processing and persistence

The [frozen mathematical policy](tone-curve-processing.md) uses linear points,
shape-preserving PCHIP and rational C1 tails approaching slope one. Graph edges
never clamp image values. Master maps linear XYZ Y while retaining Lab/D65 a/b;
RGB then maps each working channel independently. Identity bypasses exactly.

Order: prepared source → white balance → Light → Master → RGB curves →
Saturation/Vibrance → Mixer → Grading → output mapping. The user explicitly approved
the intensity-before-mixer appearance migration on November 4. Settings 12/catalog
22 migrate every supported history snapshot, retain all numerical edits, add
identity curves and render with the new color order. Existing nonneutral color edits
can therefore look different; Undo/Redo uses the same new policy consistently.
Originals and durable merge masters remain unchanged. The old color oracle is
retained; independent [Decimal80 v2 references](../../assets/tests/references/creative-color-v2/README.md)
cover the new order without changing numerical limits.

WGSL and GLSL are interfaces to the same point operator. There is no full-image
curve CPU renderer or GPU failure fallback. Small scalar calculations validate
points, compile coefficients and sample tones; bounded existing statistics use the
same scalar reference. Curves retain prepared sources and shader programs; only
changed points replace the 3,200-byte parameter data. Rendered variants, histograms,
draft snapshots, equality, commit handoff and frozen exports include curves.

A separate default-selected **Curves** copy group copies the four channels without
Light. Conflicts discard stale drafts and reload confirmed settings. Existing GPU
failure/retry, source-demand and disposal owners remain authoritative.

## Typed API and MCP

`updateEdits(photoId, { curves: { red: [{input: 0, output: 0},
{input: 1, output: 1.1}] } }, expectedRevision)` replaces each provided channel
atomically and preserves untouched channels. Complete settings carry curve version
1, defining `linear-pchip-rational-tail-v1`. Unknown versions/fields, unordered,
duplicate, excessive and nonfinite coordinates reject before persistence.
Coordinates range from −16 through +64 (−1600–6400%).

`sampleCurveTone(photoId, expectedRevision, {channel, x, y})` takes normalized source
coordinates, checks the revision before and after acquisition and returns input,
current output, area, visible sample count, dimensions, channel, reference white,
photo/revision and rendering identity. MCP `irodori_sample_curve_tone` accepts these
coordinates in `curveSample`; `irodori_update_edits` accepts identical channel patches.
`irodori_get_edit_capabilities` describes the frozen policy and limits.

## Remaining boundaries

The existing exact native HDR mask path has no curve operator, and its previous
Float32 GPU replacement failed the unchanged classification gate under #32.
Clipping overlays and exact full-source HDR statistics explicitly report unavailable
while any curve is active; they never omit a curve or evaluate it across a full
image on the CPU. Ordinary rendering, the interactive histogram, rendered-image
statistics and bounded pixel/tone samples remain available. Identity curves retain
existing masks and exact statistics. Qualifying these GPU analysis paths is separate
#32 work; no threshold or failed evidence was discarded.

macOS hardware verification and physical display luminance are unavailable in this
Bazzite run. Photographic/export, integrated-adapter and measured interaction limits
must remain separate from small numerical passes. Broader sustained responsiveness,
strong-noise photographic quality and unrelated calibration remain open.

## Dependencies

Curves reuse the existing prepared-source, white-balance, Light, HDR/raster and
authored-HDR adapters. They precede the existing [output mapping](tone-mapping.md).
Histogram integration follows [HDR analysis](hdr-analysis.md); graph editing
does not depend on an analysis overlay.

## Failure handling

Invalid points leave the confirmed edit intact with an explanation. Unknown curve
versions are rejected. Allocation refusal and device loss preserve authored edits,
release owned resources and use the existing explicit GPU retry. No full-image CPU
curve rendering is attempted. Revision conflicts discard stale drafts and reload
confirmed settings; late sampling responses cannot revive a cancelled gesture.

## Acceptance criteria and evidence

The retained [mathematical limits](tone-curve-processing.md) are unchanged. Independent
Decimal80 vectors cover identity (including signed zero), signed values, black,
reference white, HDR tails, steep/narrow segments, 16 points, continuity and alpha.
WGSL and GLSL pass on RX 7900 XTX; GLSL checks 2,646 vectors per working space with
zero identity/alpha mismatches and maximum error/bound ratio below 0.003.

Focused evidence (all paths are ignored local verification artifacts):

- [Initial integration](../../artifacts/verification/2026-11-04T11-12-23.058Z-check-woOQpK/summary.md):
  919 passed, zero failed/skipped, 71.31 s; model, migration, service sampling,
  graph/numeric/keyboard/UI/MCP/history/restart and reordered-color references.
- [Final graph/targeting cases](../../artifacts/verification/2026-11-04T11-48-53.710Z-check-KPSqbZ/summary.md):
  all three Electron cases and cheap checks passed. The added output test initially
  omitted the established authored-HDR nonnegative-content clamp from its oracle;
  the [exact corrected case](../../artifacts/verification/playwright-1793793269303-944ba68e-5837-459d-909c-e3a6a40ccb4e/playwright/summary.json)
  passes on RX 7900 XTX. Production code and numerical limits did not change for that fix.
- [Targeted source coordinates](../../artifacts/verification/playwright-1793799867311-bf856efa-8869-4344-ac3e-5fe209d4401c/playwright/summary.json):
  the exact RGB case passes in 7.7 s, matching an uncropped-source sample after a
  quarter-turn, 12° straighten, crop, 200% zoom and pan. The created point retains
  that input and commits one history entry.
- [Real-source acceptance](../../artifacts/verification/2026-11-04T11-34-31.697Z-check-VJBA6W/summary.md):
  the genuine Sony v4 review/publication/master case passes in 44.10 s. The
  RAW/raster/ISO case initially waited on an older retained task's status label;
  the [exact rerun](../../artifacts/verification/playwright-1793792296236-b3f95a84-b73f-4b8f-bb36-065f842ecaa2/playwright/summary.json)
  passes in 22.26 s after waiting on the new import's task ID. Coverage includes
  all four curves with spatial/color edits, selective paste, frozen enlarged SDR/HDR
  exports, photographic gain-map JPEG reimport, Undo/Redo and restart. Original
  and durable-master hashes remain unchanged. Failed invocations remain preserved.
- [Foreground fidelity and performance](../../artifacts/verification/2026-11-04T11-42-30.613Z-benchmark-mdEIRS/summary.md):
  891 passed, zero failed/skipped, 75.76 s; Sunflower comparison, real RAW native
  layouts, shader interfaces and the warmed drag benchmark.
- [Final native picker/layout check](../../artifacts/verification/2026-11-04T13-40-25.496Z-check-ufX7NL/summary.md):
  887 passed, zero failed/skipped, 64.92 s. At 1100 × 700 and 1440 × 1000 with
  Console open, graph views preserve photo geometry and the pinned histogram.
  The actual Graph view popup stays open for 3.3 s across nominal Wayland refresh
  periods, closes by choice/Escape/outside click, then permits refresh to resume
  without history changes. Native input uses Electron's event route.
- [Bounded integrated-adapter check](../../artifacts/verification/2026-11-04T13-39-21.855Z-check-8kE5ca/summary.md):
  889 passed, zero failed/skipped, 50.27 s. Actual WGSL adapter annotations confirm
  RADV RAPHAEL_MENDOCINO on PCI 1002:164e (Radeon 610M), Mesa 26.2.4, for independent
  math and production raster/authored-HDR point passes. Electron GLSL continued to
  select RX 7900 XTX with both tested Mesa selectors; integrated GLSL remains
  unverified. No integrated-GPU full-photo performance claim is made.
- [Final service/asset selection](../../artifacts/verification/2026-11-04T13-50-29.127Z-check-hGkmGA/summary.md):
  899 passed, three failed, zero skipped, 48.70 s. All four curve service cases
  pass, including real-worker refusal of full-image CPU curve analysis before any
  source read and retained identity statistics. Static/fast checks and nine existing
  HDR asset cases pass. Three stale HDR asset tests fail identically on an
  [untouched HEAD snapshot](../../artifacts/verification/2026-11-04-tone-curves-head-baseline-2pkkcrb7/playwright/summary.json):
  two supply a retired CPU proof stub without the required GPU capability; one
  expects the historical raster rendering identifier v1 although HEAD uses v2.
  They remain separate #32 verification-maintenance work; no CPU backend or old
  rendering identifier was restored to satisfy them.

Warmed RX 7900 XTX dragging uses the unchanged committed `DSC03280.ARW`, 120 paced
pointer moves per view after native pointer capture, and existing GPU-fence/RAF
presentation instrumentation. Input delivery and visible updates are measured
separately; this is not a physical mouse recording or a 120-Hz claim.

| Measurement              |      Fit |     100% |           Existing gate |
| ------------------------ | -------: | -------: | ----------------------: |
| Achieved input cadence   | 60.13 Hz | 60.13 Hz | report achieved cadence |
| Visible updates          |  59.61/s |  60.12/s |           at least 55/s |
| Input-to-visible p95     |  14.6 ms |  14.4 ms |           at most 33 ms |
| Input-to-visible p99     |  18.7 ms |  18.1 ms |           at most 50 ms |
| Maximum input-to-visible |  21.4 ms |  22.2 ms |          at most 100 ms |
| Longest presentation gap |  25.4 ms |  21.4 ms |          at most 100 ms |
| Final refinement         |  41.6 ms |  34.7 ms |          at most 200 ms |

Each view commits one history entry, retains its source and shows no loader or
source mismatch during dragging. First curve activation is **6,889.9 ms**, measured
separately from the warm path; warm 5 × 5 sample acquisition is **13.5 ms**.
No cold-activation speed claim or broader sustained-responsiveness pass is inferred.
The native desktop reported HDR/display-p3 output and 4.55 stops of headroom;
screenshots and renderer completion do not establish physical luminance.
macOS and physical input-device verification remain unavailable.

## References

- [Shared implementation requirements](README.md#shared-implementation-requirements),
  [input design](../input-design.md) and [edit snapshots](../../src/shared/edits.ts).
- [Frozen curve decision and independent limits](tone-curve-processing.md).
- [Processing ledger](professional-editing-processing.md#45-integration--november-4-2026).
