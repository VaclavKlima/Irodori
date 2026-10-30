#!/usr/bin/env python3
"""CC0-1.0: independent Decimal80 Hermite-basis reference, not application coefficients."""
from decimal import Decimal, getcontext
from hashlib import sha256
import json
from pathlib import Path
import struct
import sys

getcontext().prec = 80


def d(value):
    # The declared control/input values are IEEE binary64 numbers in the application API.
    return Decimal.from_float(float(value))


def slopes(points):
    width = [b[0] - a[0] for a, b in zip(points, points[1:])]
    secant = [(b[1] - a[1]) / h for a, b, h in zip(points, points[1:], width)]
    if len(points) == 2:
        return [secant[0], secant[0]]

    def edge(h, following_h, delta, following_delta):
        candidate = ((2 * h + following_h) * delta - h * following_delta) / (h + following_h)
        if candidate * delta <= 0:
            return Decimal(0)
        if delta * following_delta < 0 and abs(candidate) > 3 * abs(delta):
            return 3 * delta
        return candidate

    result = [edge(width[0], width[1], secant[0], secant[1])]
    for i in range(1, len(points) - 1):
        previous, following = secant[i - 1], secant[i]
        if previous * following <= 0:
            result.append(Decimal(0))
        else:
            first = 2 * width[i] + width[i - 1]
            second = width[i] + 2 * width[i - 1]
            result.append((first + second) / (first / previous + second / following))
    result.append(edge(width[-1], width[-2], secant[-1], secant[-2]))
    return result


def evaluate(points, derivatives, value):
    if all(x == y for x, y in points):
        return value
    if value < points[0][0] or value > points[-1][0]:
        right = value > points[-1][0]
        at = -1 if right else 0
        distance = abs(value - points[at][0])
        width = points[-1][0] - points[-2][0] if right else points[1][0] - points[0][0]
        extension = distance + (derivatives[at] - 1) * width * distance / (width + distance)
        return points[at][1] + extension if right else points[at][1] - extension
    for i, (left, right) in enumerate(zip(points, points[1:])):
        if value <= right[0]:
            width = right[0] - left[0]
            t = (value - left[0]) / width
            # Four independent Hermite basis functions, no normalized production coefficients.
            h00 = (1 + 2 * t) * (1 - t) ** 2
            h10 = t * (1 - t) ** 2
            h01 = t ** 2 * (3 - 2 * t)
            h11 = t ** 2 * (t - 1)
            return h00 * left[1] + h10 * width * derivatives[i] + h01 * right[1] + h11 * width * derivatives[i + 1]
    raise ValueError("Reference interval not found")


def f32(value):
    return struct.unpack("f", struct.pack("f", value))[0]


def lab_f(value):
    return value ** (Decimal(1) / 3) if value > Decimal(216) / 24389 else (Decimal(24389) / 27 * value + 16) / 116


def lab_inverse(value):
    return value ** 3 if value > Decimal(6) / 29 else (116 * value - 16) * (Decimal(27) / 24389)


# Primary-derived rational D65 matrices, independently evaluated in Decimal80.
forward = {
    "srgb": [[(506752, 1228815), (87881, 245763), (12673, 70218)],
             [(87098, 409605), (175762, 245763), (12673, 175545)],
             [(7918, 409605), (87881, 737289), (1001167, 1053270)]],
    "rec2020": [[(63426534, 99577255), (20160776, 139408157), (47086771, 278816314)],
                [(26158966, 99577255), (472592308, 697040785), (8267143, 139408157)],
                [(0, 1), (19567812, 697040785), (295819943, 278816314)]],
}
inverse = {
    "srgb": [[(12831, 3959), (-329, 214), (-1974, 3959)],
             [(-851781, 878810), (1648619, 878810), (36519, 878810)],
             [(705, 12673), (-2585, 12673), (705, 667)]],
    "rec2020": [[(30757411, 17917100), (-6372589, 17917100), (-4539589, 17917100)],
                [(-19765991, 29648200), (47925759, 29648200), (467509, 29648200)],
                [(792561, 44930125), (-1921689, 44930125), (42328811, 44930125)]],
}
white = [Decimal(3127) / 3290, Decimal(1), Decimal(3583) / 3290]


def transform(matrix, values):
    return [sum(Decimal(n) / denominator * v for (n, denominator), v in zip(row, values)) for row in matrix]


def apply(curves, rgb, primaries):
    xyz = transform(forward[primaries], rgb)
    master, *channels = curves
    if any(x != y for x, y in master):
        y = evaluate(master, slopes(master), xyz[1])
        shift = lab_f(y) - lab_f(xyz[1])
        xyz = [white[0] * lab_inverse(lab_f(xyz[0] / white[0]) + shift), y,
               white[2] * lab_inverse(lab_f(xyz[2] / white[2]) + shift)]
        rgb = transform(inverse[primaries], xyz)
    return [evaluate(points, slopes(points), value) for points, value in zip(channels, rgb)]


