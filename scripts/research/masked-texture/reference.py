#!/usr/bin/env python3
"""Small synthetic float64 oracle; no image I/O or production CPU executor.

Independently authored from the frozen masked-texture LLF residual contract.
Halide's sampled-pyramid construction and the Paris/Aubry papers motivate it;
finite-level clamping, alpha weighting, signed asinh and selected bands are
explicit Irodori adaptations. Only the procedural cases below are evaluated.
"""

import json
import math
from pathlib import Path
import struct


POLICY = "masked-texture-llf-residual-v1"
LUMINANCE = {
    "srgb": (87098 / 409605, 175762 / 245763, 12673 / 175545),
    "rec2020": (26158966 / 99577255, 472592308 / 697040785, 8267143 / 139408157),
}


def f32(value):
    return struct.unpack("<f", struct.pack("<f", value))[0]


def grid(width, height, values):
    assert width * height == len(values)
    return width, height, values


def read(image, x, y):
    width, height, values = image
    return values[min(max(y, 0), height - 1) * width + min(max(x, 0), width - 1)]


def norm(pair):
    return pair[0] / pair[1] if pair[1] > 0 else 0.0


def reduce_axis(image, axis):
    width, height, _ = image
    out_width = (width + 1) // 2 if axis == 0 else width
    out_height = (height + 1) // 2 if axis == 1 else height
    values = []
    for y in range(out_height):
        for x in range(out_width):
            samples = [
                read(image, 2 * x + offset if axis == 0 else x,
                     2 * y + offset if axis == 1 else y)
                for offset in (-1, 0, 1, 2)
            ]
            # The centered form preserves a constant plane exactly.
            values.append(tuple(samples[1][c] + (
                (samples[0][c] - samples[1][c])
                + 3 * (samples[2][c] - samples[1][c])
                + (samples[3][c] - samples[1][c])
            ) / 8 for c in (0, 1)))
    return grid(out_width, out_height, values)


def down(image):
    return reduce_axis(reduce_axis(image, 1), 0)


