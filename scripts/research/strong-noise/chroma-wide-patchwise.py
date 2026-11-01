"""Unenabled C12 research: radius-10 chroma search, unchanged radius-3 luminance.

Uses the original authored C9 k40 patchwise equations and frozen source variance.
Only chroma support grows from radius 3 to 10. No C10 guard, application path,
candidate execution or adoption is introduced at import time.
"""
import importlib.util
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('wide_chroma_shared_patchwise', HERE / 'patchwise.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
estimate = previous.estimate
OFFSETS = previous.OFFSETS
SPATIAL_POLICY = 'uniform-search-v1'
L_SEARCH_RADIUS = 3
C_SEARCH_RADIUS = 10
spec = importlib.util.spec_from_file_location('wide_chroma_c0_c9', HERE / 'noise-scaled-patchwise.py')
legacy_c9 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy_c9)


def validate_candidate(candidate):
    expected = {'id': 'noise-scaled-k40-chroma-uniform-r10',
                'aggregation': 'normalized-patch-estimates-f32-zero-v1',
                'variance': 'frozen-global-directional-mad-v1',
                'correction': 'both', 'adaptive': 'none',
                'blend': 'quadratic-to-50-v1', 'selfPolicy': 'legacy',
                'bandwidthPolicy': 'global-chroma-sigma-floor-v1',
                'luminanceBandwidthMaximum': .024, 'chromaBandwidthMaximum': .024,
                'chromaSigmaFactor': .4, 'chromaSpatialPolicy': SPATIAL_POLICY,
                'luminanceSearchRadius': 3, 'chromaSearchRadius': 10}
    if any(candidate.get(key) != value for key, value in expected.items()) or 'chromaDistancePolicy' in candidate:
        raise ValueError('Undeclared wide-chroma candidate policy.')


