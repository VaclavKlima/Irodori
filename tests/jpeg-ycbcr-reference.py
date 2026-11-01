"""Original test transport for independently decoded libjpeg-turbo 3.2.0 samples.

No Ultra HDR or application rendering code is loaded. See jpeg-ycbcr-reference.md
for the pinned API, source, licensing, precision policy and prerequisite contract.
The explicit file mode is a separate bounded test transport, not a shipping limit.
"""

import ctypes
import hashlib
import json
import os
import pathlib
import stat
import sys

SMALL_INPUT_BYTES = 16 * 1024 * 1024
FILE_INPUT_BYTES = 128 * 1024 * 1024
FILE_PIXELS = 33_554_432
FILE_EDGE = 32_768
HEADER_BYTES = 16 * 1024
CHUNK_BYTES = 1024 * 1024


def hash_file(path):
    result = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        while block := stream.read(CHUNK_BYTES):
            result.update(block)
    return result.hexdigest()


def file_input(path, directory):
    original = pathlib.Path(path)
    private = pathlib.Path(directory)
    if original.is_symlink() or private.is_symlink():
        raise ValueError('The file transport requires private regular paths, not symbolic links.')
    original, private = original.resolve(strict=True), private.resolve(strict=True)
    info = private.stat()
    if (not private.is_dir() or stat.S_IMODE(info.st_mode) & 0o077
            or (hasattr(os, 'getuid') and info.st_uid != os.getuid())
            or original.parent != private):
        raise ValueError('The file transport requires an owned private directory and input.')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    with os.fdopen(os.open(original, flags), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) & 0o077
                or before.st_size < 1 or before.st_size > FILE_INPUT_BYTES):
            raise ValueError('The file reference accepts private JPEG inputs up to 128 MiB.')
        data = stream.read(FILE_INPUT_BYTES + 1)
        after = os.fstat(stream.fileno())
        if (len(data) != before.st_size or len(data) > FILE_INPUT_BYTES
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ValueError('The independent JPEG file changed while reading.')
    return data, private


def write_samples(path, output, size):
    """Exclusive private publication without copying the full ctypes output."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb', buffering=0) as stream:
            os.fchmod(stream.fileno(), 0o600)
            view = memoryview(output).cast('B')
            result = hashlib.sha256()
            for start in range(0, size, CHUNK_BYTES):
                block = view[start:min(size, start + CHUNK_BYTES)]
                result.update(block)
                written = 0
                while written < len(block):
                    count = stream.write(block[written:])
                    if not count:
                        raise OSError('Short independent sample-file write.')
                    written += count
            stream.flush()
            os.fsync(stream.fileno())
        if path.stat().st_size != size:
            raise ValueError('Independent sample-file byte count differs.')
        return result.hexdigest()
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def decode():
    fullsize = len(sys.argv) == 6 and sys.argv[3] == '--file-transport-v1'
    if (len(sys.argv) != 3 and not fullsize) or sys.argv[2] not in ('base-ycbcr', 'gain-rgb'):
        raise ValueError('Expected a libturbojpeg path and a declared sample mode.')
    library_path = pathlib.Path(sys.argv[1]).resolve(strict=True)
    mode = sys.argv[2]
    private = None
    if fullsize:
        data, private = file_input(sys.argv[4], sys.argv[5])
    else:
        data = sys.stdin.buffer.read(SMALL_INPUT_BYTES + 1)
        if not data or len(data) > SMALL_INPUT_BYTES:
            raise ValueError('The reference reader accepts JPEG inputs up to 16 MiB.')

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
        raise RuntimeError('The independent JPEG decoder could not be created.')

    def check(status):
        if status != 0:
            raise RuntimeError(library.tjGetErrorStr2(handle).decode('utf-8', 'replace'))

    published = None
    try:
        width, height, sampling, color_space = (integer() for _ in range(4))
        check(library.tjDecompressHeader3(
            handle, data, len(data), ctypes.byref(width), ctypes.byref(height),
            ctypes.byref(sampling), ctypes.byref(color_space),
        ))
        pixels = width.value * height.value
        if fullsize:
            if (width.value < 1 or height.value < 1 or width.value > FILE_EDGE
                    or height.value > FILE_EDGE or pixels > FILE_PIXELS):
                raise ValueError('The file reference is bounded to 33,554,432 pixels and 32,768 per side.')
        elif width.value < 1 or height.value < 1 or pixels > 1024 * 1024:
            raise ValueError('The independent reader is bounded to 1,048,576 pixels.')
        # TJSAMP_444=0 and TJCS_YCbCr=1 are stable public TurboJPEG API constants.
        if sampling.value != 0 or color_space.value != 1:
            raise ValueError('The independent reader requires three-component 4:4:4 YCbCr JPEG.')
        size = pixels * 3
        output = ctypes.create_string_buffer(size)
        # TJFLAG_ACCURATEDCT=4096 requests the accurate integer IDCT (JDCT_ISLOW).
        if mode == 'base-ycbcr':
            if library.tjBufSizeYUV2(width.value, 1, height.value, sampling.value) != size:
                raise ValueError('Unexpected independent planar YCbCr dimensions.')
            check(library.tjDecompressToYUV2(
                handle, data, len(data), output, width.value, 1, height.value, 4096,
            ))
        else:
            # TJPF_RGB=0: numerical gain codes without ICC or extra linearization.
            check(library.tjDecompress2(
                handle, data, len(data), output, width.value, width.value * 3,
                height.value, 0, 4096,
            ))
        header = {
            'protocol': 'irodori-jpeg-reference-v1',
            'mode': mode,
            'width': width.value,
            'height': height.value,
            'sampling': '4:4:4',
            'jpegColorSpace': 'YCbCr',
            'layout': 'planar-y-cb-cr' if mode == 'base-ycbcr' else 'interleaved-rgb8',
            'bytes': size,
            'pythonVersion': sys.version.split()[0],
            'libraryPath': str(library_path),
            'librarySha256': hash_file(library_path),
        }
        if fullsize:
            destination = private / 'samples.bin'
            samples_hash = write_samples(destination, output, size)
            published = destination
            executable = pathlib.Path(sys.executable).resolve(strict=True)
            header.update({
                'protocol': 'irodori-jpeg-reference-file-v1',
                'transport': 'private-binary-file',
                'inputBytes': len(data),
                'inputSha256': hashlib.sha256(data).hexdigest(),
                'samplesFile': 'samples.bin',
                'samplesSha256': samples_hash,
                'idct': 'accurate-integer-jdct-islow',
                'pythonExecutable': str(executable),
                'pythonSha256': hash_file(executable),
                'readerSha256': hash_file(__file__),
            })
            encoded = (json.dumps(header) + '\n').encode('utf-8')
            if len(encoded) > HEADER_BYTES:
                raise ValueError('Independent file reference header exceeds 16 KiB.')
            sys.stdout.buffer.write(encoded)
        else:
            sys.stdout.buffer.write((json.dumps(header) + '\n').encode('utf-8'))
            sys.stdout.buffer.write(output.raw)
    except BaseException:
        if published is not None:
            published.unlink(missing_ok=True)
        raise
    finally:
        library.tjDestroy(handle)


try:
    decode()
except Exception as error:
    sys.stderr.write(str(error) + '\n')
    sys.exit(1)