def up(image, width, height):
    # Halide phase with mathematical floor, including x/y == 0.
    def horizontal(x, y):
        a = read(image, (x + 1) // 2, y)
        b = read(image, (x - 1) // 2, y)
        t = ((x % 2) * 2 + 1) / 4
        return tuple(a[c] + (b[c] - a[c]) * t for c in (0, 1))

    values = []
    for y in range(height):
        t = ((y % 2) * 2 + 1) / 4
        for x in range(width):
            a, b = horizontal(x, (y + 1) // 2), horizontal(x, (y - 1) // 2)
            values.append(tuple(a[c] + (b[c] - a[c]) * t for c in (0, 1)))
    return grid(width, height, values)


def pyramid(base):
    levels = [base]
    for _ in range(3):
        levels.append(down(levels[-1]))
    return levels


def residual(rgba, width, height, primaries):
    """Evaluate only the two selected LLF bands on a bounded procedural array."""
    if not 0 < width <= 33 or not 0 < height <= 25:
        raise ValueError("This numeric oracle refuses full-frame inputs")
    features, luminance = [], []
    coefficients = LUMINANCE[primaries]
    for offset in range(0, len(rgba), 4):
        red, green, blue, alpha = rgba[offset:offset + 4]
        if not all(math.isfinite(v) for v in (red, green, blue, alpha)) or not 0 <= alpha <= 1:
            raise ValueError("Expected finite RGBA with alpha in [0,1]")
        value = sum(channel * weight for channel, weight in zip((red, green, blue), coefficients)) if alpha else 0.0
        feature = math.asinh(value / 0.18)
        if abs(feature) > 6:
            raise ValueError("Luminance exceeds the frozen signed-asinh domain")
        features.append((feature * alpha, alpha))
        luminance.append(value)
    source = pyramid(grid(width, height, features))
    accumulated = {j: [0.0] * len(source[j][2]) for j in (1, 2)}
    for k in range(97):
        anchor = -6 + k * 0.125
        remapped = []
        for weighted, alpha in features:
            distance = norm((weighted, alpha)) - anchor
            value = distance * math.exp(-0.5 * (distance / 0.2) ** 2)
            remapped.append((alpha * value, alpha))
        filtered = pyramid(grid(width, height, remapped))
        for j in (1, 2):
            expanded = up(filtered[j + 1], source[j][0], source[j][1])
            for index, sample in enumerate(source[j][2]):
                interpolation = max(0.0, 1 - abs((norm(sample) + 6) / 0.125 - k))
                accumulated[j][index] += interpolation * (
                    norm(filtered[j][2][index]) - norm(expanded[2][index])
                )
    selected = {
        j: grid(source[j][0], source[j][1], [
            (value * sample[1], sample[1])
            for value, sample in zip(accumulated[j], source[j][2])
        ]) for j in (1, 2)
    }
    coarse = up(selected[2], source[1][0], source[1][1])
    reconstructed = grid(source[1][0], source[1][1], [
        ((norm(fine) + norm(broad)) * original[1], original[1])
        for fine, broad, original in zip(selected[1][2], coarse[2], source[1][2])
    ])
    full = up(reconstructed, width, height)
    return [norm(value) for value in full[2]], luminance


def apply(rgba, mask, width, height, primaries, amount):
    if not -100 <= amount <= 100 or len(mask) != width * height:
        raise ValueError("Invalid amount or coverage dimensions")
    if any(not math.isfinite(v) or not 0 <= v <= 1 for v in mask):
        raise ValueError("Expected coverage in [0,1]")
    delta, luminance = residual(rgba, width, height, primaries)
    output = list(rgba)
    for index, (coverage, y, value) in enumerate(zip(mask, luminance, delta)):
        offset = 4 * index
        if amount == 0 or coverage == 0 or rgba[offset + 3] == 0:
            continue
        d = amount / 100 * value
        change = 2 * y * math.sinh(d / 2) ** 2 + math.hypot(y, 0.18) * math.sinh(d)
        for channel in range(3):
            output[offset + channel] += coverage * change
    return output, delta


def make_case(name, width, height, pixel, amounts=(25,), primaries="srgb", mask=None):
    rgba = [f32(v) for y in range(height) for x in range(width) for v in pixel(x, y)]
    coverage = [f32(mask(x, y) if mask else 1) for y in range(height) for x in range(width)]
    current, final64, delta = rgba, rgba, []
    for amount in amounts:
        final64, delta = apply(current, coverage, width, height, primaries, amount)
        current = [f32(v) for v in final64]
    exact = [i for i in range(len(rgba)) if i % 4 == 3 or amounts == (0,)
             or coverage[i // 4] == 0 or rgba[(i // 4) * 4 + 3] == 0]
    if name == "constant-exact":
        exact = list(range(len(rgba)))
    if any(current[index] != rgba[index] for index in exact):
        raise AssertionError("An exact bypass/alpha/hidden-source invariant changed")
    return {
        "id": name, "width": width, "height": height, "primaries": primaries,
        "rgba": rgba, "mask": coverage, "passes": list(amounts),
        "expected": current,
        "float64Probes": [
            {"pixel": i, "rgba": final64[4 * i:4 * i + 4]}
            for i in sorted({0, width - 1, width * (height // 2) + width // 2,
                             width * (height - 1), width * height - 1})
        ],
        "descriptive": {
            "fullDeltaRms": math.sqrt(sum(v * v for v in delta) / len(delta)),
            "fullDeltaMaxAbs": max(map(abs, delta)),
            "exactSourceWordIndices": exact,
        },
    }


def gray(value):
    return value, value, value, 1


def response_stats(case):
    coefficients = LUMINANCE[case["primaries"]]

    def samples(values, feature):
        result = []
        for offset in range(0, len(values), 4):
            y = sum(values[offset + c] * coefficients[c] for c in range(3))
            result.append(math.asinh(y / 0.18) if feature else y)
        return result

    def rms(values):
        mean = sum(values) / len(values)
        return math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))

    for feature, key in ((False, "luminanceRmsGain"), (True, "featureRmsGain")):
        original, output = samples(case["rgba"], feature), samples(case["expected"], feature)
        case["descriptive"][key] = rms(output) / rms(original)


def fixtures():
    detail = lambda x, y: gray(0.4 + 0.04 * math.cos(x * math.pi / 2) + 0.02 * math.sin(y * math.pi / 3))
    feather = lambda x, y: (0, 0.25, 0.5, 1)[(x + 2 * y) % 4]
    cases = [
        make_case("identity-zero", 7, 5, detail, (0,), mask=feather),
        make_case("constant-exact", 7, 5, lambda x, y: gray(0.375), (100,), mask=feather),
        make_case("mask-zero", 7, 5, detail, mask=lambda x, y: 0),
        make_case("odd-smooth-positive", 13, 7, lambda x, y: gray(0.2 + x / 80 + y / 160)),
        make_case("even-chromatic-negative", 8, 6, lambda x, y: (
            0.2 + x / 70, 0.5 + 0.06 * math.cos(x * math.pi / 2),
            0.1 + y / 60, 1), (-25,), "rec2020"),
        make_case("strong-step-boundary", 17, 5, lambda x, y: gray(
            (0.05 if x < 8 else 2) + 0.01 * math.cos(y * math.pi / 2))),
        make_case("signed-hdr-partial", 9, 5, lambda x, y: gray(
            (-2, -0.01, 0, 0.18, 1, 4, 16, 0.5, -0.5)[x]), (-25,), "rec2020", feather),
        make_case("alpha-hidden-partial", 9, 5, lambda x, y: (
            (9999, -8888, 7777, 0) if (x + y) % 4 == 0 else
            (*detail(x, y)[:3], (0.125, 0.5, 1)[(x + y) % 3])), mask=feather),
        make_case("full-negative", 5, 5, detail, (-100,)),
        make_case("full-positive", 5, 5, detail, (100,)),
        make_case("overlap-positive-negative", 9, 5, detail, (25, -25), mask=feather),
        make_case("overlap-negative-positive", 9, 5, detail, (-25, 25), mask=feather),
        make_case("flat-noise-positive", 9, 5, lambda x, y: gray(
            0.5 + (((x * 17 + y * 29 + x * y * 7) % 31) - 15) / 15000)),
    ]
    for label, period in (("low", 32), ("mid", 8), ("texture", 4), ("high", 2)):
        case = make_case("band-" + label, 17, 5,
                         lambda x, y, p=period: gray(0.5 + 0.04 * math.cos(2 * math.pi * x / p)))
        case["descriptive"]["sourcePeriodPixels"] = period
        case["descriptive"]["rgbChangeRms"] = math.sqrt(sum(
            (case["expected"][i] - case["rgba"][i]) ** 2
            for i in range(0, len(case["rgba"]), 4)) / (17 * 5))
        cases.append(case)
        if label in ("mid", "texture"):
            negative = make_case("band-" + label + "-negative", 17, 5,
                                 lambda x, y, p=period: gray(0.5 + 0.04 * math.cos(2 * math.pi * x / p)),
                                 (-25,))
            negative["descriptive"]["sourcePeriodPixels"] = period
            cases.append(negative)
    for case in cases:
        if case["id"].startswith("band-") or case["id"] == "flat-noise-positive":
            response_stats(case)
    return cases


if __name__ == "__main__":
    result = {
        "version": 1, "policy": POLICY,
        "provenance": {
            "generator": "scripts/research/masked-texture/reference.py",
            "arithmetic": "Python scalar float64; inputs/masks and each pass output rounded to IEEE float32",
            "scope": "Bounded procedural arrays only; no photograph/full-frame CPU processing",
            "sources": [
                "https://github.com/halide/Halide/blob/main/apps/local_laplacian/local_laplacian_generator.cpp",
                "https://people.csail.mit.edu/sparis/publi/2011/siggraph/",
                "https://imagine.enpc.fr/~aubrym/projects/llf/index.html",
            ],
            "adaptations": "J4 finite-level clamp, alpha-weighted signed asinh luminance, 97 anchors, bands 1/2 only, mask after nonlinear reconstruction",
            "luminanceCoefficients": LUMINANCE,
        },
        "tolerance": {"absolute": 2e-6, "relative": 2e-5,
                      "exact": "amount0/mask0/alpha0 source words and every alpha word"},
        "cases": fixtures(),
    }
    target = Path(__file__).resolve().parents[3] / "assets/tests/references/masked-texture/reference.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n"
    if len(encoded.encode()) >= 200_000:
        raise ValueError(f"Synthetic reference exceeds the 200KB publication cap: {len(encoded.encode())}")
    target.write_text(encoded)
    print(f"Wrote {len(result['cases'])} procedural cases, {len(encoded.encode())} bytes: {target}")
