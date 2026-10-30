#!/usr/bin/env python3
"""CC0-1.0 independent Decimal80 mixer/three-way oracle; no application imports.

Derive primary matrices by elimination, find hue intervals by angular order and
solve chord coefficients explicitly. Reconstruct complete XYZ/RGB rather than
production's stable delta path. Published CIE epsilon/kappa use Irodori's declared D65.
"""
from decimal import Decimal, getcontext
from functools import lru_cache
from hashlib import sha256
import importlib.util
import json
import struct
from pathlib import Path
import sys

getcontext().prec = 80
D = Decimal
ONE, ZERO = D(1), D(0)
PI = D('3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628')
helper = Path(__file__).with_name('color-reference.py')
spec = importlib.util.spec_from_file_location('primary_reference', helper)
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
WHITE = [D(3127) / 3290, ONE, D(3583) / 3290]
EPSILON, KAPPA = D(216) / 24389, D(24389) / 27
IDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']
HUES = list(map(D, [0, 30, 60, 120, 180, 240, 270, 300]))
MATRICES = {name: reference.primary_matrix(points) for name, points in reference.PRIMARIES.items()}
INVERSES = {name: reference.inverse(matrix) for name, matrix in MATRICES.items()}


def f(value):
    return reference.cbrt(value) if value > EPSILON else (KAPPA * value + 16) / 116


def inv(value):
    return value ** 3 if value > D(6) / 29 else (116 * value - 16) / KAPPA


def lab(xyz):
    x, y, z = [f(v / w) for v, w in zip(xyz, WHITE)]
    return 116 * y - 16, 500 * (x - y), 200 * (y - z)


def restore(xyz, a, b, y, primaries):
    if a == b == 0:
        return [y] * 3
    fy = f(y)
    return reference.apply(INVERSES[primaries], [WHITE[0] * inv(fy + a / 500), y, WHITE[2] * inv(fy - b / 200)])


def smooth(t):
    t = min(ONE, max(ZERO, t))
    return t * t * (3 - 2 * t)


@lru_cache(maxsize=100)
def sincos(degrees):
    x = degrees * PI / 180
    x = (x + PI) % (2 * PI) - PI
    st, ct = x, ONE
    s, c = st, ct
    for n in range(1, 180):
        st *= -x * x / ((2 * n) * (2 * n + 1))
        ct *= -x * x / ((2 * n - 1) * (2 * n))
        s += st
        c += ct
        if abs(st) < D('1e-78') and abs(ct) < D('1e-78'):
            break
    return s, c


def atan(value):
    if value < 0:
        return -atan(-value)
    if value > 1:
        return PI / 2 - atan(ONE / value)
    factor = ONE
    while value > D('.1'):
        value /= ONE + (ONE + value * value).sqrt()
        factor *= 2
    term, total = value, value
    for n in range(1, 180):
        term *= -value * value
        change = term / (2 * n + 1)
        total += change
        if abs(change) < D('1e-78'):
            break
    return total * factor


def angle(a, b):
    if a == 0:
        result = PI / 2 if b >= 0 else -PI / 2
    else:
        result = atan(b / a)
        if a < 0:
            result += PI if b >= 0 else -PI
    return result if result >= 0 else result + 2 * PI


def decode(v):
    return v / D('12.92') if v <= D('.04045') else (((v + D('.055')) / D('1.055')).ln() * D('2.4')).exp()


ENCODED = reference.matrix([[1, 0, 0], [1, '.5', 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], ['.5', 0, 1], [1, 0, 1]])
DIRECTIONS, ANGLES = [], []
for color in ENCODED:
    _, a, b = lab(reference.apply(MATRICES['srgb'], [decode(v) for v in color]))
    length = (a * a + b * b).sqrt()
    DIRECTIONS.append([a / length, b / length])
    ANGLES.append(angle(a, b))
assert all(a < b for a, b in zip(ANGLES, ANGLES[1:]))


def selection(rgb, primaries):
    if rgb[0] == rgb[1] == rgb[2]:
        return 0, 1, ZERO, ZERO
    peak = max(map(abs, rgb))
    if not peak:
        return 0, 1, ZERO, ZERO
    lightness, a, b = lab(reference.apply(MATRICES[primaries], [v / peak for v in rgb]))
    c2 = a * a + b * b
    denominator = lightness * lightness + 4 * c2
    protection = smooth(((c2 / denominator if denominator else ZERO) - D('.0004')) / D('.006'))
    if not protection:
        return 0, 1, ZERO, ZERO
    h = angle(a, b)
    for i in range(8):
        j = (i + 1) % 8
        lower, upper = ANGLES[i], ANGLES[j] + (2 * PI if j == 0 else ZERO)
        candidate = h + (2 * PI if h < lower and j == 0 else ZERO)
        if lower <= candidate <= upper:
            x1, y1 = DIRECTIONS[i]
            x2, y2 = DIRECTIONS[j]
            determinant = x1 * y2 - x2 * y1
            # Independent two-by-two solution of the ray/chord coefficient problem.
            first = (a * y2 - x2 * b) / determinant
            second = (x1 * b - a * y1) / determinant
            return i, j, smooth(second / (first + second)), protection
    raise AssertionError('Missing independent hue interval')


