#!/usr/bin/env python3
"""Generate synthetic Oklab reference vectors independently with Decimal80.

RGB/XYZ matrices are solved from published primary/white chromaticities rather
than imported from Irodori. Oklab forward matrices follow CSS Color 4 2026-10-22;
the inverse is calculated by elimination rather than the published inverse.
Generated numbers and this original reference implementation are CC0-1.0.
"""

from decimal import Decimal, getcontext
import hashlib
import json
from pathlib import Path
import sys

getcontext().prec = 80
D = Decimal
ZERO = D(0)
ONE = D(1)


def matrix(rows):
    return [[D(str(value)) for value in row] for row in rows]


def apply(rows, vector):
    return [sum((a * b for a, b in zip(row, vector)), ZERO) for row in rows]


def inverse(rows):
    augmented = [list(row) + [D(i == j) for j in range(3)] for i, row in enumerate(rows)]
    for column in range(3):
        pivot = max(range(column, 3), key=lambda row: abs(augmented[row][column]))
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(3):
            if row == column:
                continue
            scale = augmented[row][column]
            augmented[row] = [a - scale * b for a, b in zip(augmented[row], augmented[column])]
    return [row[3:] for row in augmented]


def primary_matrix(coordinates):
    columns = [[x / y, ONE, (ONE - x - y) / y] for x, y in coordinates]
    unscaled = [list(row) for row in zip(*columns)]
    x, y = D('.3127'), D('.3290')
    white = [x / y, ONE, (ONE - x - y) / y]
    scales = apply(inverse(unscaled), white)
    return [[value * scales[column] for column, value in enumerate(row)] for row in unscaled]


def cbrt(value):
    if value == 0:
        return ZERO
    magnitude = abs(value)
    estimate = ONE.scaleb(magnitude.adjusted() // 3)
    for _ in range(180):
        refined = (2 * estimate + magnitude / (estimate * estimate)) / 3
        if abs(refined - estimate) <= abs(refined) * D('1e-75'):
            break
        estimate = refined
    return refined.copy_sign(value)


XYZ_TO_LMS = matrix([
    ['0.8190224379967030', '0.3619062600528904', '-0.1288737815209879'],
    ['0.0329836539323885', '0.9292868615863434', '0.0361446663506424'],
    ['0.0481771893596242', '0.2642395317527308', '0.6335478284694309'],
])
LMS_TO_LAB = matrix([
    ['0.2104542683093140', '0.7936177747023054', '-0.0040720430116193'],
    ['1.9779985324311684', '-2.4285922420485799', '0.4505937096174110'],
    ['0.0259040424655478', '0.7827717124575296', '-0.8086757549230774'],
])
PRIMARIES = {
    'srgb': matrix([['.64', '.33'], ['.30', '.60'], ['.15', '.06']]),
    'rec2020': matrix([['.708', '.292'], ['.170', '.797'], ['.131', '.046']]),
}


def main():
    vectors = []
    intensity_vectors = []
    for name, coordinates in PRIMARIES.items():
        rgb_to_xyz = primary_matrix(coordinates)
        xyz_to_rgb = inverse(rgb_to_xyz)
        samples = [[ZERO, ZERO, ZERO]]
        for scale in map(D, ['1e-12', '.0001', '.18', '1', '4', '16']):
            for color in matrix([
                [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
                ['.2', '.5', 1], [1, '.2', '.01'], ['-.1', '.2', '.8'],
                [-1, -1, -1], [-1, 0, 0],
            ]):
                samples.append([value * scale for value in color])
        for rgb in samples:
            xyz = apply(rgb_to_xyz, rgb)
            lab = apply(LMS_TO_LAB, [cbrt(value) for value in apply(XYZ_TO_LMS, xyz)])
            # A separate inverse calculation verifies the Decimal reference too.
            recovered = apply(xyz_to_rgb, apply(inverse(XYZ_TO_LMS),
                [value ** 3 for value in apply(inverse(LMS_TO_LAB), lab)]))
            assert all(abs(a - b) < D('1e-65') for a, b in zip(rgb, recovered))
            source = len(vectors)
            vectors.append({'primaries': name, 'rgb': list(map(float, rgb)), 'lab': list(map(float, lab))})
            for saturation, vibrance in [(0, 0), (-100, 0), (100, 0), (0, 100), (0, -100), (-50, 100), (50, -100)]:
                if saturation == vibrance == 0 or rgb[0] == rgb[1] == rgb[2]:
                    output = rgb
                elif saturation == -100:
                    output = [lab[0] ** 3] * 3
                else:
                    lightness_squared = lab[0] * lab[0]
                    denominator = lightness_squared + 16 * (lab[1] * lab[1] + lab[2] * lab[2])
                    weight = lightness_squared / denominator if denominator else ZERO
                    gain = (ONE + D(saturation) / 100) * (D(2).ln() * D(vibrance) / 100 * weight).exp()
                    adjusted = [lab[0], lab[1] * gain, lab[2] * gain]
                    output = apply(xyz_to_rgb, apply(inverse(XYZ_TO_LMS),
                        [value ** 3 for value in apply(inverse(LMS_TO_LAB), adjusted)]))
                intensity_vectors.append({
                    'source': source, 'saturation': saturation, 'vibrance': vibrance,
                    'rgb': list(map(float, output)),
                })
    output = {
        'source': 'https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code',
        'generatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'precision': 80,
        'license': 'CC0-1.0',
        'vectors': vectors,
        'intensity': intensity_vectors,
    }
    destination = Path(sys.argv[1])
    destination.write_text(json.dumps(output, indent=2) + '\n')
    print(f'Generated {len(vectors)} Decimal80 vectors: {destination}')


if __name__ == '__main__':
    main()
