#!/usr/bin/env python3
"""Independent Decimal80 relative-mask-color oracle; CC0-1.0.

Derives RGB matrices from primary chromaticities, inverts Bradford by elimination,
and evaluates complete XYZ/Lab transforms. Imports no application implementation.
"""
from decimal import Decimal as D
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

helper = Path(__file__).with_name('color-reference.py')
spec = importlib.util.spec_from_file_location('color_reference', helper)
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)
ZERO, ONE = D(0), D(1)
WHITE = [D(3127) / 3290, ONE, D(3583) / 3290]
BRADFORD = ref.matrix([
    ['.8951', '.2664', '-.1614'],
    ['-.7502', '1.7135', '.0367'],
    ['.0389', '-.0685', '1.0296'],
])


def product(a, b):
    return [[sum((a[r][k] * b[k][c] for k in range(3)), ZERO)
             for c in range(3)] for r in range(3)]


def locus(k):
    # Kang et al. 2002, as retained by Irodori's global-WB model.
    x = (-D('3.0258469e9') / k ** 3 + D('2.1070379e6') / k ** 2
         + D('.2226347e3') / k + D('.24039'))
    y = D('3.081758') * x ** 3 - D('5.8733867') * x ** 2 + D('3.75112997') * x - D('.37001483')
    denominator = -2 * x + 12 * y + 3
    return [4 * x / denominator, 6 * y / denominator]


def target_white(color):
    if color['temperature'] == color['tint'] == 0:
        return None
    k = D('1e6') / (D('1e6') / 6500 + D('.5') * color['temperature'])
    anchor, point, before, after = locus(D(6500)), locus(k), locus(k - 1), locus(k + 1)
    dx, dy = after[0] - before[0], after[1] - before[1]
    length = (dx * dx + dy * dy).sqrt()
    denominator = WHITE[0] + 15 + 3 * WHITE[2]
    u = 4 * WHITE[0] / denominator + point[0] - anchor[0] - dy / length * color['tint'] * D('.0001')
    v = 6 / denominator + point[1] - anchor[1] + dx / length * color['tint'] * D('.0001')
    return [3 * u / (2 * v), ONE, (4 - u - 10 * v) / (2 * v)]


def balance(color, rgb_matrix):
    white = target_white(color)
    if white is None:
        return None
    source, target = ref.apply(BRADFORD, WHITE), ref.apply(BRADFORD, white)
    diagonal = [[target[r] / source[r] if r == c else ZERO for c in range(3)] for r in range(3)]
    adaptation = product(product(ref.inverse(BRADFORD), diagonal), BRADFORD)
    return product(product(ref.inverse(rgb_matrix), adaptation), rgb_matrix)


def power(value, exponent):
    return (value.ln() * exponent).exp() if value else ZERO


def light(rgb, controls, scene, white):
    if not any(controls.values()):
        return rgb
    rgb = [v * power(D(2), D(str(controls['exposureEv']))) for v in rgb]
    if not scene:
        rgb = [max(ZERO, v) for v in rgb]
    weights = ref.matrix([['.2627002120112671', '.6779980715188708', '.059301716469862']
                          if scene else ['.2126', '.7152', '.0722']])[0]
    normalization = ONE if scene else white

    def luminance():
        return sum((v * w for v, w in zip(rgb, weights)), ZERO) / normalization

    def scale(factor):
        return [v * factor for v in rgb]

    y = luminance()
    if controls['contrast'] and 0 < y < 1:
        exponent = power(D(2), D(controls['contrast']) / 100)
        next_y = (D('.18') * power(y / D('.18'), exponent) if y <= D('.18') else
                  ONE - D('.82') * power((ONE - y) / D('.82'), exponent))
        rgb = scale(next_y / y)
    y = luminance()
    if controls['highlights'] and y > D('.18'):
        h, delta = D(controls['highlights']) / 100, y - D('.18')
        rgb = scale(((ONE + h) * y - h * (D('.18') + D('.82') * delta / (D('.82') + delta))) / y)
    y = luminance()
    if controls['shadows'] and 0 < y < D('.18'):
        rgb = scale(power(D(2), D(2 * controls['shadows']) / 100 * (ONE - y / D('.18')) ** 2))
    y = luminance()
    if controls['whites'] and y > D('.18'):
        t = max(ZERO, min(ONE, (y - D('.18')) / D('.82')))
        rgb = scale(power(D(2), D(controls['whites']) / 100 * t * t * (3 - 2 * t)))
    y = luminance()
    if controls['blacks'] and y >= 0:
        delta = D('.04') * D(controls['blacks']) / 100 * max(ONE - y / D('.18'), ZERO) ** 3
        if controls['blacks'] > 0:
            rgb = [v + delta * normalization for v in rgb]
        elif y > 0:
            rgb = scale(max(ZERO, y + delta) / y)
    return rgb


def lab_f(value):
    return ref.cbrt(value) if value > D(216) / 24389 else (D(24389) / 27 * value + 16) / 116


def inverse_f(value):
    return value ** 3 if value > D(6) / 29 else (116 * value - 16) * D(27) / 24389


