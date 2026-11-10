# Console preview source ownership

[Issue #101](https://github.com/VaclavKlima/Irodori/issues/101) owns this correction.

## Observed failure

Rapid MCP edits, manual edits and Undo/Redo could leave a raster photograph with
**Preview generation cancelled.** and a permanently disabled Crop button. The
full-resolution preview correctly remained unavailable after its source failed.
This failure is independent of the confirmed-mask representation mismatch in
[#102](https://github.com/VaclavKlima/Irodori/issues/102).

The exact managed-MCP test reproduced the original Crop failure on Bazzite after
publication of #102: one failed case, 15.8 seconds. Retained receipt:
`artifacts/verification/playwright-1794344410097-c081177f-5310-4c7f-b6db-6b6d38f5853d/playwright/summary.json`.

A bounded, temporary observer established the actual cancellation owner. The
final revision-5 full-preview request began at 3610 ms; at 3643 ms, a delayed
`requestEditing` from the retained older preview replaced its foreground owner.
The cancelled full-preview request returned at 3644 ms. The normal
HDR/cached/full fallback chain was working correctly. The observer was removed;
its failed diagnostic run remains under
`artifacts/verification/playwright-1794344550871-b046f234-de78-4231-adf1-3faab3a226e9/`.

## Ownership contract

An auxiliary working-pixel request belongs to the full-preview request that
supplied its source. Main must refuse a superseded parent's demand before it can
detach the current foreground owner. A valid auxiliary request retains its normal
source lease and cancellation lifetime. Subsequent readers and retries within
the current source family remain possible; a newer primary source, settings
change, navigation, removal or shutdown invalidates obsolete demand.

The typed preload operation carries the actual parent's request ID. Main keeps
one current primary identity and checks it synchronously before auxiliary
admission. A failed auxiliary operation or release of its own token preserves
the live parent's retry authorization. Parent release revokes that authorization;
an older request's late failure or release cannot revoke a newer parent's identity.

Preserve explicit processing failures and Retry, real navigation/revision
cancellation, source registration, cache identity, managed-MCP frozen targets,
resource limits and GPU/backend policy. This correction does not add a competing
background preparation owner, change algorithms or permit an automatic processing
fallback.

## Focused verification

The managed-MCP regression now requires the final active photograph and revision
to reach prepared and visibly presented full-resolution output before Crop. It
retains the original Crop, unfinished-crop prompt refusal, Undo/Redo, frozen
targets, repeated-conflict, wrong-token and tool-denial checks. Failure-only
diagnostics record source/request/revision and availability state. Test imports
use committed fixtures and isolated profiles; no user library is modified.

The exact rebuilt managed-MCP case passes: one case, 5.3 seconds (6.0 seconds
including runner overhead), foreground. Receipt:
`artifacts/verification/playwright-1794345112350-baec91bf-0b4f-48c5-846a-6789831bb4ac/playwright/summary.json`.
The final photograph reaches revision 5, normal source/presentation readiness,
full resolution and an enabled Crop action without a Retry click.

Two service regressions cover held newer-primary protection; malformed,
cross-photo and superseded parents; working-source failures and retries;
repeated readers; pin retention/release; parent revocation; late old-primary
failure/release; settings changes, removal and shutdown. One synthetic fixture
initially omitted the processing-options provider; its exact corrected rerun
passes, and the original failed receipt remains retained.

One direct UI rerun launched the older application bundle before rebuilding.
That failed receipt is retained at
`artifacts/verification/playwright-1794345070102-951e5080-8fee-414b-9133-c04704051124/`;
it does not establish a post-fix failure. The passing exact receipt above uses
the rebuilt main, preload and renderer.

The first combined focused run passed source-ownership services, fast/static
checks and all three full-preview UI cases, but two older numeric-renderer cases
still expected automatic Canvas2D recovery after GPU loss. Those expectations
contradict the current explicit GPU failure/retry contract and the existing
`raster-presentation-lifecycle` witness. Receipt:
`artifacts/verification/2026-11-10T21-12-05.921Z-check-SYEJw1/summary.md`.
The numeric fixture retains its pre-loss agreement, texture reuse, Before/Split
and numerical tolerance gates; recovery must use explicit Retry GPU and recheck
the recovered output. No production CPU fallback is restored.

The RAW consumer also exposed an obsolete observer: it watched Canvas2D
`drawImage`, while ordinary Bazzite presentation obtains its retained half plane
through a submitted texture-to-buffer readback. The original no-readback failure
is retained at
`artifacts/verification/playwright-1794345475427-e86ddeff-32f1-436b-9e8a-541139b5aedb/playwright/summary.json`.
Its numeric comparison had no pixels to inspect, rather than a measured pixel
disagreement. The replacement witness must bind actual blit/readback ownership
to the completed publication and preserve the existing one-code pre-loss and
two-code final queued-edit limits. The half output is already display-encoded;
the observer must not encode or color-convert it again.

The corrected numeric fixtures pass their exact cases:

- Synthetic raster: 1 passed, 3.4 seconds,
  `artifacts/verification/playwright-1794345402216-f331d961-5390-4e57-a35d-ba151fa5b32f/playwright/summary.json`.
- Photographic raster: 1 passed, 4.3 seconds,
  `artifacts/verification/playwright-1794345436074-9e7ca2fd-caa5-4161-b501-9ee38286ef9c/playwright/summary.json`.
- Sony RAW: 1 passed, 9.1 seconds,
  `artifacts/verification/playwright-1794345815397-d0deed88-1977-4b8b-a184-776fc470436f/playwright/summary.json`.

The RAW case covers actual GPU output, P3/sRGB target transitions, device loss,
explicit Retry on a fresh canvas/device, preserved source identity, queued edits
and Split at the original numerical gates. The observer installs before import,
binds the real blit texture, submitted command, recovery copy, fence and map to
the completed current source/revision/epoch/target snapshot, and retains at most
eight records and 64 MiB of half planes. No CPU staging path is forced. Neither
presentation algorithms nor photographic inputs changed.

## Complete focused acceptance on Bazzite

The accepted selection contains **1,060 distinct passing cases**, with zero
failures/skips in that selection: 1,028 fast cases, 22 source-ownership service
cases, three full-preview UI cases, two numeric raster cases, one numeric RAW
case and all four Console cases. Repeated invocations are not added together.
The consolidated receipt links each accepted case to its original stage/exact
receipt and retains all failed evidence:
`artifacts/verification/2026-11-10-console-preview-recovery/summary.md`.

The final runner passes 1,032 cases, zero failures/skips, 65.00 seconds, explicitly
foreground: `agent-console` plus required static/build/fast checks. Receipt:
`artifacts/verification/2026-11-10T21-24-32.333Z-check-hAuR5Z/summary.md`.
The managed-MCP case completes in 3.72 seconds in that run. Native terminal
focus/paste, minimum Console-open size, divider input, workspace/restart behavior
and request security pass. The routine 60-second warning is retained; no assertion
was removed or cut short. Both the production ownership change and the actual
half-plane observer received independent review without blockers.

macOS and Windows remain incomplete under the existing Console qualification
[issue #100](https://github.com/VaclavKlima/Irodori/issues/100), which explicitly
includes this source-ownership regression. Stand-in CLI/protocol acceptance does
not establish a live authenticated model turn or physical HDR qualification.
No comprehensive checkpoint, benchmark, processing backend change, image-quality
policy change or new photographic asset is part of this correction.
