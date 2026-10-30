#!/usr/bin/env python3
"""Independent Decimal80 CIE Lab/D65 color-intensity oracle; CC0-1.0.

Derive primaries from chromaticities and invert by elimination. CIE 1976 uses
the published rational epsilon/kappa, with D65 as the declared reference white.
No application functions, constants, or generated shaders are imported.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

helper_path = Path(__file__).with_name('color-reference.py')
spec = importlib.util.spec_from_file_location('color_reference', helper_path)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
D, ONE = reference.D, reference.ONE


def f(value):
    return reference.cbrt(value) if value > D(216) / 24389 else (D(24389) / 27 * value + 16) / 116


def inverse_f(value):
    return value ** 3 if value > D(6) / 29 else (116 * value - 16) * D(27) / 24389


white = [D(3127) / 3290, ONE, D(3583) / 3290]
vectors = []
for primaries, coordinates in reference.PRIMARIES.items():
    matrix = reference.primary_matrix(coordinates)
    inverse = reference.inverse(matrix)
    colors = reference.matrix([
        [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
        ['.2', '.5', 1], [1, '.2', '.01'], ['-.1', '.2', '.8'],
        [-1, -1, -1], [0, '-.1', 1], ['.7', '.45', '.3'],
    ])
    for scale in map(D, ['1e-12', '.0001', '.18', '1', '4', '16']):
        for color in colors:
            rgb = [channel * scale for channel in color]
            xyz = reference.apply(matrix, rgb)
            transformed = [f(channel / w) for channel, w in zip(xyz, white)]
            lightness = 116 * transformed[1] - 16
            a = 500 * (transformed[0] - transformed[1])
            b = 200 * (transformed[1] - transformed[2])
            for saturation, vibrance in [(0, 0), (-100, 100), (100, 100), (0, 100), (0, -100), (-50, 100), (50, -100)]:
                if saturation == vibrance == 0 or rgb[0] == rgb[1] == rgb[2]:
                    output = rgb
                elif saturation == -100:
                    output = [xyz[1]] * 3
                else:
                    denominator = lightness ** 2 + 4 * (a ** 2 + b ** 2)
                    weight = lightness ** 2 / denominator if denominator else D(0)
                    gain = (ONE + D(saturation) / 100) * (D(2).ln() * D(vibrance) / 100 * weight).exp()
                    adjusted = [
                        white[0] * inverse_f(transformed[1] + gain * a / 500),
                        xyz[1],
                        white[2] * inverse_f(transformed[1] - gain * b / 200),
                    ]
                    output = reference.apply(inverse, adjusted)
                vectors.append({
                    'primaries': primaries, 'input': list(map(float, rgb)),
                    'saturation': saturation, 'vibrance': vibrance,
                    'lab': list(map(float, [lightness, a, b])),
                    'output': list(map(float, output)),
                })
output = {
    'version': 'cie-lab-d65-chroma-reference-v1', 'precision': 80,
    'source': 'https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code',
    'referenceWhite': 'D65; not CSS Lab D50', 'license': 'CC0-1.0',
    'sources': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), helper_path]},
    'vectors': vectors,
}
destination = Path(sys.argv[1])
destination.write_text(json.dumps(output, indent=2) + '\n')
print(f'Generated {len(vectors)} Decimal80 CIE Lab/D65 vectors: {destination}')
