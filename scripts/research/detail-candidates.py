#!/usr/bin/env python3
"""CC0-1.0 independent small-chart comparison; no application imports or photo decoding.

Original Irodori implementations of bounded bilateral/NLM and protected unsharp
equations. Prefix rectangles evaluate patch distances independently from the
production per-patch kernel. Fixtures use explicitly rounded Float32 source words.
"""
import argparse
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path
import struct
import time

K = 0.18
RADIUS, PATCH, SPATIAL_SIGMA = 3, 1, 2
helper = Path(__file__).with_name('color-reference.py')
spec = importlib.util.spec_from_file_location('detail_primary_reference', helper)
primary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(primary)
LUMINANCE = {name: [float(x) for x in primary.primary_matrix(points)[1]]
        for name, points in primary.PRIMARIES.items()}


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def encode(rgb, coefficients):
    y = math.fsum(a * b for a, b in zip(rgb[:3], coefficients))
    scale = math.hypot(y, K)
    return math.asinh(y / K), math.asinh((rgb[0] - y) / scale), math.asinh((rgb[2] - y) / scale)


def decode(value, coefficients):
    l, a, b = value
    y = K * math.sinh(l)
    scale = math.hypot(y, K)
    u, v = scale * math.sinh(a), scale * math.sinh(b)
    return [y + u, y - (coefficients[0] * u + coefficients[2] * v) / coefficients[1], y + v, 1]


def change(entering, scale, delta):
    if delta == 0:
        return 0.0
    return 2 * entering * math.sinh(delta / 2) ** 2 + math.hypot(entering, scale) * math.sinh(delta)


def prefix(values, width, height):
    result = [0.0] * ((width + 1) * (height + 1))
    for y in range(height):
        row = 0.0
        for x in range(width):
            row += values[y * width + x]
            result[(y + 1) * (width + 1) + x + 1] = result[y * (width + 1) + x + 1] + row
    return result


def box(values, width, x, y, size):
    stride = width + 1
    return (values[(y + size) * stride + x + size] + values[y * stride + x]
            - values[y * stride + x + size] - values[(y + size) * stride + x])


def denoise(source, width, height, coefficients, luminance, chroma, method,
            luminance_bandwidth=0.08, chroma_bandwidth=0.16):
    if luminance == chroma == 0:
        return [p[:] for p in source]
    features = [encode(p, coefficients) for p in source]
    h_l, h_c = luminance_bandwidth * (luminance / 100) ** 2, chroma_bandwidth * (chroma / 100) ** 2
    sums = [[0.0] * 5 for _ in source]
    patch = PATCH if method == 'nlm' else 0
    padded_width, padded_height = width + 2 * patch, height + 2 * patch

    def index(x, y):
        return max(0, min(height - 1, y)) * width + max(0, min(width - 1, x))

    for dy in range(-RADIUS, RADIUS + 1):
        for dx in range(-RADIUS, RADIUS + 1):
            dl, dc, coverage = [], [], []
            for y in range(-patch, height + patch):
                for x in range(-patch, width + patch):
                    i, j = index(x, y), index(x + dx, y + dy)
                    alpha = source[i][3] * source[j][3]
                    coverage.append(alpha)
                    dl.append(alpha * (features[i][0] - features[j][0]) ** 2)
                    dc.append(alpha * ((features[i][1] - features[j][1]) ** 2
                                       + (features[i][2] - features[j][2]) ** 2))
            l_sum, c_sum, a_sum = [prefix(v, padded_width, padded_height) for v in [dl, dc, coverage]]
            spatial = math.exp(-(dx * dx + dy * dy) / (2 * SPATIAL_SIGMA ** 2))
            for y in range(height):
                for x in range(width):
                    i, j = y * width + x, index(x + dx, y + dy)
                    if source[i][3] == 0 or source[j][3] == 0:
                        continue
                    a = box(a_sum, padded_width, x, y, 2 * patch + 1)
                    if a <= 0:
                        continue
                    # Integral sums may have harmless negative cancellation at exact zero.
                    l = max(0.0, box(l_sum, padded_width, x, y, 2 * patch + 1) / a)
                    c = max(0.0, box(c_sum, padded_width, x, y, 2 * patch + 1) / a)
                    wl = spatial * source[j][3] * math.exp(-l / h_l ** 2 - c / 0.12 ** 2) if h_l else 0
                    wc = spatial * source[j][3] * math.exp(-l / 0.08 ** 2 - c / h_c ** 2) if h_c else 0
                    sums[i][0] += wl * (features[j][0] - features[i][0])
                    sums[i][1] += wc * (features[j][1] - features[i][1])
                    sums[i][2] += wc * (features[j][2] - features[i][2])
                    sums[i][3] += wl
                    sums[i][4] += wc
    result = []
    for rgb, values in zip(source, sums):
        if rgb[3] == 0:
            result.append(rgb[:])
            continue
        y = math.fsum(a * b for a, b in zip(rgb[:3], coefficients))
        u, v, scale = rgb[0] - y, rgb[2] - y, math.hypot(y, K)
        dy = change(y, K, values[0] / values[3]) if h_l else 0
        du = change(u, scale, values[1] / values[4]) if h_c else 0
        dv = change(v, scale, values[2] / values[4]) if h_c else 0
        result.append([f32(rgb[0] + dy + du),
                       f32(rgb[1] + dy - (coefficients[0] * du + coefficients[2] * dv) / coefficients[1]),
                       f32(rgb[2] + dy + dv), rgb[3]])
    return result


