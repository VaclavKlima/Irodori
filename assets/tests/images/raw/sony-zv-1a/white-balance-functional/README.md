# Sony ZV-1A functional white-balance original

This dataset retains one unchanged RAW original, `originals/capt_DSC07247.ARW`,
from a single completed software capture on the user's Sony ZV-1A. The user
prepared the scene after the [functional capture brief](../../../../../../docs/sony-white-balance-functional-capture.md).
It shows a light, unprinted textured surface with a small defocused darker
sliver near the upper-left edge. Its intended use is functional real-RAW picker
validation: proposal validity, source coordinates, native controls, Apply,
Undo/Redo and restart. Inclusion does not establish that any region passes the
picker's unchanged validity gates.

The [permission notice](NOTICE.md) records the user's project-repository and
testing permission. The photograph has no general open-content license and is
not covered by the code's Apache-2.0 defaults or the numeric fixtures' CC0 terms.

## Original and capture facts

- File: `capt_DSC07247.ARW`, 20,747,264 bytes.
- SHA-256: `8a2e09a6798e303ea2a991139dbc50245aedc218bffe11d614f307b93d7b1cfb`.
- Recording: Sony ZV-1A, single-frame RAW, 12-bit compressed ARW, Orientation 1.
- Requested changes: ISO 125, +1 EV compensation and Manual focus.
- Pre-release readback: Program AE (P), Single Shot, RAW, ISO 125, Automatic
  white balance, Manual focus, +1 EV and 1/30 s. Aperture readback was unavailable
  in that mode; the original EXIF records f/2.5 and a 9.4 mm focal length.
- Complete selected sequence: one operation, one exposure, one completed release
  step and one original file. This was a separate diagnostic capture; other
  capture attempts are not members of this single-frame sequence or this dataset.

The original's sensor-storage dimensions are 5504 x 3672. Full active-image
privacy decoding through `@colorhythm/libraw-wasm` 1.1.1 / LibRaw 0.22.1-Release,
with half-size disabled, produced 5496 x 3672 pixels. This was a WASM decode in
isolated Node, not a native-owned-rows-host or application-processing acceptance.
Final application dimensions must come from its authoritative prepared source.
The original was copied byte-for-byte; its source and destination hashes were
checked before and after copying. Metadata and filename were not rewritten.

## Privacy review

Before proposed repository inclusion on 2026-10-30, independent agent review
covered both complete embedded images, the whole-image context view and six
contiguous, unscaled 1832 x 1836 tiles covering every active decoded pixel.
The parent agent separately completed visual review before authorizing this
dataset preparation. No identifiable people, discernible printing, readable
private documents or screens, addresses, vehicle plates, identifying objects or
private interior details were observed. This describes visible content; it is
not a forensic guarantee about inactive RAW margins or below-resolution detail.

Read-only ExifTool 13.59 inspection covered all 2,139 exposed original metadata
fields, including interpreted and unknown Sony maker fields, and the metadata
of both embedded images. No recognized GPS, camera/lens/internal serial,
owner/name/contact/address or other personal text was observed. Image
descriptions contain whitespace, UserComment is empty, XMP contains only Rating
0, and no IPTC group was reported. Capture timestamps remain present; the camera
clock and timezone were not independently validated. Tool-reported filesystem
paths and private operation journals are not copied into this dataset's docs.

Unknown Sony maker blocks contain opaque numeric/hex/control-bearing payloads.
No coherent personal text or recognized device-serial field was observed; this
review does not certify the semantics of arbitrary opaque or encrypted data.
Review evidence hashes are recorded in the manifest; generated privacy views,
full metadata dumps and private camera identifiers remain outside Git.

## Validation limits

This surface is not a calibrated neutral standard. One scene under unmeasured
lighting does not satisfy the separate two-measured-illuminant color-accuracy
criterion. This is not a calibrated noise reference, clean/noisy pair,
high-ISO qualification, denoising-quality result or performance benchmark.
No picker acceptance, photographic color accuracy or application correctness is
claimed by privacy review or fixture inclusion. Keep the asset out of production
packages and automatic user-library imports.