cases = {
    "identity": [(0, 0), (1, 1)],
    "identity-rich": [(-16, -16), (0, 0), (0.18, 0.18), (1, 1), (16, 16), (64, 64)],
    "gentle": [(0, 0), (0.18, 0.25), (0.5, 0.65), (1, 1), (16, 16)],
    "matte": [(0, 0.03), (0.05, 0.07), (0.18, 0.2), (1, 0.92), (16, 15)],
    "flat-end": [(0, 0), (0.18, 0.4), (1, 1), (2, 1)],
    "reverse": [(-1, 2), (0, 1), (0.18, 0.3), (1, 0), (16, -2)],
    "solar": [(-16, -4), (-1, 0.1), (0, 0), (0.05, 0.2), (0.18, 0.1), (0.5, 0.9), (1, 0.6), (4, 2), (16, 8)],
    "sixteen-points": list(zip(
        [-16, -4, -1, -0.1, 0, 0.001, 0.01, 0.04, 0.18, 0.5, 1, 2, 4, 8, 16, 64],
        [-14, -4, -1, -0.08, 0.01, 0.011, 0.02, 0.07, 0.25, 0.7, 1.25, 2.1, 4.5, 8, 17, 64])),
    "steep": [(0, 0), (0.18, -0.2), (0.1801, 1), (0.5, 1), (1, 1.2)],
    "near-upper-bound": [(-16, -16), (0, 0), (63.9998, 1), (63.9999, -16), (64, 64)],
}
inputs = [-1000, -16, -4, -1, -0.1, -1e-12, 0, 1e-12, 0.001, 0.005, 0.01, 0.04, 0.05, 0.18,
          0.180025, 0.18005, 0.180075, 0.1801, 0.5, 1, 2, 4, 8, 16, 64, 1000, 1e12]
result = {"version": "tone-curve-decimal80-v1", "license": "CC0-1.0", "precision": 80,
          "coordinates": "exact IEEE-754 binary64 inputs and points", "generatorSha256": sha256(Path(__file__).read_bytes()).hexdigest(),
          "source": "https://doi.org/10.1137/0905021", "curves": []}
for name, raw in cases.items():
    points = [(d(x), d(y)) for x, y in raw]
    derivatives = slopes(points)
    values = sorted(set(inputs + [float(p[0]) for p in points] + [float(p[0]) + offset for p in points for offset in [-1e-8, 1e-8]]))
    # Include every original input rounded to the exact image storage domain, plus
    # dense samples in every interval (including the 0.0001-wide steep intervals).
    gpu_inputs = sorted(set([f32(v) for v in values] +
                            [f32(float(left[0] + (right[0] - left[0]) * Decimal(i) / 32))
                             for left, right in zip(points, points[1:]) for i in range(33)]))
    result["curves"].append({"name": name, "points": [{"input": float(x), "output": float(y)} for x, y in points],
                             "slopes": [float(v) for v in derivatives],
                             "vectors": [{"input": v, "output": float(evaluate(points, derivatives, d(v)))} for v in values],
                             "gpuVectors": [{"input": v, "output": float(evaluate(points, derivatives, d(v)))} for v in gpu_inputs]})
result["settings"] = []
result["colorVectors"] = []
names = list(cases)
for index, name in enumerate(names):
    for configuration in [[name, "identity", "identity", "identity"],
                          ["identity", name, names[(index + 3) % len(names)], names[(index + 7) % len(names)]]]:
        setting = len(result["settings"])
        result["settings"].append(configuration)
        curves = [[(d(x), d(y)) for x, y in cases[key]] for key in configuration]
        pixels = [[0, 0, 0], [1e-12, -1e-12, 2e-12], [-0.2, 0.1, 0.5], [0.2, 0.4, 0.1],
                  [0.9, 0.1, 0.01], [16, 2, 0.05], [0.01, 16, 2], [2, 0.05, 16],
                  [-1, -0.5, -0.1], [-16, 16, 0], [1000, 100, 0.001]]
        pixels += [[v, v, v] for v in [-1000, -16, -1, -0.001, 0.001, 0.005, 0.01, 0.18,
                                      0.180025, 0.18005, 0.180075, 0.1801, 1, 2, 4, 16,
                                      63.9998, 63.999825, 63.99985, 63.999875, 63.9999,
                                      63.999925, 63.99995, 63.999975, 64, 1000]]
        for primaries in forward:
            for pixel in pixels:
                rgb = [f32(v) for v in pixel]
                result["colorVectors"].append({"settings": setting, "primaries": primaries, "input": rgb,
                                                "output": [float(v) for v in apply(curves, list(map(d, rgb)), primaries)]})
Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + "\n")
