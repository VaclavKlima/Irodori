"""Derive mask-only ACES atan2 from exact local Electron/Chromium LLVM sources.

No network, research artifact or Node/D helper is a shipping build input. The
ordinary bridge/include remain unchanged. All upstream arithmetic stays intact.
"""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import sys

REFERENCE = {
    'electron': '44.3.0',
    'v8': '15.2.124.19-electron.0',
    'chromium': '152.0.7977.78',
    'llvmLibcRevision': '3ea89f4304312567e31a8eb45e0737577e65b676',
}
MASK_COMPILER_FLAGS = ['-mno-fma', '-mno-avx', '-mno-sse4.2']


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 3:
        raise ValueError('Usage: prepare-mask.py ABS_PROJECT_ROOT ABS_CARGO_OUTPUT')
    project, output = (Path(value).resolve() for value in sys.argv[1:])
    engine = Path(__file__).resolve().parent
    upstream = engine / 'upstream/electron-llvm'
    metadata_bytes = (upstream / 'sources.json').read_bytes()
    metadata = json.loads(metadata_bytes)
    if metadata['version'] != 'electron-mask-llvm-sources-v1' or metadata['reference'] != REFERENCE:
        raise ValueError('The exact Electron/Chromium LLVM source reference is required.')
    if not isinstance(metadata['files'], list) or not 1 <= len(metadata['files']) <= 256:
        raise ValueError('Invalid bounded LLVM source inventory.')
    source_pins = {}
    for item in metadata['files']:
        name = item['path']
        path = PurePosixPath(name)
        if (not name or len(name) > 256 or
                not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name) or
                path.is_absolute() or any(part in ('.', '..') for part in path.parts) or
                str(path) != name or name in source_pins):
            raise ValueError('Expected a unique bounded local upstream path.')
        data = (upstream / name).read_bytes()
        if len(data) != item['byteLength'] or digest_bytes(data) != item['sha256']:
            raise ValueError('A pinned Electron LLVM source changed: ' + name)
        source_pins[name] = item['sha256']
    chromium_readme = (upstream / 'provenance/chromium-llvm-README.chromium').read_text()
    if 'Revision: ' + REFERENCE['llvmLibcRevision'] not in chromium_readme:
        raise ValueError('The Chromium LLVM source pin changed.')
    v8_wrapper = (upstream / 'provenance/v8-ieee754.cc').read_text()
    if v8_wrapper.count('double atan2(double y, double x) { return LIBC_NAMESPACE::shared::atan2(y, x); }') != 1:
        raise ValueError('The exact V8 LLVM atan2 delegation changed.')
    shim = (engine / 'electron-atan2.h').read_bytes()
    ordinary = output / 'aces_math.inc'
    before = ordinary.read_bytes()
    needle = b'double h_rad = atan2(Aab[2], Aab[1]);'
    replacement = b'double h_rad = irodori_electron_atan2::atan2(Aab[2], Aab[1]);'
    if before.count(needle) != 1 or before.count(b'atan2(') != 1:
        raise ValueError('The exact one-call generated ACES atan2 substitution no longer applies.')
    modified = before.replace(needle, replacement)
    mask_generated = modified.replace(b'irodori_cpu_aces', b'irodori_mask_aces')
    if mask_generated == modified or b'irodori_cpu_aces' in mask_generated:
        raise ValueError('Mask ACES namespace isolation failed.')
    normal_bridge = (project / 'native/irodori-cpu-render/bridge.cpp').read_bytes()
    if normal_bridge.count(b'"aces_math.inc"') != 1:
        raise ValueError('Expected the ordinary bridge to include exactly one ACES translation unit.')
    mask_context = normal_bridge.replace(b'"aces_math.inc"', b'"mask_aces_math.inc"')
    mask_context = mask_context.replace(b'irodori_cpu_aces', b'irodori_mask_aces')
    for name in (b'create', b'destroy', b'render', b'error', b'color'):
        symbol = b'irodori_cpu_' + name
        if symbol not in mask_context:
            raise ValueError('Expected ordinary CPU bridge symbol: ' + symbol.decode())
        mask_context = mask_context.replace(symbol, b'irodori_mask_context_' + name)
    (output / 'mask_aces_math.inc').write_bytes(mask_generated)
    (output / 'mask-context.inc').write_bytes(mask_context)
    if ordinary.read_bytes() != before:
        raise ValueError('The ordinary generated CPU arithmetic changed during mask derivation.')
    arithmetic = {
        'version': 'native-hdr-mask-arithmetic-v3-electron-llvm',
        'reference': REFERENCE,
        'maskCompilerFlags': MASK_COMPILER_FLAGS,
        'ordinaryGeneratedSha256': digest_bytes(before),
        'candidateGeneratedSha256': digest_bytes(modified),
        'maskGeneratedSha256': digest_bytes(mask_generated),
        'normalBridgeSha256': digest_bytes(normal_bridge),
        'maskContextSha256': digest_bytes(mask_context),
        'llvmShimSha256': digest_bytes(shim),
        'upstreamManifestSha256': digest_bytes(metadata_bytes),
        'maskBridgeSha256': digest_bytes((engine / 'mask-bridge.cpp').read_bytes()),
        'maskHostSha256': digest_bytes((engine / 'src/mask.rs').read_bytes()),
        'creativeHeaderSha256': digest_bytes((engine / 'creative-color.h').read_bytes()),
        'creativeAbiSha256': digest_bytes((engine / 'creative-color-params.h').read_bytes()),
        'creativeHostSha256': digest_bytes((engine / 'src/creative.rs').read_bytes()),
        'prepareSourceSha256': digest_bytes(Path(__file__).read_bytes()),
        'upstreamSourcePins': source_pins,
        'substitution': {'count': 1, 'before': needle.decode(), 'after': replacement.decode()},
        'isolation': 'namespace and C symbol renames only',
    }
    encoded = json.dumps(arithmetic, sort_keys=True, separators=(',', ':')).encode()
    arithmetic_sha256 = digest_bytes(encoded)
    (output / 'mask-arithmetic-sha256.txt').write_text(arithmetic_sha256 + '\n')
    capabilities = {
        'version': 'native-cpu-capabilities-v1', 'presentation': 'IRODCPU3',
        'mask': {'request': 'MASKCPU3', 'output': 'MASKOUT1', 'terminal': 'MASKDONE',
                 'mode': '--mask-v1', 'arithmeticSha256': arithmetic_sha256, 'arithmetic': arithmetic},
        'scope': 'Build identity only; independent application numeric and lifecycle verification is required.',
    }
    capability_bytes = (json.dumps(capabilities, indent=2) + '\n').encode()
    if len(encoded) > 64 * 1024 or len(capability_bytes) > 64 * 1024:
        raise ValueError('The bounded runtime capability document is too large.')
    (output / 'mask-arithmetic.json').write_bytes(encoded)
    (output / 'capabilities.json').write_bytes(capability_bytes)


if __name__ == '__main__':
    main()