def sharpen(source, width, height, coefficients, amount=50, radius=1, threshold=50):
    if amount == 0:
        return [p[:] for p in source]
    luminance = [math.fsum(a * b for a, b in zip(p[:3], coefficients)) for p in source]
    features = [math.asinh(v / K) for v in luminance]
    support = math.ceil(3 * radius)
    weights = [math.exp(-i * i / (2 * radius * radius)) for i in range(-support, support + 1)]
    t = 0.08 * threshold / 100
    result = []
    for y in range(height):
        for x in range(width):
            i = y * width + x
            if source[i][3] == 0:
                result.append(source[i][:])
                continue
            total, difference = 0.0, 0.0
            low, high = luminance[i], luminance[i]
            for oy in range(-support, support + 1):
                for ox in range(-support, support + 1):
                    j = max(0, min(height - 1, y + oy)) * width + max(0, min(width - 1, x + ox))
                    if source[j][3] == 0:
                        continue
                    weight = weights[ox + support] * weights[oy + support] * source[j][3]
                    total += weight
                    difference += weight * (features[i] - features[j])
                    low, high = min(low, luminance[j]), max(high, luminance[j])
            detail = difference / total
            protected = detail * detail / (detail * detail + t * t) if detail else 0
            proposed = luminance[i] + change(luminance[i], K, amount / 100 * detail * protected)
            limit = (high - low) * 0.03
            dy = max(low - limit, min(high + limit, proposed)) - luminance[i]
            result.append([*[f32(c + dy) for c in source[i][:3]], source[i][3]])
    return result


class Noise:
    def __init__(self, seed):
        self.state = seed

    def uniform(self):
        self.state = (1664525 * self.state + 1013904223) & 0xffffffff
        return (self.state + 0.5) / 4294967296

    def normal(self):
        return math.sqrt(-2 * math.log(self.uniform())) * math.cos(2 * math.pi * self.uniform())