def ratio(y, next_y, gain):
    if y <= EPSILON and next_y <= EPSILON:
        return gain
    return (116 * f(next_y) - 16) / (116 * f(y) - 16)


def mixer(rgb, settings, primaries):
    if not any(v for amounts in settings['ranges'].values() for v in amounts.values()):
        return rgb
    i, j, t, p = selection(rgb, primaries)
    if not p:
        return rgb
    values = [settings['ranges'][IDS[n]] for n in [i, j]]
    weights = [ONE - t, t]
    sine, cosine = ZERO, ONE
    saturation, ev = ZERO, ZERO
    for value, w in zip(values, weights):
        s, c = sincos(D(value['hue']) * D('.3'))
        sine += p * w * s
        cosine += p * w * (c - 1)
        saturation += p * w * D(value['saturation']) / 100
        ev += p * w * D(value['luminance']) / 100
    length = (sine * sine + cosine * cosine).sqrt()
    sine, cosine = sine / length, cosine / length
    xyz = reference.apply(MATRICES[primaries], rgb)
    _, a, b = lab(xyz)
    gain = (D(2).ln() * ev).exp()
    y = xyz[1] * gain
    scale = (ONE + saturation) * ratio(xyz[1], y, gain)
    return restore(xyz, (a * cosine - b * sine) * scale, (a * sine + b * cosine) * scale, y, primaries)


def intensity(rgb, settings, primaries):
    sat, vib = settings['saturation'], settings['vibrance']
    if sat == vib == 0 or rgb[0] == rgb[1] == rgb[2]:
        return rgb
    xyz = reference.apply(MATRICES[primaries], rgb)
    if sat == -100:
        return [xyz[1]] * 3
    l, a, b = lab(xyz)
    denominator = l * l + 4 * (a * a + b * b)
    gain = (ONE + D(sat) / 100) * (D(2).ln() * D(vib) / 100 * (l * l / denominator if denominator else ZERO)).exp()
    return restore(xyz, a * gain, b * gain, xyz[1], primaries)


def grade_weights(y, settings):
    if y <= 0:
        return [ONE, ZERO, ZERO]
    z = (y / D('.18')).ln() / D(2).ln() + D(settings['balance']) / 50
    width = D('.5') + D('3.5') * D(settings['blending']) / 100
    left, right = smooth((z + 2 + width) / (2 * width)), smooth((z - 2 + width) / (2 * width))
    return [ONE - left, left - right, right]


def hue_direction(hue):
    hue = D(str(hue)) % 360
    for i in range(8):
        j = (i + 1) % 8
        upper = HUES[j] if j else D(360)
        if HUES[i] <= hue <= upper:
            t = (hue - HUES[i]) / (upper - HUES[i])
            vector = [a * (ONE - t) + b * t for a, b in zip(DIRECTIONS[i], DIRECTIONS[j])]
            length = sum(v * v for v in vector).sqrt()
            return [v / length for v in vector]
    raise AssertionError('Invalid grade hue')


def grade(rgb, settings, primaries):
    if not any(v['saturation'] or v['luminance'] for v in settings['tones'].values()):
        return rgb
    xyz = reference.apply(MATRICES[primaries], rgb)
    _, a, b = lab(xyz)
    weights = grade_weights(xyz[1], settings)
    color = [ZERO, ZERO]
    ev = ZERO
    for name, w in zip(['shadows', 'midtones', 'highlights'], weights):
        tone = settings['tones'][name]
        direction = hue_direction(tone['hue'])
        color = [v + w * d * D(tone['saturation']) / 200 for v, d in zip(color, direction)]
        ev += w * D(tone['luminance']) / 100
    gain = (D(2).ln() * ev).exp()
    y = xyz[1] * gain
    scale = ratio(xyz[1], y, gain)
    strength = max(ZERO, 116 * f(y) - 16)
    return restore(xyz, a * scale + strength * color[0], b * scale + strength * color[1], y, primaries)


def make_mixer():
    return {'version': 1, 'ranges': {name: dict(hue=0, saturation=0, luminance=0) for name in IDS}}


def make_grade(blending=50, balance=0):
    return {'version': 1, 'tones': {name: dict(hue=0, saturation=0, luminance=0) for name in ['shadows', 'midtones', 'highlights']}, 'blending': blending, 'balance': balance}


