# Final-output-size proof — TODO #47

Custom JPEG export includes **Output preview**, with independently scrolling
settings beside a neutral photograph canvas and fixed Back, Cancel and Export
actions. Quick export retains its existing chooser. This feature previews an
actual temporary JPEG, including compression, at its effective export dimensions.
It requires no destination and changes neither photo history nor Last custom.

## Interaction

Choose **Preview output** to generate the first proof. Pixel-affecting changes
(effective SDR/HDR output, quality or size) cancel obsolete work, retain the
previous image with **Preview out of date**, and require **Update preview**.
Names, metadata, collision handling and destination do not invalidate pixels.
Export remains available with valid settings, including without a proof.

The caption identifies the output filename, SDR/HDR, JPEG quality, dimensions and
Original size or Lanczos3. Fit never enlarges. At 100%, one output pixel equals
one CSS pixel, independent of device density. The shared geometry, wheel and pan
controllers support pointer anchoring, middle/primary drag, Ctrl-wheel, ordinary
wheel panning, a native zoom select and keyboard F/0 (Fit), 1 (100%), +/− and arrow
panning (Shift for larger steps). These keys stay inside the focused proof region.

Previous/Next traverse the frozen export set without changing library selection.
The initial proof photograph is the Editor active or Library focused target when
included, otherwise the first target. Changing photograph resets to Fit. Updating
the same photograph retains its normalized center, including after resizing.
Local Auto/HDR/SDR display choice persists through batch proof navigation and
starts from the current workspace display preference. It writes no preference.

The underlying Editor stays mounted. The existing suspension path stops its
processing and presentation while Custom proofing is open and preserves its view.
Back, Cancel, Close and Escape cancel proof work; proof generation does not engage
the export-acceptance busy-close restriction. Back restores focus to Custom…;
closing the dialog uses the existing application focus owner.

## Shared service and bounds

`OutputProofs` resolves a single source from an existing export preparation. Source
identity, revision, processing settings and pipeline versions remain frozen.
Expired, changed or disposed preparations require reopening Export. Proof identity
includes these fields and canonical pixel options; it excludes naming/metadata.

The existing `ExportProcess` runs the normal crop, detail, point rendering,
Lanczos3 and JPEG encoder stages. It resolves only after the exporter exits.
An independently owned bundled-Node `PreviewProcess` then decodes the JPEG; decoder
and encoder heaps never coexist. SDR frames have validated dimensions, length and
SHA-256. HDR decoding retains authored Rec.2020 content and the independently
decoded SDR primary. The viewers use neutral controls, with no repeated crop,
lens correction, adjustments or ACES scene rendering. HDR failure reports the
actual reason and offers Retry GPU; explicit SDR shows the embedded primary.
Retry refreshes capabilities without saving a display preference or re-encoding.

Proof generation is globally serialized. Only the same owner can replace/cancel
its candidate; Console requests cannot cancel dialog work. At most two completed
descriptors coexist while a displayed proof is replaced or a Console overview is
returned. Requests are bounded and carry distinct tokens. The normal scheduler,
export source protection, working-source leases, RAM/VRAM admission and 2 GiB
preview storage budget apply. Decoder admission accounts for JPEG/codec, primary,
HDR and overview allocations in addition to existing image owners. Oversized work
is refused without changing the requested dimensions or quality.

Only leased opaque frame URLs cross the bridge. Open file descriptors and stream
pins keep files owned through real I/O drainage. Cancellation, renderer disposal
and shutdown stop workers and release assets after their streams/presenters drain.
Startup removes interrupted application-owned `cache/output-proofs` scratch.
Completed proofs retain only decoded assets and a small overview; intermediate
source/output files are removed. Bitmap/GPU proof ownership is transient: no
persistent proof cache, catalog migration or alternative rendering backend is added.

## Console

`irodori_get_output_proof` takes `preparationId`, `photoId`, validated full export
`options`, and a distinct UUID `proofToken`. The integrated Console additionally
requires its normal frozen `requestId`, owned export preparation and authorized
photo target. It uses exactly the same proof service as the dialog.

The response includes source revision, pixel identity, output dimensions, quality,
resize method and pipeline versions plus a clearly labelled **SDR overview of the
decoded JPEG primary**. Overview dimensions are separate from output dimensions;
the overview has a longest edge of at most 1024 pixels and a JPEG payload of at
most 1 MiB. Only the overview can use a smaller edge for high-entropy images;
the actual JPEG and full decoded planes keep the requested dimensions/quality.
Full-resolution/HDR inspection belongs to the dialog. Full assets are
released before the response returns. The existing compact edited-photo preview
tool retains its separate role and unchanged limits.

## Verification and acceptance

Focused targets are `export-proof-model`, `export-proof-service`,
`export-proof-rendering`, `export-proof-ui`, `export-proof-mcp` and
`export-proof-native`. The native target requires explicit `--foreground` for
keyboard, pointer lock, actual select-popup lifetime and HDR monitor integration.

Focused Bazzite acceptance is complete on November 7, 2026: **995 distinct cases
pass across the retained batches and exact reruns**, with no unresolved selected
failures or deferrals. The [summary and receipts](../../artifacts/output-proof/2026-11-07-acceptance/summary.md)
retain all failed attempts, the foreground rerun of the background-only deferral,
native captures, exact commands and platform/client limits. Invocation counts
overlap and must not be added together.

- Committed raster, actual Sony RAW, generated authored-HDR and existing v4 merge
  fixtures agree with independently decoded exports within two SDR code values;
  independent linear Rec.2020 chart reconstruction remains below 0.02 error.
  Original, reduction, Fit within, bounded enlargement and quality changes pass.
- RX 7900 XTX / RADV NAVI31 covers actual original-size Sony SDR and cropped HDR
  enlargement. The integrated Radeon / RADV RAPHAEL_MENDOCINO covers bounded
  raster/HDR/merge proof comparisons. Both record Mesa 26.2.6; this is focused
  adapter evidence, not full platform qualification.
- Native 1100 × 700 Console-open keyboard, pointer lock, picker choice/Escape/
  outside dismissal across actual refresh periods, HDR/independent SDR primary,
  actual GPU device loss/retry and healthy Editor source reuse pass. The native
  tests require an idle desktop and actual HDR monitor readiness before import.
- Selected export acceptance/enlargement, raster recovery, HDR JPEG/source-cache,
  Sunflower and legacy editing-MCP regressions pass. Type checking, lint,
  formatting and the production build pass. The normal 60-second verification
  warning retains all assertions and recorded slow-case evidence.

macOS, Windows, physical luminance/color accuracy and a live signed-in Console
client remain unverified. Managed Console protocol/authorization is covered by
isolated SDK tests. No comprehensive checkpoint or performance benchmark is part
of #47. Output sharpening #48, FSR #49 and local masking remain separate.
