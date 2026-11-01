# Independent JPEG reconstruction oracle

`jpeg-ycbcr-reference.py`, its typed Node transport and `jpeg-ycbcr-model.helpers.ts`
are original Apache-2.0 test code. They load no application rendering or Ultra HDR reconstruction code. They
dynamically call the public TurboJPEG API of **libjpeg-turbo 3.2.0**, discovered
through that exact `pkg-config libturbojpeg` package and its `libdir`. Python 3
with `ctypes`, `pkg-config`, and that shared-library development package are
explicit acceptance prerequisites on Linux and macOS. An unavailable prerequisite
skips the affected acceptance with a reason; the verification runner must report
that as incomplete. There is no RGB8 or application-decoder fallback. The optional
`IRODORI_TEST_JPEG_REFERENCE_PYTHON` chooses a Python executable.

The pure `jpeg-ycbcr-model.spec.ts` Node target imports only the numerical model;
it never discovers or loads external tools. Actual JPEG decoding and unsupported
input guards belong to the explicit `jpeg-ycbcr-reference.spec.ts` service target.
The combined professional editing acceptance also requires this toolchain before
its isolated Electron fixture can start. All discovery is an explicit function
call, with no probing at helper import time.

The source and API are pinned to [libjpeg-turbo 3.2.0](https://github.com/libjpeg-turbo/libjpeg-turbo/tree/3.2.0)
and its [TurboJPEG header](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.2.0/src/turbojpeg.h).
The library retains its [BSD, IJG and zlib license terms](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.2.0/LICENSE.md).
No third-party implementation is copied or redistributed by these helpers. The
installed package supplies its own license notices. This test library is separate
from the shipping Ultra HDR bundle's pinned libjpeg-turbo 3.1.0. Every result records
the actual shared-library realpath and SHA-256, package/source version, Python
version, JPEG color model, sampling and output layout.

The original stdout transport accepts three-component **4:4:4 YCbCr JPEG** exports,
at most 1,048,576 pixels and 16 MiB per compressed input. These limits remain unchanged.
Unsupported sampling/color
models fail explicitly. Both reader modes request `TJFLAG_ACCURATEDCT`, the accurate
integer IDCT. This bounds the helper's host memory and declares its JPEG precision
without reducing which channels the acceptance evaluates.

## Full-size file transport

`jpeg-ycbcr-fullsize-reference.helpers.ts` selects a separate, explicit
`--file-transport-v1` mode in the same Python reader. Its fixed limits are
33,554,432 pixels, 32,768 pixels per side and 128 MiB per compressed input. It
retains the same accurate integer IDCT, three-component 4:4:4 requirement and
base/gain sample meanings. These are test transport bounds; no application or
shipping codec limit changes.

The helper snapshots the compressed input into an owned directory with mode 0700. Input and sample files use exclusive creation and mode 0600. Python
allocates its bounded full decoded sample buffer, writes it to a private binary
file in at most 1 MiB chunks, then emits only a JSON header of at most 16 KiB.
The sample buffer is at most 96 MiB; this is not a claim that libjpeg-turbo itself
decodes by stripes. The header binds exact dimensions/layout/length, input and
sample SHA-256, the reader script, actual Python executable/version/hash and
the already pinned shared-library identity. TypeScript verifies the complete
sample hash before exposing a handle and checks file identity and exact length
around subsequent reads.

`readRows(top, count)` returns at most 64 rows and 16 MiB. Planar Y, Cb and Cr
offsets use the returned stripe's local height; gain samples remain interleaved
RGB8. Callers retain `top` when mapping rows to the full image. Repeated reads
support independent comparison at multiple headrooms without retaining a full
decoded Node sample frame. Color conversion and gain reconstruction remain in
the existing TypeScript oracle.

On Linux/macOS, each Python command or allowed wrapper runs in its own POSIX
process group. Abort, timeout and oversized-output refusal signal that group
and escalate to SIGKILL. Leader exit also retires remaining group members,
including ordinary wrapper workers that inherit stdout/stderr. The transport
waits for the leader's stdio `close` event before removing its private files.
Wrapper workers must remain in the owned group; independently detached services
are outside this test toolchain contract. Windows retains the existing
unavailable-prerequisite result, with no fallback decoder or weaker cleanup path.

The handle's `close()` is idempotent. Failed opens, failed/invalid stripe reads
and cancellation remove owned files after producer retirement and file-handle
closure. The `jpeg-ycbcr-fullsize-reference` service target checks small generated
JPEG equivalence, limits, corruption, abort and real wrapper-descendant retirement.
Passing this transport target establishes neither full-size photographic HDR
reconstruction nor the application's export/restart acceptance; those require
their separately selected real-source cases.

For the **base image**, the reader returns the native decoded Y, Cb and Cr planes
without RGB conversion. The independent TypeScript oracle uses binary64 full-range
[ITU-R BT.601-7](https://www.itu.int/rec/R-REC-BT.601-7-201103-I/en) conversion, clamps
to [0, 1], applies the analytical sRGB EOTF, and converts linear Rec.709 to Rec.2020
before the existing independent ISO 21496-1 gain reconstruction. It does not copy
the shipping decoder's floating-point constants, lookup tables or half conversion.

For the **gain map**, the reader returns accurate-IDCT **RGB8 code values** without
ICC interpretation. Those numerical gain codes are normalized by 255 and supplied
directly to the ISO formula; they receive no EOTF, gamut matrix or extra color
management. Acceptance separately requires them to equal Sharp's ICC-ignored
gain-map bytes. Base and gain JPEGs intentionally have different precision roles.

Ordinary SDR readers convert the base to rounded RGB8. Those bytes are still
checked separately against the exported SDR primary, but they are unsuitable as
the HDR reconstruction oracle's starting samples. At YCbCr [253, 126, 129], the
floating base's blue is 0.9782588235294118 whereas RGB8 decoding yields 249/255.
On the retained synthetic gain-map round trip, that extra rounding produced
0.020013636522662637 error at headroom 4.673103433930707. Raw base samples reduced
the same pixel's error to approximately 0.004902 and the complete image's maximum
to approximately 0.006798. Every channel and both declared headrooms retain the
strict **error < 0.02** gate; edge pixels, high gain and nonfinite results are not
excluded. These measurements diagnose an oracle precision mismatch, not photographic
quality, physical HDR display behavior or complete GPU/CPU pipeline accuracy.