def saturation(rgb, amount, matrix, white):
    if amount == 0 or rgb[0] == rgb[1] == rgb[2]:
        return rgb
    xyz = ref.apply(matrix, [v / white for v in rgb])
    if amount == -100:
        return [xyz[1] * white] * 3
    fx, fy, fz = [lab_f(v / w) for v, w in zip(xyz, WHITE)]
    gain = ONE + D(amount) / 100
    changed = [WHITE[0] * inverse_f(fy + gain * (fx - fy)), xyz[1],
               WHITE[2] * inverse_f(fy + gain * (fz - fy))]
    return [v * white for v in ref.apply(ref.inverse(matrix), changed)]


NEUTRAL_LIGHT = dict(exposureEv=0, contrast=0, highlights=0, shadows=0, whites=0, blacks=0)


def mask(temperature=0, tint=0, saturation=0, coverage=1, enabled=True, **controls):
    return dict(color=dict(temperature=temperature, tint=tint, saturation=saturation),
                light={**NEUTRAL_LIGHT, **controls}, coverage=coverage, enabled=enabled)


CASES = [
    dict(id='neutral', masks=[mask()]),
    dict(id='warm', masks=[mask(100)]),
    dict(id='cool', masks=[mask(-100)]),
    dict(id='magenta', masks=[mask(tint=100)]),
    dict(id='green', masks=[mask(tint=-100)]),
    dict(id='desaturate', masks=[mask(saturation=-100)]),
    dict(id='saturate', masks=[mask(saturation=100)]),
    dict(id='color-only', masks=[mask(temperature=-58, tint=39, saturation=-50)]),
    dict(id='balance-light-saturation', masks=[mask(67, -38, 75, exposureEv=.35,
         contrast=27, highlights=-31, shadows=23, whites=17, blacks=-9)]),
    dict(id='one-half-blend', masks=[mask(42, 27, 68, coverage=.5, exposureEv=-.4, contrast=-37)]),
    dict(id='ordered-mixed', masks=[mask(42, 27, 68, coverage=.5, exposureEv=-.4, contrast=-37),
         mask(-63, -22, -35, exposureEv=.3, shadows=17, blacks=9)]),
    dict(id='zero-coverage', masks=[mask(100, 100, 100, coverage=0, exposureEv=1)]),
    dict(id='disabled', masks=[mask(100, 100, 100, enabled=False, exposureEv=1)]),
]


def stack(rgb, case, matrix, scene, white):
    for item in reversed(case['masks']):
        if not item['enabled'] or not item['coverage'] or not (any(item['color'].values()) or any(item['light'].values())):
            continue
        transform = balance(item['color'], matrix)
        changed = ref.apply(transform, rgb) if transform else rgb
        changed = light(changed, item['light'], scene, white)
        changed = saturation(changed, item['color']['saturation'], matrix, white)
        coverage = D(str(item['coverage']))
        rgb = [a * (ONE - coverage) + b * coverage for a, b in zip(rgb, changed)]
    return rgb


def main():
    matrices, vectors = [], []
    colors = ref.matrix([[0, 0, 0], [1, 1, 1], [-1, -1, -1], ['.03', '.14', '.38'],
                         ['-.1', '.2', '.8'], ['-2', 1, 8], ['.2', 8, 16],
                         ['.000001', '.000003', '.00002'], ['.7', '.45', '.3']])
    for primaries, coordinates in ref.PRIMARIES.items():
        matrix = ref.primary_matrix(coordinates)
        for temperature in [-100, -50, 0, 50, 100]:
            for tint in [-100, -50, 0, 50, 100]:
                color = dict(temperature=temperature, tint=tint, saturation=0)
                transform = balance(color, matrix)
                matrices.append(dict(primaries=primaries, color=color,
                    white=list(map(float, target_white(color))) if transform else None,
                    matrix=[float(v) for row in transform for v in row] if transform else None))
        for white in ([ONE, D(2)] if primaries == 'srgb' else [ONE]):
            for case in CASES:
                for rgb in colors:
                    # GPU inputs are frozen binary32 values; oracle calculations remain Decimal80.
                    binary32 = [D.from_float(struct.unpack('<f', struct.pack('<f', float(v)))[0]) for v in rgb]
                    vectors.append(dict(case=case['id'], primaries=primaries, white=float(white),
                        input=list(map(float, binary32)), output=list(map(float,
                        stack(binary32, case, matrix, primaries == 'rec2020', white)))))
    output = dict(version='relative-mask-color-reference-v1', precision=80, license='CC0-1.0',
        source='https://www.w3.org/TR/2026/CRD-css-color-4-20261022/#color-conversion-code',
        semantics='D65 anchored; half-mired Temperature; -normal UCS Tint; balance, Light, Lab saturation, one blend',
        sources={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), helper]},
        cases=CASES, matrices=matrices, vectors=vectors)
    destination = Path(sys.argv[1])
    destination.write_text(json.dumps(output, indent=2) + '\n')
    print(f'Generated {len(matrices)} matrices and {len(vectors)} Decimal80 pipeline vectors: {destination}')


if __name__ == '__main__':
    main()
