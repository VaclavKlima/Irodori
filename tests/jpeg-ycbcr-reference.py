"""Original test transport for independently decoded libjpeg-turbo 3.2.0 samples.

No Ultra HDR or application rendering code is loaded. See jpeg-ycbcr-reference.md
for the pinned API, source, licensing, precision policy and prerequisite contract.
"""

import ctypes
import hashlib
import json
import pathlib
import sys


def decode():
    if len(sys.argv) != 3 or sys.argv[2] not in ("base-ycbcr", "gain-rgb"):
        raise ValueError("Expected a libturbojpeg path and a declared sample mode.")
    library_path = pathlib.Path(sys.argv[1]).resolve(strict=True)
    mode = sys.argv[2]
    data = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if not data or len(data) > 16 * 1024 * 1024:
        raise ValueError("The reference reader accepts JPEG inputs up to 16 MiB.")

    library = ctypes.CDLL(str(library_path))
    pointer = ctypes.c_void_p
    integer = ctypes.c_int
    ulong = ctypes.c_ulong
    library.tjInitDecompress.restype = pointer
    library.tjDestroy.argtypes = [pointer]
    library.tjGetErrorStr2.argtypes = [pointer]
    library.tjGetErrorStr2.restype = ctypes.c_char_p
    library.tjDecompressHeader3.argtypes = [
        pointer, pointer, ulong,
        ctypes.POINTER(integer), ctypes.POINTER(integer),
        ctypes.POINTER(integer), ctypes.POINTER(integer),
    ]
    library.tjBufSizeYUV2.argtypes = [integer, integer, integer, integer]
    library.tjBufSizeYUV2.restype = ulong
    library.tjDecompressToYUV2.argtypes = [
        pointer, pointer, ulong, pointer, integer, integer, integer, integer,
    ]
    library.tjDecompress2.argtypes = [
        pointer, pointer, ulong, pointer, integer, integer, integer, integer, integer,
    ]
    handle = library.tjInitDecompress()
    if not handle:
        raise RuntimeError("The independent JPEG decoder could not be created.")

    def check(status):
        if status != 0:
            raise RuntimeError(library.tjGetErrorStr2(handle).decode("utf-8", "replace"))

    try:
        width, height, sampling, color_space = (integer() for _ in range(4))
        check(library.tjDecompressHeader3(
            handle, data, len(data), ctypes.byref(width), ctypes.byref(height),
            ctypes.byref(sampling), ctypes.byref(color_space),
        ))
        pixels = width.value * height.value
        if width.value < 1 or height.value < 1 or pixels > 1024 * 1024:
            raise ValueError("The independent reader is bounded to 1,048,576 pixels.")
        # TJSAMP_444=0 and TJCS_YCbCr=1 are stable public TurboJPEG API constants.
        # Other JPEG color models or sampling policies need their own declared oracle.
        if sampling.value != 0 or color_space.value != 1:
            raise ValueError("The independent reader requires three-component 4:4:4 YCbCr JPEG.")
        size = pixels * 3
        output = ctypes.create_string_buffer(size)
        # TJFLAG_ACCURATEDCT=4096 requests the accurate integer IDCT (JDCT_ISLOW).
        if mode == "base-ycbcr":
            if library.tjBufSizeYUV2(width.value, 1, height.value, sampling.value) != size:
                raise ValueError("Unexpected independent planar YCbCr dimensions.")
            check(library.tjDecompressToYUV2(
                handle, data, len(data), output, width.value, 1, height.value, 4096,
            ))
        else:
            # TJPF_RGB=0. Gain-map JPEG channels are decoded RGB8 code values, with
            # no ICC/color-management transform or additional linearization.
            check(library.tjDecompress2(
                handle, data, len(data), output, width.value, width.value * 3,
                height.value, 0, 4096,
            ))
        header = {
            "protocol": "irodori-jpeg-reference-v1",
            "mode": mode,
            "width": width.value,
            "height": height.value,
            "sampling": "4:4:4",
            "jpegColorSpace": "YCbCr",
            "layout": "planar-y-cb-cr" if mode == "base-ycbcr" else "interleaved-rgb8",
            "bytes": size,
            "pythonVersion": sys.version.split()[0],
            "libraryPath": str(library_path),
            "librarySha256": hashlib.sha256(library_path.read_bytes()).hexdigest(),
        }
        sys.stdout.buffer.write((json.dumps(header) + "\n").encode("utf-8"))
        sys.stdout.buffer.write(output.raw)
    finally:
        library.tjDestroy(handle)


try:
    decode()
except Exception as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)