def charts(seed=0x4c554d41, holdout=False):
    width, height = 32, 24
    cases = []
    recipes = [
        ('flat-luminance', 50, 0, 0.012, 0), ('flat-chroma', 0, 50, 0, 0.012),
        ('mixed-flat', 50, 50, 0.012, 0.012), ('period-2', 50, 0, 0.012, 0),
        ('period-4', 50, 0, 0.012, 0), ('edge', 50, 50, 0.012, 0.012),
        ('isoluminant', 50, 50, 0.012, 0.012), ('stars', 50, 0, 0.012, 0),
        ('merge-boundary', 50, 50, 0.012, 0.012),
    ]
    if holdout:
        recipes += [(f'period-{period}', 50, 0, 0.012, 0) for period in [3, 6, 8]]
    for name, ls, cs, sl, sc in recipes:
        noise = Noise(seed)
        clean, entering = [], []
        for y in range(height):
            for x in range(width):
                l, a, b = 1.0, 0.08, -0.04
                if name == 'period-2':
                    l += 0.024 * (-1 if x % 2 else 1)
                elif name.startswith('period-'):
                    l += 0.03 * math.sin(2 * math.pi * x / int(name.split('-')[1]))
                elif name == 'edge':
                    l = 0.7 if x < width // 2 else 1.4
                elif name == 'isoluminant':
                    a = -0.2 if x < width // 2 else 0.2
                elif name == 'stars':
                    l, a, b = 0.04, 0.0, 0.0
                    if (x, y) in [(8, 8), (23, 8), (8, 16), (23, 16)]:
                        l += 0.18
                factor = (2 if x < width // 2 else 0.5) if name == 'merge-boundary' else 1
                clean.append([f32(v) for v in decode([l, a, b], LUMINANCE['srgb'])])
                entering.append([f32(v) for v in decode([l + sl * factor * noise.normal(),
                    a + sc * factor * noise.normal(), b + sc * factor * noise.normal()], LUMINANCE['srgb'])])
        cases.append(dict(name=name, width=width, height=height, primaries='srgb', luminance=ls,
                          chroma=cs, clean=clean, entering=entering))
    return cases


def rms(values):
    return math.sqrt(math.fsum(v * v for v in values) / len(values))


def evaluate(case, filtered):
    w, h = case['width'], case['height']
    clean, entering, output = [[encode(p, LUMINANCE[case['primaries']]) for p in values]
                               for values in [case['clean'], case['entering'], filtered]]
    indices = [y * w + x for y in range(4, h - 4) for x in range(4, w - 4)]
    before = [[entering[i][c] - clean[i][c] for i in indices] for c in range(3)]
    after = [[output[i][c] - clean[i][c] for i in indices] for c in range(3)]
    result = {'luminanceRmsRatio': rms(after[0]) / rms(before[0]) if rms(before[0]) > 1e-7 else None,
              'chromaRmsRatio': rms(after[1] + after[2]) / rms(before[1] + before[2]) if rms(before[1] + before[2]) > 1e-7 else None,
              'meanBias': [math.fsum(v) / len(v) for v in after], 'gates': {}}
    gates, name = result['gates'], case['name']
    if name == 'flat-luminance':
        gates['noise'] = result['luminanceRmsRatio'] <= 0.55
        gates['bias'] = abs(result['meanBias'][0]) <= 0.003
    if name == 'flat-chroma':
        gates['noise'] = result['chromaRmsRatio'] <= 0.45
        gates['bias'] = max(abs(v) for v in result['meanBias'][1:]) <= 0.003
    if name.startswith('period-'):
        period = int(name.split('-')[1])
        pattern = [(-1 if i % w % 2 else 1) if period == 2 else math.sin(2 * math.pi * (i % w) / period) for i in indices]
        def amplitude(values):
            mean = math.fsum(values[i][0] for i in indices) / len(indices)
            return math.fsum((values[i][0] - mean) * p for i, p in zip(indices, pattern)) / math.fsum(p * p for p in pattern)
        result['textureRetention'] = amplitude(output) / amplitude(clean)
        gates['texture'] = 0.90 <= result['textureRetention'] <= 1.05
    if name in ['edge', 'isoluminant']:
        c, step = (0, 0.7) if name == 'edge' else (1, 0.4)
        errors = [math.fsum(output[y * w + x][c] - clean[y * w + x][c] for y in range(4, h - 4)) / (h - 8)
                  for x in [w // 2 - 1, w // 2]]
        result['edgeLeakage'] = max(map(abs, errors)) / step
        gates['edgeLeakage'] = result['edgeLeakage'] <= 0.03
        def edge_width(values):
            profile = [math.fsum(values[y * w + x][c] for y in range(4, h - 4)) / (h - 8) for x in range(w)]
            left = math.fsum(profile[4:10]) / 6
            right = math.fsum(profile[w - 10:w - 4]) / 6
            def crossing(fraction):
                target = left + fraction * (right - left)
                for x in range(w - 1):
                    if profile[x] <= target <= profile[x + 1]:
                        return x + (target - profile[x]) / (profile[x + 1] - profile[x])
                return float('inf')
            return crossing(0.9) - crossing(0.1)
        result['edgeWidthGrowth'] = edge_width(output) - edge_width(clean)
        gates['edgeWidth'] = result['edgeWidthGrowth'] <= 0.5
    if name == 'stars':
        centers = [(8, 8), (23, 8), (8, 16), (23, 16)]
        ratios, peaks = [], []
        for x, y in centers:
            i = y * w + x
            ratios.append((output[i][0] - 0.04) / (entering[i][0] - 0.04))
            neighbors = [(xx, yy) for yy in range(y - 2, y + 3) for xx in range(x - 2, x + 3)]
            peaks.append(max(neighbors, key=lambda p: output[p[1] * w + p[0]][0]) == (x, y))
        result['minimumPeakRetention'] = min(ratios)
        gates['stars'] = min(ratios) >= 0.90 and all(peaks)
    if name == 'merge-boundary':
        def jump(values, c):
            means = [math.fsum(values[y * w + x][c] for y in range(4, h - 4) for x in xs) / ((h - 8) * 6)
                     for xs in [range(w // 2 - 6, w // 2), range(w // 2, w // 2 + 6)]]
            return means[0] - means[1]
        result['inducedBoundaryJump'] = max(abs(jump(output, c) - jump(entering, c)) for c in range(3))
        gates['meanContinuity'] = result['inducedBoundaryJump'] <= 0.003
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path)
    parser.add_argument('--luminance-bandwidth', type=float, default=0.08)
    parser.add_argument('--chroma-bandwidth', type=float, default=0.16)
    parser.add_argument('--seed', type=int, default=0x4c554d41)
    parser.add_argument('--comparison', default='detail-candidates-v2')
    parser.add_argument('--holdout', action='store_true')
    args = parser.parse_args()
    started, cases, results = time.perf_counter(), charts(args.seed, args.holdout), {}
    for method in ['bilateral', 'nlm']:
        results[method] = {}
        for case in cases:
            filtered = denoise(case['entering'], case['width'], case['height'], LUMINANCE[case['primaries']], case['luminance'], case['chroma'], method, args.luminance_bandwidth, args.chroma_bandwidth)
            results[method][case['name']] = evaluate(case, filtered)
            print(method, case['name'], json.dumps(results[method][case['name']]), flush=True)
    noise_case = cases[0]
    sharpened = sharpen(noise_case['entering'], noise_case['width'], noise_case['height'], LUMINANCE['srgb'])
    sharp = evaluate(noise_case, sharpened)
    sharp['gates'] = {'noiseGain': sharp['luminanceRmsRatio'] <= 1.10}
    results['sharpening'] = {'flat-noise': sharp}
    result = {'comparisonVersion': args.comparison, 'license': 'CC0-1.0',
        'sources': {p.name: sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), helper]},
        'coefficients': LUMINANCE, 'width': 32, 'height': 24, 'results': results,
        'parameters': {'luminanceBandwidthMaximum': args.luminance_bandwidth, 'chromaBandwidthMaximum': args.chroma_bandwidth, 'seed': args.seed},
        'elapsedSeconds': time.perf_counter() - started,
        'limitations': ['Synthetic Float32 inputs only', 'No camera calibration/automatic estimator',
                       'No real-source, foreground or performance acceptance',
                       'Alpha/HDR/tiling and other sharpening gates need separate references']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    if args.fixtures:
        args.fixtures.parent.mkdir(parents=True, exist_ok=True)
        args.fixtures.write_text(json.dumps({'version': 1, 'license': 'CC0-1.0', 'cases': cases}, indent=2) + '\n')
    print('Saved', args.output, 'in', result['elapsedSeconds'], 'seconds', flush=True)


if __name__ == '__main__':
    main()
