"""Unenabled C15 research: fixed feature pilot and pointwise chroma estimation.

This source-only draft is not an application processing path. It preserves
original luminance and C=0 behavior, and copies the authored C14 feature phase
only to stop before its RGB inverse. The immutable pilot guides averaging of
original values; it is not adopted as output or re-encoded from RGB.
"""
import importlib.util
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pilot_pointwise_shared', HERE / 'patchwise.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
estimate = previous.estimate
spec = importlib.util.spec_from_file_location('pilot_pointwise_c0_c9', HERE / 'noise-scaled-patchwise.py')
legacy_c9 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy_c9)
L_OFFSETS = previous.OFFSETS
OFFSETS = L_OFFSETS
L_SEARCH_RADIUS = 3
C_SEARCH_RADIUS = 10
L_MATCH_RADIUS = 1
C_MATCH_RADIUS = 2
L_TARGET_RADIUS = 1
C_TARGET_RADIUS = 2
C_OFFSETS = tuple((x, y) for y in range(-C_TARGET_RADIUS, C_TARGET_RADIUS + 1)
                  for x in range(-C_TARGET_RADIUS, C_TARGET_RADIUS + 1))
SPATIAL_POLICY = 'uniform-search-v1'
STAGE_LAYOUT = 'l9-row-major-c1-ab-owner-v1'
PILOT_STAGE_LAYOUT = 'l9-row-major-c25-ab-row-major-v1'
EXPECTED_CANDIDATE = {'id': 'noise-scaled-k40-c14-pilot-pointwise-r10',
 'variance': 'frozen-global-directional-mad-v1',
 'varianceDomain': 'original-prepared-features-v1',
 'correction': 'fixed-c14-pilot-both-final-none-v1',
 'adaptive': 'none',
 'blend': 'quadratic-to-50-v1',
 'selfPolicy': 'legacy',
 'luminanceBandwidthMaximum': 0.024,
 'chromaBandwidthMaximum': 0.024,
 'chromaSigmaFactor': 0.4,
 'bandwidthPolicy': 'global-chroma-sigma-floor-v1',
 'chromaSpatialPolicy': 'uniform-search-v1',
 'aggregation': 'normalized-l9-patch-c1-owner-estimates-f32-zero-v1',
 'guidePolicy': 'fixed-c14-100-100-preinverse-feature-rn32-v1',
 'chromaDistancePolicy': 'pointwise-pilot-l08-ab-sum-hc-no-bias-v1',
 'valuePolicy': 'original-features-only-v1',
 'neighborAlphaPolicy': 'squared-visible-neighbor-v1',
 'luminanceSearchRadius': 3,
 'chromaSearchRadius': 10,
 'luminanceMatchingRadius': 1,
 'chromaMatchingRadius': 0,
 'luminanceTargetRadius': 1,
 'chromaTargetRadius': 0,
 'guideScalars': 3,
 'stageScalars': 11,
 'stageLayout': 'l9-row-major-c1-ab-owner-v1',
 'adoptionCandidate': True,
 'role': 'One disabled CPU research hypothesis: fixed pre-inverse C14 guide, pointwise pilot '
         'similarities, original-value chroma estimation. Original L feature proposal/E words and '
         'exact C0 route preserved; no final RGB dot-product luminance identity claim.'}


def validate_candidate(candidate):
    if not isinstance(candidate, dict) or candidate.keys() != EXPECTED_CANDIDATE.keys():
        raise ValueError('Undeclared pilot-pointwise candidate fields.')
    if any(type(candidate[key]) is not type(value) or candidate[key] != value
           for key, value in EXPECTED_CANDIDATE.items()):
        raise ValueError('Undeclared pilot-pointwise candidate policy.')


def _legacy_candidate():
    return {'id': 'noise-scaled-k40', 'variance': 'frozen-global-directional-mad-v1',
            'correction': 'both', 'adaptive': 'none', 'blend': 'quadratic-to-50-v1',
            'selfPolicy': 'legacy', 'luminanceBandwidthMaximum': .024,
            'chromaBandwidthMaximum': .024, 'chromaSigmaFactor': .4,
            'bandwidthPolicy': 'global-chroma-sigma-floor-v1',
            'aggregation': 'normalized-patch-estimates-f32-zero-v1'}


