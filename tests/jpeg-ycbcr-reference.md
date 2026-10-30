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

The current scope is three-component, full-resolution **4:4:4 YCbCr JPEG** exports,
at most 1,048,576 pixels and 16 MiB per compressed input. Unsupported sampling/color
models fail explicitly. Both reader modes request `TJFLAG_ACCURATEDCT`, the accurate
integer IDCT. This bounds the helper's host memory and declares its JPEG precision
without reducing which channels the acceptance evaluates.

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
