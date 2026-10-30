#!/usr/bin/env python3
"""CC0-1.0 Decimal80 direct 2D Lanczos3 reference, independent of application code."""
from decimal import Decimal, getcontext, ROUND_CEILING, ROUND_FLOOR
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
import json
import struct

getcontext().prec = 80
D = Decimal
PI = D('3.141592653589793238462643383279502884197169399375105820974944592307816406286209')


def f32(value):
    return struct.unpack('<f', struct.pack('<f', float(value)))[0]


@lru_cache(None)
def sinc(value):
    if value == 0:
        return D(1)
    if value == value.to_integral_value():
        return D(0)
    angle = value * PI
    reduced = angle % (2 * PI)
    if reduced > PI:
        reduced -= 2 * PI
    if reduced < -PI:
        reduced += 2 * PI
    term, result = reduced, reduced
    for n in range(1, 140):
        term *= -reduced * reduced / D((2*n) * (2*n+1))
        result += term
        if abs(term) < D('1e-85'):
            break
    return result / angle


def support(length, target, index):
    center = (D(index) + D('0.5')) * length / target - D('0.5')
    scale = max(D(1), D(length) / target)
    start = int((center - 3 * scale).to_integral_value(rounding=ROUND_CEILING))
    stop = int((center + 3 * scale).to_integral_value(rounding=ROUND_FLOOR))
    return [(max(0, min(length-1, p)), sinc((D(p)-center)/scale) *
             sinc((D(p)-center)/(3*scale)))
            for p in range(start, stop+1) if abs(D(p)-center) < 3*scale]


def case(name, width, height, out_width, out_height, channels, constant=False):
    data = [f32(D('0.18') if constant else D(((x*11+y*7+c*13) % 23)-5) / 7)
            for y in range(height) for x in range(width) for c in range(channels)]
    out = []
    for y in range(out_height):
        yy = support(height, out_height, y)
        for x in range(out_width):
            xx = support(width, out_width, x)
            # Direct two-dimensional normalized convolution, without a separable
            # Float32 intermediate or production row/tap/cache helpers.
            total = sum(wx*wy for _, wx in xx for _, wy in yy)
            for c in range(channels):
                out.append(float(sum(D(data[(sy*width+sx)*channels+c])*wx*wy
                                     for sx, wx in xx for sy, wy in yy) / total))
    return {'name': name, 'width': width, 'height': height, 'outWidth': out_width,
            'outHeight': out_height, 'channels': channels, 'input': data, 'expected': out}


output = {
    'license': 'CC0-1.0',
    'reference': 'Decimal80 direct 2D normalized Lanczos3 with replicated edges',
    'generatorSha256': sha256(Path(__file__).read_bytes()).hexdigest(),
    'tolerance': {'absolute': 2e-6, 'relative': 2e-5},
    'cases': [case('fractional-signed-hdr-pair', 5, 4, 9, 7, 6),
              case('one-pixel-width', 1, 3, 4, 7, 3),
              case('one-pixel-height', 4, 1, 9, 3, 3),
              case('legacy-reduction', 7, 5, 3, 2, 3),
              case('identity', 4, 3, 4, 3, 3),
              case('one-axis-identity', 5, 4, 5, 9, 6),
              case('constant', 2, 2, 7, 5, 6, True)]}
destination = Path(__file__).resolve().parents[2] / 'tests/fixtures/export-resize-reference.json'
destination.write_text(json.dumps(output, indent=2) + '\n')
print(destination)