def _component_feature_proposals(model, features, alpha, width, height,
                                 luminance, chroma, snapshot):
    """C14 feature estimation/publication/gather; deliberately no RGB inverse.

    Keeping the original pad1 luminance prefix and search order preserves the
    old L proposal/E words. Offsets unused by an L-only request are skipped
    before any arithmetic; the remaining luminance operations keep their order.
    """
    vl, va, vb = snapshot['variance']
    base, factor = .024, .4
    maximum = math.sqrt(base * base + factor * factor * (va + vb))
    if not math.isfinite(maximum):
        raise ValueError('Source variance exceeds finite bandwidth computation.')
    h_l = .024 * (luminance / 100) ** 2
    h_c = maximum * (chroma / 100) ** 2
    # L uses nine (delta, denominator) pairs; C uses 25 (A, B, denominator) triples.
    luminance_sums = [[0.0] * (len(L_OFFSETS) * 2) for _ in features]
    chroma_sums = [[0.0] * (len(C_OFFSETS) * 3) for _ in features]
    padded_width, padded_height = width + 2 * C_MATCH_RADIUS, height + 2 * C_MATCH_RADIUS
    luminance_width, luminance_height = width + 2 * L_MATCH_RADIUS, height + 2 * L_MATCH_RADIUS

    def index(x, y):
        return max(0, min(height - 1, y)) * width + max(0, min(width - 1, x))

    for dy in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
        for dx in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
            luminance_offset = abs(dx) <= L_SEARCH_RADIUS and abs(dy) <= L_SEARCH_RADIUS
            if not h_c and not luminance_offset:
                continue
            dl, dc, bl, bc, coverage = [], [], [], [], []
            for y in range(-C_MATCH_RADIUS, height + C_MATCH_RADIUS):
                for x in range(-C_MATCH_RADIUS, width + C_MATCH_RADIUS):
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
            fields = (dl, dc, bl, bc, coverage)
            chroma_tables = [model.prefix(v, padded_width, padded_height) for v in fields]
            luminance_tables = None
            if h_l and luminance_offset:
                # Crop the outer pad2 border before prefixing. Every old pad1
                # source value, row sum and rectangle arithmetic stays in order.
                margin = C_MATCH_RADIUS - L_MATCH_RADIUS
                if margin < 0:
                    raise ValueError('Unsupported matching-window order.')
                def old_luminance_grid(values):
                    if not margin:
                        return values
                    return [values[y * padded_width + x]
                            for y in range(margin, padded_height - margin)
                            for x in range(margin, padded_width - margin)]
                luminance_tables = [model.prefix(old_luminance_grid(v), luminance_width, luminance_height)
                                    for v in fields]
            spatial = math.exp(-(dx * dx + dy * dy) / 8)
            for cy in range(height):
                for cx in range(width):
                    c, q = cy * width + cx, index(cx + dx, cy + dy)
                    if alpha[c] == 0 or alpha[q] == 0:
                        continue
                    chroma_patch = [model.box(t, padded_width, cx, cy, 2 * C_MATCH_RADIUS + 1)
                                    for t in chroma_tables]
                    if chroma_patch[4] <= 0:
                        raise ArithmeticError('Visible center lost chroma patch coverage.')
                    raw_cl, raw_cc, bias_cl, bias_cc = [max(0.0, v / chroma_patch[4])
                                                      for v in chroma_patch[:4]]
                    distance_cl = max(raw_cl - bias_cl, 0.0)
                    distance_cc = max(raw_cc - bias_cc, 0.0)
                    wl = 0.0
                    if h_l and luminance_offset:
                        luminance_patch = [model.box(t, luminance_width, cx, cy, 2 * L_MATCH_RADIUS + 1)
                                           for t in luminance_tables]
                        if luminance_patch[4] <= 0:
                            raise ArithmeticError('Visible center lost luminance patch coverage.')
                        raw_ll, raw_lc, bias_ll, bias_lc = [max(0.0, v / luminance_patch[4])
                                                          for v in luminance_patch[:4]]
                        distance_ll = max(raw_ll - bias_ll, 0.0)
                        distance_lc = max(raw_lc - bias_lc, 0.0)
                        wl = spatial * alpha[q] * math.exp(-distance_ll / h_l ** 2 - distance_lc / .12 ** 2)
                    # The same matched 5x5 chroma patch supplies all 25 targets.
                    wc = alpha[q] * math.exp(-distance_cl / .08 ** 2 - distance_cc / h_c ** 2) if h_c else 0.0
                    if h_l and luminance_offset:
                        state = luminance_sums[c]
                        for ri, (rx, ry) in enumerate(L_OFFSETS):
                            tx, ty = cx + rx, cy + ry
                            if tx < 0 or tx >= width or ty < 0 or ty >= height:
                                continue
                            t = ty * width + tx
                            if alpha[t] == 0:
                                continue
                            v = index(tx + dx, ty + dy)
                            if alpha[v] == 0:
                                continue
                            weight_l = wl * alpha[v]
                            at = ri * 2
                            state[at] += weight_l * (features[v][0] - features[t][0])
                            state[at + 1] += weight_l
                    if h_c:
                        state = chroma_sums[c]
                        for ri, (rx, ry) in enumerate(C_OFFSETS):
                            tx, ty = cx + rx, cy + ry
                            if tx < 0 or tx >= width or ty < 0 or ty >= height:
                                continue
                            t = ty * width + tx
                            if alpha[t] == 0:
                                continue
                            # Offset before global clamp: v=clamp(c+d+r)=clamp(t+d).
                            v = index(tx + dx, ty + dy)
                            if alpha[v] == 0:
                                continue
                            weight_c = wc * alpha[v]
                            at = ri * 3
                            state[at] += weight_c * (features[v][1] - features[t][1])
                            state[at + 1] += weight_c * (features[v][2] - features[t][2])
                            state[at + 2] += weight_c
    # Fixed active layout: L9 row-major, then C25 row-major interleaved A/B.
    centers = [[0.0] * 59 for _ in features]
    for cy in range(height):
        for cx in range(width):
            c = cy * width + cx
            if alpha[c] == 0:
                continue
            for offsets, enabled, sums, stride, components, stage_base in (
                    (L_OFFSETS, h_l, luminance_sums, 2, 1, 0),
                    (C_OFFSETS, h_c, chroma_sums, 3, 2, 9)):
                if not enabled:
                    continue
                for ri, (rx, ry) in enumerate(offsets):
                    tx, ty = cx + rx, cy + ry
                    if tx < 0 or tx >= width or ty < 0 or ty >= height or alpha[ty * width + tx] == 0:
                        continue
                    at = ri * stride
                    denominator = sums[c][at + components]
                    if denominator <= 0:
                        raise ArithmeticError('Visible target lost positive inner denominator.')
                    for component in range(components):
                        published = model.f32(sums[c][at + component] / denominator)
                        # Only stage zeros are canonical; source payloads stay exact.
                        centers[c][stage_base + ri * components + component] = published if published != 0 else 0.0
    proposals = []
    for py in range(height):
        for px in range(width):
            p = py * width + px
            if alpha[p] == 0:
                proposals.append([0.0] * 3)
                continue
            delta = [0.0, 0.0, 0.0]
            for offsets, enabled, components, stage_base, first in (
                    (L_OFFSETS, h_l, 1, 0, 0), (C_OFFSETS, h_c, 2, 9, 1)):
                if not enabled:
                    continue
                total, gathered = 0.0, [0.0] * components
                for ri, (rx, ry) in enumerate(offsets):
                    cx, cy = px - rx, py - ry
                    if cx < 0 or cx >= width or cy < 0 or cy >= height:
                        continue
                    c = cy * width + cx
                    if alpha[c] == 0:
                        continue
                    total += alpha[c]
                    for component in range(components):
                        gathered[component] += alpha[c] * centers[c][stage_base + ri * components + component]
                if total <= 0:
                    raise ArithmeticError('Visible owner lost component outer normalization.')
                for component in range(components):
                    delta[first + component] = gathered[component] / total
            if 0 < luminance < 50:
                delta[0] *= (luminance / 50) ** 2
            if 0 < chroma < 50:
                delta[1] *= (chroma / 50) ** 2
                delta[2] *= (chroma / 50) ** 2
            proposals.append(delta)
    return proposals, centers