def denoise(model, source, width, height, coefficients, luminance, chroma,
            candidate, oracle_variance=None, capture_deltas=False,
            estimate_snapshot=None, capture_stages=False):
    validate_candidate(candidate)
    if chroma == 0:
        # Preserve the old research operator byte-for-byte for all C=0 calls.
        old_candidate = {key: value for key, value in candidate.items()
                         if key not in ('chromaSpatialPolicy', 'luminanceSearchRadius', 'chromaSearchRadius')}
        old_candidate['id'] = 'noise-scaled-k40'
        output, diagnostics = legacy_c9.denoise(model, source, width, height,
            coefficients, luminance, chroma, old_candidate, oracle_variance,
            capture_deltas, estimate_snapshot, capture_stages)
        diagnostics.update({'chromaSpatialPolicy': SPATIAL_POLICY,
                            'luminanceSearchRadius': L_SEARCH_RADIUS,
                            'chromaSearchRadius': C_SEARCH_RADIUS,
                            'dispatch': 'unchanged-c9-chroma-zero-v1'})
        return output, diagnostics
    if len(source) != width * height:
        raise ValueError('Incomplete source.')
    alpha = [p[3] for p in source]
    # Transparent words never enter feature arithmetic or neighbor comparisons.
    features = [model.encode(p, coefficients) if p[3] > 0 else (0.0, 0.0, 0.0)
                for p in source]
    snapshot = estimate_snapshot if estimate_snapshot is not None else estimate(features, alpha, width, height)
    if snapshot.get('version') != 'frozen-global-directional-mad-v1' or len(snapshot['variance']) != 3 or not all(math.isfinite(v) and v >= 0 for v in snapshot['variance']):
        raise ValueError('Invalid frozen estimator snapshot.')
    vl, va, vb = snapshot['variance']
    base, factor = candidate['chromaBandwidthMaximum'], candidate['chromaSigmaFactor']
    maximum = math.sqrt(base * base + factor * factor * (va + vb))
    if not math.isfinite(maximum):
        raise ValueError('Source variance exceeds finite bandwidth computation.')
    h_l = candidate['luminanceBandwidthMaximum'] * (luminance / 100) ** 2
    h_c = maximum * (chroma / 100) ** 2
    # Five Float64 accumulators per center/tap: three deltas and two denominators.
    sums = [[0.0] * 45 for _ in source]
    padded_width, padded_height = width + 2, height + 2

    def index(x, y):
        return max(0, min(height - 1, y)) * width + max(0, min(width - 1, x))

    for dy in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
        for dx in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
            luminance_offset = abs(dx) <= L_SEARCH_RADIUS and abs(dy) <= L_SEARCH_RADIUS
            dl, dc, bl, bc, coverage = [], [], [], [], []
            for y in range(-1, height + 1):
                for x in range(-1, width + 1):
                    p, q = index(x, y), index(x + dx, y + dy)
                    a = alpha[p] * alpha[q]
                    coverage.append(a)
                    if a == 0:
                        dl.append(0.0); dc.append(0.0)
                        bl.append(0.0); bc.append(0.0)
                        continue
                    dl.append(a * (features[p][0] - features[q][0]) ** 2)
                    dc.append(a * ((features[p][1] - features[q][1]) ** 2 + (features[p][2] - features[q][2]) ** 2))
                    bl.append(0.0 if p == q else a * (2 * vl))
                    bc.append(0.0 if p == q else a * (2 * (va + vb)))
            tables = [model.prefix(v, padded_width, padded_height)
                      for v in (dl, dc, bl, bc, coverage)]
            spatial = math.exp(-(dx * dx + dy * dy) / 8)
            for cy in range(height):
                for cx in range(width):
                    c, q = cy * width + cx, index(cx + dx, cy + dy)
                    if alpha[c] == 0 or alpha[q] == 0:
                        continue
                    patch = [model.box(t, padded_width, cx, cy, 3) for t in tables]
                    if patch[4] <= 0:
                        raise ArithmeticError('Visible center lost self patch coverage.')
                    raw_l, raw_c, bias_l, bias_c = [max(0.0, v / patch[4]) for v in patch[:4]]
                    distance_l = max(raw_l - bias_l, 0.0)
                    distance_c = max(raw_c - bias_c, 0.0)
                    wl = spatial * alpha[q] * math.exp(-distance_l / h_l ** 2 - distance_c / .12 ** 2) if h_l and luminance_offset else 0.0
                    # Chroma retains every radius-10 offset with uniform mass;
                    # d=0 retains its original alpha self mass.
                    wc = alpha[q] * math.exp(-distance_l / .08 ** 2 - distance_c / h_c ** 2) if h_c else 0.0
                    state = sums[c]
                    for ri, (rx, ry) in enumerate(OFFSETS):
                        tx, ty = cx + rx, cy + ry
                        if tx < 0 or tx >= width or ty < 0 or ty >= height:
                            continue
                        t = ty * width + tx
                        if alpha[t] == 0:
                            continue
                        # Offset BEFORE global clamp: v=clamp(c+d+r)=clamp(t+d).
                        v = index(tx + dx, ty + dy)
                        if alpha[v] == 0:
                            continue
                        weight_l, weight_c = wl * alpha[v], wc * alpha[v]
                        at = ri * 5
                        if h_l and luminance_offset:
                            state[at] += weight_l * (features[v][0] - features[t][0])
                            state[at + 3] += weight_l
                        if h_c:
                            state[at + 1] += weight_c * (features[v][1] - features[t][1])
                            state[at + 2] += weight_c * (features[v][2] - features[t][2])
                            state[at + 4] += weight_c
    centers = [[0.0] * 27 for _ in source]
    for cy in range(height):
        for cx in range(width):
            c = cy * width + cx
            if alpha[c] == 0:
                continue
            for ri, (rx, ry) in enumerate(OFFSETS):
                tx, ty = cx + rx, cy + ry
                if tx < 0 or tx >= width or ty < 0 or ty >= height or alpha[ty * width + tx] == 0:
                    continue
                at = ri * 5
                for component, enabled in ((0, h_l), (1, h_c), (2, h_c)):
                    if not enabled:
                        continue
                    denominator = sums[c][at + (3 if component == 0 else 4)]
                    if denominator <= 0:
                        raise ArithmeticError('Visible target lost positive inner denominator.')
                    published = model.f32(sums[c][at + component] / denominator)
                    # Only stage zeros are canonical; source payloads stay exact.
                    centers[c][ri * 3 + component] = published if published != 0 else 0.0
    output, unrounded, proposals = [], [], []
    for py in range(height):
        for px in range(width):
            p = py * width + px
            rgb = source[p]
            if alpha[p] == 0:
                output.append(rgb[:]); unrounded.append(rgb[:]); proposals.append([0.0] * 3)
                continue
            total, delta = 0.0, [0.0] * 3
            for ri, (rx, ry) in enumerate(OFFSETS):
                cx, cy = px - rx, py - ry
                if cx < 0 or cx >= width or cy < 0 or cy >= height:
                    continue
                c = cy * width + cx
                if alpha[c] == 0:
                    continue
                total += alpha[c]
                for component in range(3):
                    delta[component] += alpha[c] * centers[c][ri * 3 + component]
            if total <= 0:
                raise ArithmeticError('Visible owner lost outer normalization.')
            delta = [v / total for v in delta]
            if 0 < luminance < 50:
                delta[0] *= (luminance / 50) ** 2
            if 0 < chroma < 50:
                delta[1] *= (chroma / 50) ** 2
                delta[2] *= (chroma / 50) ** 2
            proposals.append(delta)
            y = math.fsum(a * b for a, b in zip(rgb[:3], coefficients))
            scale = math.hypot(y, .18)
            dy = model.change(y, .18, delta[0]) if h_l else 0.0
            da = model.change(rgb[0] - y, scale, delta[1]) if h_c else 0.0
            db = model.change(rgb[2] - y, scale, delta[2]) if h_c else 0.0
            if dy == da == db == 0:
                result = rgb[:]
            else:
                result = [rgb[0] + dy + da,
                    rgb[1] + dy - (coefficients[0] * da + coefficients[2] * db) / coefficients[1],
                    rgb[2] + dy + db, rgb[3]]
            unrounded.append(result)
            output.append([model.f32(v) for v in result[:3]] + [rgb[3]])
    return output, {'estimator': snapshot,
        'aggregation': candidate['aggregation'],
        'chromaSpatialPolicy': SPATIAL_POLICY,
        'luminanceSearchRadius': L_SEARCH_RADIUS,
        'chromaSearchRadius': C_SEARCH_RADIUS,
        'chromaBandwidthPolicy': {'version': candidate['bandwidthPolicy'],
            'baseMaximum': base, 'noiseFactor': factor, 'frozenVariance': snapshot['variance'],
            'compiledMaximum': maximum,
            'scope': 'Whole prepared source; no ROI, viewport, crop, tile or amount re-estimation.'},
        'effectiveBandwidths': {'hL': h_l, 'hC': h_c, 'gL': .08, 'gC': .12},
        **({'featureDeltas': proposals} if capture_deltas else {}),
        **({'centerDeltas': centers, 'outputFloat64': unrounded} if capture_stages else {})}
