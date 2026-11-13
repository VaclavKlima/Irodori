# Masked photo navigation — issue #116

[#116](https://github.com/VaclavKlima/Irodori/issues/116) owns the reported severe
pan/zoom lag with local masks on Bazzite. It is separate from the stopped
slider-pacer/native-120-Hz study in #46.

## Cause and implementation

The reported photo has four masks, including prepared range/edge coverage. A
read-only profile found a roughly 7.7 MB encoded range plane being repeatedly
walked by JSON serialization during view-only React renders. Preview drag-cancel
and clipping identities, SDR/HDR analysis keys and the presenter's analysis
publication key all participated, even when the image tile cache did no new
pixel work. The real gesture callback also cloned the full mask parameters twice
per move and retained another copy in each performance-timeline measurement.
Direct presenter redraws bypass that callback, so they alone cannot establish
responsive dragging. The user's initial feedback exposed this missing path.

The existing mask controllers now keep immutable parameter objects stable.
Preview and analysis serialize their full identities only when those objects or
their actual pixel dependencies change. Native analysis identity still includes
source, revision, target, domain, comparison and publication ownership. Display
diagnostics alone do not invalidate clipping's pixel target. Full worker payloads
remain available when analysis actually needs a new job.

The gesture callback now captures its immutable drawing parameters once per
edit/coverage change. Performance records retain bounded global control metadata
and scale, with no encoded masks or lens tables. Ordinary view frames no longer
copy large mask payloads into the presenter or the diagnostic timeline.

The HDR presenter reuses one detached parameter snapshot across view-only
requests. A new input object or changed pixel key creates a new snapshot; pending
requests retain their captured values. The normal-publication retry hint uses
the existing pixel identity instead of serializing PNG bytes. That hint remains
separate from authoritative source/revision/target confirmation. Disposal releases
the retained snapshot with the existing GPU-owned state.

No shader, mask order/coverage, color operator, source geometry, sampling quality,
tile-cache policy, GPU backend, resource ceiling or error/retry contract changes.
New source tiles still need their ordinary rendering; warmed navigation reuses
the prepared masks and cached pixels. Original files and edit history remain
unchanged by view-only interaction.

## Verification scope

`hdr-navigation-snapshot` checks detached capture, reference reuse and replacement
on actual changes. `masked-navigation-ui` imports the tracked Sony RAW into an
isolated library, authors a range mask with edge preparation and local Light/Color,
and instruments actual JSON calls and structured clones during warmed pan/zoom.
It checks zero encoded coverage serializations/clones or retained timeline
payloads, no tile/source-upload or histogram restart, exact normal reference
policy, unchanged history and correct invalidation after a local edit.
Its hidden-window timings are diagnostic, not native input/display acceptance.

Reuse affected `masked-preview-confirmation-ui`, `hdr-histogram-lifecycle`,
`hdr-presentation-cache`, `hdr-render-cache` and `hdr-gesture-handoff` checks.
Live private profiles and failed exact reruns remain ignored under
`artifacts/mask-navigation-performance/` and `artifacts/verification/`. No private
photograph or diagnostic payload is added to the repository. Final scoped results,
available-device measurements and other-device limits are recorded in #116.
macOS/Windows follow-up is
[#117](https://github.com/VaclavKlima/Irodori/issues/117).

## Current-device feedback — November 13, 2026

After the actual gesture-copy correction was loaded, the user confirmed
"Yes, it is responsive now." This accepts the reported interaction on the open
Bazzite photo, not universal native frame-rate or cross-platform qualification.
Bounded visible-window wheel-handler probes include warmed navigation and larger
pans exposing additional tiles, with GPU completion, exact view restoration and
unchanged edit history. All user-photo evidence remains private and ignored.
The existing processed-tile cache is reused; no additional full-image cache,
memory-limit increase or changed sampling policy was needed for this correction.

The final seven-target selection passes 1,070 cases with no failures or skips in
94.65 s, including cheap prerequisites, type checking, lint, formatting and build.
The 60-second routine budget warning is retained: the new hidden RAW navigation
case takes 31.72 s and the existing masked-confirmation case takes 8.29 s. No
assertion or quality gate was removed to meet that budget. The final run is
`artifacts/verification/2026-11-13T09-17-27.294Z-check-y3hBpP/summary.md`.

Two bounded visible-window probes exercise the production wheel handler at 100%
on the reported 2901 × 3627 photo in a 2782 × 945 canvas. Sixteen warmed updates
take 24.7–34.6 ms, with no new tiles; sixteen larger-movement updates take
21.2–35.6 ms, including eight newly computed tiles. Both await GPU completion,
restore the original view and preserve complete edit history. These are synthetic
wheel-handler timings, not physical-input or native-120-Hz certification. The
earlier same-view direct-presenter timings are not substituted for this evidence.
Local evidence and source hashes: `artifacts/mask-navigation-performance/summary.md`.