def publish_guide_component(model, feature, proposal):
    """One declared Float64 addition followed by generic signed-zero RN32."""
    return model.f32(feature + proposal)


def publish_delta_component(model, normalized_delta):
    """One canonical C32 publication of a declared Float64 normalized delta."""
    published = model.f32(normalized_delta)
    return published if published != 0 else 0.0


def publish_chroma_component(model, numerator, normalizer):
    """Keep owner Float64 division before the actual final-E C32 publication."""
    return publish_delta_component(model, numerator / normalizer)


def _build_guide(model, features, alpha, pilot_proposals):
    # Complete this immutable guide before the final pass reads any component.
    return [[publish_guide_component(model, feature, proposal)
             for feature, proposal in zip(features[p], pilot_proposals[p])]
            if alpha[p] > 0 else [0.0, 0.0, 0.0]
            for p in range(len(features))]


def _pointwise_chroma(model, features, guide, alpha, width, height, h_c):
    """Guide similarities, original feature values, normalized owner E words."""
    centers = [[0.0, 0.0] for _ in features]
    for py in range(height):
        for px in range(width):
            p = py * width + px
            if alpha[p] == 0:
                continue
            normalizer, numerator_a, numerator_b = 0.0, 0.0, 0.0
            for dy in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
                for dx in range(-C_SEARCH_RADIUS, C_SEARCH_RADIUS + 1):
                    vx = max(0, min(width - 1, px + dx))
                    vy = max(0, min(height - 1, py + dy))
                    v = vy * width + vx
                    if alpha[v] == 0:
                        continue
                    distance_l = (guide[p][0] - guide[v][0]) ** 2
                    distance_c = ((guide[p][1] - guide[v][1]) ** 2
                                  + (guide[p][2] - guide[v][2]) ** 2)
                    weight = alpha[v] * alpha[v] * math.exp(
                        -distance_l / (.08 * .08) - distance_c / (h_c * h_c))
                    # Preserve dy/dx and Z/A/B accumulation order, including
                    # distinct offsets that clamp to the same physical pixel.
                    normalizer += weight
                    numerator_a += weight * (features[v][1] - features[p][1])
                    numerator_b += weight * (features[v][2] - features[p][2])
            if not normalizer > 0:
                raise ArithmeticError('Visible owner lost positive pointwise normalizer.')
            for component, numerator in enumerate((numerator_a, numerator_b)):
                centers[p][component] = publish_chroma_component(model, numerator, normalizer)
    return centers


