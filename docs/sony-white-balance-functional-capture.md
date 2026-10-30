# Sony ZV-1A functional white-balance capture

## Why another input is needed

The reviewed ISO400 fog and carpet/paper originals fail the picker's unchanged
0.04 log-scatter rule in fixed bounded grids. Independent reads reproduce the
paper's pixel variation in both the app's prepared source and a separately
retained native LibRaw decode. This does not establish a valid picker workflow
or prove every cause of the variation. A brighter, lower-noise original provides
a separate positive functional input; do not loosen the gate to accept these
previous photographs.

## Physical setup

Place plain matte white paper in bright, even light. Diffuse window daylight is
preferred; one steady lamp is also suitable. Use one light source, keep the paper
out of glare and hard shadows, and keep hands/printed text out of the frame.
The sheet should cover most of the picture, with a little plain surroundings
visible. Rest the camera securely and focus on the paper before leaving it still.
No carpet or textured target is needed for this capture.

The camera remains connected by USB in PC Remote mode. The agent handles settings
and the shutter; the user only needs to arrange the subject and lighting. If
the camera was moved or disconnected, recheck the actual scene and connection.

## Bounded agent capture

Discover the exact device and advertised controls through the
[camera MCP](camera-control.md), recording its initial settings. Use single-frame
RAW, ISO125 and f/4 when advertised. Choose the actual manual shutter after
checking current metering/readback; typical indoor starting points are 1/4–1s,
but those are exposure suggestions, not measured settings for this room.
The target is a well-exposed, unclipped paper area, not a clipped white frame.

Take one original, inspect its unchanged RAW/embedded-preview metadata and
exposure, then adjust only if needed. Limit this diagnostic to three total
separate captures, each with its own request ID and complete terminal result.
Never repeat an uncertain shutter request. Do not use unverified native burst,
RAW/JPEG pairing or exposure-sequence behavior for this test. Close the session
and check restoration after the final capture or any failure.

Keep every original/hash/metadata record private until whole-image,
embedded-preview and EXIF/XMP/IPTC review. Promote only suitable reviewed inputs
under `assets/tests/images/raw/sony-zv-1a/`, with original bytes, provenance and
the user's project-repository inclusion permission, before acceptance use.
Record every capture and rejected input, not only a successful region.

## Validation scope and sources

This input tests real-RAW proposal validity, source coordinates, native controls,
Apply, history and restart. Plain paper is not a calibrated neutral standard;
one unmeasured light does not satisfy the separate two-measured-illuminant color
accuracy criterion. Do not infer photographic color accuracy from a valid patch.

Sony's [ZV-1A manual, ISO section, printed page150](https://helpguide.sony.net/dc/2410/v1/en/print.pdf#page=150)
explains the noise sensitivity tradeoff and the reduced dynamic range below
ISO125. Its [custom-white-balance tutorial, printed page160](https://helpguide.sony.net/dc/2410/v1/en/print.pdf#page=160)
demonstrates using a white target under the shooting light. The
[Manual Exposure guide](https://helpguide.sony.net/dc/2410/v1/en/contents/0302C_manual_exposure.html)
explains aperture/shutter adjustment and metering. Use the exact camera's current
advertised settings rather than assuming every published value is writable over
USB. Existing [PC Remote instructions](https://helpguide.sony.net/dc/2410/v1/en/contents/0903_pc_remote_function.html)
cover the data connection.