def main(destination):
    # Merge literal defaults explicitly: no duplicate keyword arguments in operator cases.
    def mix(patches):
        value = make_mixer()
        for key, patch in patches.items():
            value['ranges'][key].update(patch)
        return value
    def grading(patches, blending=50, balance=0):
        value = make_grade(blending=blending, balance=balance)
        for key, patch in patches.items():
            value['tones'][key].update(patch)
        return value
    neutral_mix, neutral_grade = make_mixer(), make_grade()
    alternating = mix({name: {'hue': 100 if i % 2 else -100, 'saturation': 100 if i % 3 else -100, 'luminance': 100 if i % 2 else -100} for i, name in enumerate(IDS)})
    chroma_grade = grading({'shadows': {'hue': 240, 'saturation': 45}, 'midtones': {'hue': 30, 'saturation': 12}, 'highlights': {'hue': 45, 'saturation': 35}})
    low = grading({'shadows': {'hue': 0, 'saturation': 100, 'luminance': -100}, 'midtones': {'hue': 120, 'saturation': 100, 'luminance': 100}, 'highlights': {'hue': 240, 'saturation': 100, 'luminance': -100}}, 0, -100)
    high = grading({'shadows': {'hue': 359.9, 'saturation': 100, 'luminance': 100}, 'midtones': {'hue': 180.5, 'saturation': 100, 'luminance': -100}, 'highlights': {'hue': 60, 'saturation': 100, 'luminance': 100}}, 100, 100)
    configs = [
        (neutral_mix, neutral_grade, 0, 0), (mix({'red': {'hue': 100, 'saturation': 100, 'luminance': 60}}), neutral_grade, 0, 0),
        (mix({'blue': {'hue': -100, 'saturation': -100, 'luminance': -100}}), neutral_grade, 0, 0),
        (alternating, neutral_grade, 0, 0), (mix({name: {'saturation': -100} for name in IDS}), neutral_grade, 0, 0),
        (neutral_mix, chroma_grade, 0, 0), (neutral_mix, low, 0, 0), (neutral_mix, high, 0, 0),
        (neutral_mix, chroma_grade, -100, 100), (alternating, chroma_grade, 100, 100),
    ]
    configurations = [{'mixer': m, 'grading': g, 'intensity': {'saturation': s, 'vibrance': v}} for m, g, s, v in configs]
    vectors, gpu_vectors = [], []
    for primaries in MATRICES:
        colors = reference.matrix([[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], ['.2', '.5', 1], [1, '.2', '.01'], ['-.1', '.2', '.8'], [0, '-.1', 1], [-1, -1, -1], [1, '-.2', '.01'], ['.18', '.180001', '.18'], ['.7', '.45', '.3']])
        colors += [reference.apply(INVERSES[primaries], reference.apply(MATRICES['srgb'], [decode(v) for v in color])) for color in ENCODED]
        for scale in map(D, ['1e-12', '.0001', '.18', '1', '4', '16']):
            for base in colors:
                rgb = [D.from_float(float(v * scale)) for v in base]
                gpu_rgb = [D.from_float(struct.unpack('<f', struct.pack('<f', float(v)))[0]) for v in rgb]
                for inputs, destination_vectors in [(rgb, vectors), (gpu_rgb, gpu_vectors)]:
                    selected = selection(inputs, primaries)
                    for index, config in enumerate(configurations):
                        mixed = mixer(inputs, config['mixer'], primaries)
                        colored = intensity(mixed, config['intensity'], primaries)
                        output = grade(colored, config['grading'], primaries)
                        grade_y = reference.apply(MATRICES[primaries], colored)[1]
                        weights = grade_weights(grade_y, config['grading'])
                        destination_vectors.append({'primaries': primaries, 'input': list(map(float, inputs)), 'configuration': index,
                            'selection': {'first': selected[0], 'second': selected[1], 'blend': float(selected[2]), 'protection': float(selected[3])},
                            'mixed': list(map(float, mixed)), 'colored': list(map(float, colored)), 'output': list(map(float, output)), 'gradeY': float(grade_y), 'gradeWeights': list(map(float, weights))})
    result = {'version': 'creative-color-decimal80-v1', 'precision': 80, 'license': 'CC0-1.0',
        'sources': {p.name: sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), helper]},
        'method': 'Independent primary elimination, Decimal80 CIE, angular interval search and chord solve; full inverse XYZ/RGB',
        'ranges': [{'id': name, 'nominalHue': float(hue), 'labHue': float(angle * 180 / PI), 'direction': list(map(float, direction))} for name, hue, angle, direction in zip(IDS, HUES, ANGLES, DIRECTIONS)],
        'configurations': configurations, 'vectors': vectors, 'gpuVectors': gpu_vectors}
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Generated {len(vectors)} scalar and {len(gpu_vectors)} Float32-input independent Decimal80 creative-color vectors: {destination}')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