def denoise(model, source, width, height, coefficients, luminance, chroma,
            candidate, oracle_variance=None, capture_deltas=False,
            estimate_snapshot=None, capture_stages=False):
    validate_candidate(candidate)
    if chroma == 0:
        # No pilot/features are allocated before the exact legacy C=0 dispatch.
        output, diagnostics = legacy_c9.denoise(model, source, width, height,
            coefficients, luminance, chroma, _legacy_candidate(), oracle_variance,
            capture_deltas, estimate_snapshot, capture_stages)
        diagnostics.update({'dispatch': 'unchanged-c9-chroma-zero-v1',
                            'chromaSpatialPolicy': SPATIAL_POLICY,
                            'guidePolicy': candidate['guidePolicy'],
                            'activeFinalStageLayout': STAGE_LAYOUT,
                            'activeFinalStageScalars': 11,
                            'physicalStage': 'legacy-27-if-present-neutral-may-have-none',
                            'pilotConstructed': False})
        return output, diagnostics
    if len(source) != width * height:
        raise ValueError('Incomplete source.')
    alpha = [p[3] for p in source]
    features = [model.encode(p, coefficients) if p[3] > 0 else (0.0, 0.0, 0.0)
                for p in source]
    snapshot = estimate_snapshot if estimate_snapshot is not None else estimate(
        features, alpha, width, height)
    if (snapshot.get('version') != 'frozen-global-directional-mad-v1'
            or len(snapshot['variance']) != 3
            or not all(math.isfinite(v) and v >= 0 for v in snapshot['variance'])):
        raise ValueError('Invalid frozen estimator snapshot.')
    va, vb = snapshot['variance'][1:]
    maximum = math.sqrt(.024 * .024 + .4 * .4 * (va + vb))
    if not math.isfinite(maximum):
        raise ValueError('Source variance exceeds finite bandwidth computation.')
    h_l = .024 * (luminance / 100) ** 2
    h_c = maximum * (chroma / 100) ** 2
    pilot_proposals, pilot_centers = _component_feature_proposals(
        model, features, alpha, width, height, 100, 100, snapshot)
    guide = _build_guide(model, features, alpha, pilot_proposals)
    if luminance == 100:
        luminance_proposals, luminance_centers = pilot_proposals, pilot_centers
    elif luminance == 0:
        luminance_proposals = [[0.0, 0.0, 0.0] for _ in source]
        luminance_centers = [[0.0] * 9 for _ in source]
    else:
        luminance_proposals, luminance_centers = _component_feature_proposals(
            model, features, alpha, width, height, luminance, 0, snapshot)
    chroma_centers = _pointwise_chroma(model, features, guide, alpha, width, height, h_c)
    centers = [luminance_centers[p][:9] + chroma_centers[p] for p in range(len(source))]
    blend_c = (chroma / 50) ** 2 if 0 < chroma < 50 else 1.0
    output, unrounded, proposals = [], [], []
    for p, rgb in enumerate(source):
        if alpha[p] == 0:
            output.append(rgb[:]); unrounded.append(rgb[:]); proposals.append([0.0] * 3)
            continue
        delta = [luminance_proposals[p][0],
                 blend_c * float(chroma_centers[p][0]),
                 blend_c * float(chroma_centers[p][1])]
        proposals.append(delta)
        y = math.fsum(a * b for a, b in zip(rgb[:3], coefficients))
        scale = math.hypot(y, .18)
        dy = model.change(y, .18, delta[0]) if h_l else 0.0
        da = model.change(rgb[0] - y, scale, delta[1])
        db = model.change(rgb[2] - y, scale, delta[2])
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
        'dispatch': 'pilot-pointwise-chroma-v1',
        'chromaSpatialPolicy': SPATIAL_POLICY,
        'guidePolicy': candidate['guidePolicy'],
        'chromaDistancePolicy': candidate['chromaDistancePolicy'],
        'valuePolicy': candidate['valuePolicy'],
        'neighborAlphaPolicy': candidate['neighborAlphaPolicy'],
        'luminanceSearchRadius': L_SEARCH_RADIUS,
        'chromaSearchRadius': C_SEARCH_RADIUS,
        'luminanceMatchingRadius': L_MATCH_RADIUS,
        'chromaMatchingRadius': 0,
        'luminanceTargetRadius': L_TARGET_RADIUS,
        'chromaTargetRadius': 0,
        'activeFinalStageLayout': STAGE_LAYOUT,
        'activeFinalStageScalars': 11,
        'physicalStage': STAGE_LAYOUT,
        'pilotStageLayout': PILOT_STAGE_LAYOUT,
        'pilotStageScalars': 59,
        'guideScalars': 3,
        'pilotConstructed': True,
        'sourceHalo': {'luminance': 5, 'chroma': 24},
        'proposalBoundRadii': [3, 10, 10],
        'chromaBandwidthPolicy': {'version': candidate['bandwidthPolicy'],
            'baseMaximum': .024, 'noiseFactor': .4, 'frozenVariance': snapshot['variance'],
            'compiledMaximum': maximum,
            'scope': 'Whole original prepared source; never pilot/ROI/tile/amount re-estimation.'},
        'effectiveBandwidths': {'hL': h_l, 'hC': h_c, 'gL': .08, 'gC': .12,
            'gLRole': 'Luminance guide scale for pilot and final chroma matching.',
            'gCRole': 'Original/pilot L chroma guidance only; not the final chroma scale.',
            'originalL': {'luminanceRange': h_l, 'chromaGuide': .12},
            'pilot': {'luminanceRange': .024, 'luminanceChromaGuide': .12,
                      'chromaLuminanceGuide': .08, 'chromaRange': maximum},
            'finalChroma': {'luminanceGuide': .08, 'chromaRange': h_c,
                            'distanceBiasSubtraction': 'none'}},
        **({'featureDeltas': proposals} if capture_deltas else {}),
        **({'centerDeltas': centers, 'outputFloat64': unrounded,
             'pilotCenterDeltas': pilot_centers,
             'pilotFeatureDeltas': pilot_proposals,
             'guideFeatures': guide} if capture_stages else {})}
