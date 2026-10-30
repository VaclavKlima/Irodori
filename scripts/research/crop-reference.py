#!/usr/bin/env python3
"""CC0-1.0: independent Decimal80 crop/rotation oracle, no application imports."""
from decimal import Decimal, ROUND_FLOOR, getcontext
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
import json
import sys

getcontext().prec = 80
PI = Decimal('3.141592653589793238462643383279502884197169399375105820974944592307816406286208998628')


def number(value):
    return Decimal.from_float(float(value))


@lru_cache(maxsize=8)
def sin_cos(degrees):
    angle = number(degrees) * PI / 180
    sine, cosine = angle, Decimal(1)
    st, ct = sine, cosine
    for k in range(1, 100):
        st *= -angle * angle / ((2 * k) * (2 * k + 1))
        ct *= -angle * angle / ((2 * k - 1) * (2 * k))
        sine += st
        cosine += ct
    return sine, cosine


def turned_size(source, turns):
    width, height = source
    for _ in range(turns):
        width, height = height, width
    return Decimal(width), Decimal(height)


def to_source(source, settings, dimensions, point):
    width, height = turned_size(source, settings['quarterTurns'])
    sine, cosine = sin_cos(settings['angle'])
    dx, dy = point[0] - dimensions[0] / 2, point[1] - dimensions[1] / 2
    x = number(settings['centerX']) * width + cosine * dx + sine * dy
    y = number(settings['centerY']) * height - sine * dx + cosine * dy
    # Independently undo one quarter turn at a time, rather than compiling an affine.
    for _ in range(settings['quarterTurns']):
        x, y = y, width - x
        width, height = height, width
    return x, y


def valid(source, settings, dimensions):
    for point in [(0, 0), (dimensions[0], 0), dimensions, (0, dimensions[1])]:
        x, y = to_source(source, settings, dimensions, point)
        if x < 0 or y < 0 or x > source[0] or y > source[1]:
            return False
    return True


def fit(source, settings):
    width, height = turned_size(source, settings['quarterTurns'])
    w, h = number(settings['width']) * width, number(settings['height']) * height
    if settings['aspectRatio'] is not None:
        ratio = number(settings['aspectRatio'])
        if w / h > ratio:
            w = h * ratio
        else:
            h = w / ratio
    # Independent corner testing and binary search, not production's extent formula.
    lower, upper = Decimal(0), Decimal(1)
    if valid(source, settings, (w, h)):
        lower = upper
    else:
        for _ in range(160):
            middle = (lower + upper) / 2
            if valid(source, settings, (w * middle, h * middle)):
                lower = middle
            else:
                upper = middle
    result = dict(settings, width=float(w * lower / width), height=float(h * lower / height))

    def floor_edge(value):
        integral = value.to_integral_value()
        if abs(value - integral) <= Decimal('1e-9'):
            value = integral
        return value.to_integral_value(rounding=ROUND_FLOOR)

    dimensions = (floor_edge(number(result['width']) * width), floor_edge(number(result['height']) * height))
    return result, dimensions


result = {'version': 'crop-decimal80-v1', 'license': 'CC0-1.0', 'precision': 80,
          'generatorSha256': sha256(Path(__file__).read_bytes()).hexdigest(),
          'method': 'Decimal Taylor sine/cosine; binary-search corner containment; repeated quarter rotations',
          'cases': []}
for source in [(9, 5), (4095, 6143), (32768, 1025)]:
    for turns in range(4):
        for angle in [-45, -12.34, 0, 0.01, 22.5, 45]:
            for ratio in [None, 1, 16/9]:
                settings = {'version': 1, 'quarterTurns': turns, 'angle': angle,
                            'centerX': 0.5 if angle >= 0 else 0.35, 'centerY': 0.5 if angle >= 0 else 0.6,
                            'width': 1, 'height': 1, 'aspectRatio': ratio}
                fitted, dimensions = fit(source, settings)
                points = [(Decimal(0), Decimal(0)), (dimensions[0], Decimal(0)), dimensions,
                          (Decimal(0), dimensions[1]), (dimensions[0]/2, dimensions[1]/2),
                          (Decimal('0.5'), Decimal('0.5')),
                          (dimensions[0] * Decimal('0.13'), dimensions[1] * Decimal('0.73'))]
                result['cases'].append({'source': {'width': source[0], 'height': source[1]},
                                        'requested': settings, 'fitted': fitted,
                                        'output': {'width': int(dimensions[0]), 'height': int(dimensions[1])},
                                        'vectors': [{'point': {'x': float(x), 'y': float(y)},
                                                     'source': dict(zip(['x', 'y'], map(float, to_source(source, fitted, dimensions, (x, y)))))}
                                                    for x, y in points]})
Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + '\n')
