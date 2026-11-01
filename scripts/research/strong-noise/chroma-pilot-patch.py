"""Unenabled C16 research: fixed feature pilot and direct guide-patch matching.

Reuse the frozen C15/C14 feature pilot without its RGB inverse. Only the final
guide comparison changes: direct alpha-product-normalized 5x5 patches guide
owner estimates of original chroma values. No application path or prefix cache
is introduced, and original research-C9 luminance/C=0 behavior is preserved.
"""
import importlib.util
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pilot_patch_c15', HERE / 'chroma-pilot-pointwise.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
estimate = pilot.estimate
legacy_c9 = pilot.legacy_c9
L_OFFSETS = pilot.L_OFFSETS
OFFSETS = L_OFFSETS
L_SEARCH_RADIUS = 3
C_SEARCH_RADIUS = 10
L_MATCH_RADIUS = 1
C_MATCH_RADIUS = 2
L_TARGET_RADIUS = 1
C_TARGET_RADIUS = 0
SPATIAL_POLICY = 'uniform-search-v1'
STAGE_LAYOUT = 'l9-row-major-c1-ab-owner-v1'
PILOT_STAGE_LAYOUT = 'l9-row-major-c25-ab-row-major-v1'
EXPECTED_CANDIDATE = {
    'id': 'noise-scaled-k40-c14-pilot-match5-owner-r10',
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
    'chromaDistancePolicy': 'patch5-pilot-l08-ab-sum-qnormalized-hc-no-bias-v1',
    'valuePolicy': 'original-features-only-v1',
    'neighborAlphaPolicy': 'squared-visible-neighbor-v1',
    'luminanceSearchRadius': 3,
    'chromaSearchRadius': 10,
    'luminanceMatchingRadius': 1,
    'chromaMatchingRadius': 2,
    'luminanceTargetRadius': 1,
    'chromaTargetRadius': 0,
    'guideScalars': 3,
    'stageScalars': 11,
    'stageLayout': 'l9-row-major-c1-ab-owner-v1',
    'adoptionCandidate': True,
    'role': 'One disabled prospective CPU research hypothesis: unchanged fixed pre-inverse C14 '
            'guide; direct 5x5 guide-patch similarities; original-value owner chroma E2 without '
            'target-patch publication or gather. Original user-L proposal/E9 and exact research-C9 '
            'C0 route remain mandatory.',
    'matchingAlphaPolicy': 'product-visible-matching-pair-v1',
}

# The component implementation and publication helpers remain in frozen C15.
# Local names are actual composition seams; changing one never mutates C15.
_component_feature_proposals = pilot._component_feature_proposals
_legacy_candidate = pilot._legacy_candidate
publish_guide_component = pilot.publish_guide_component
publish_delta_component = pilot.publish_delta_component


def validate_candidate(candidate):
    if not isinstance(candidate, dict) or candidate.keys() != EXPECTED_CANDIDATE.keys():
        raise ValueError('Undeclared pilot-patch candidate fields.')
    if any(type(candidate[key]) is not type(value) or candidate[key] != value
           for key, value in EXPECTED_CANDIDATE.items()):
        raise ValueError('Undeclared pilot-patch candidate policy.')


def _validate_controls(luminance, chroma):
    for amount in (luminance, chroma):
        if (type(amount) not in (int, float) or not 0 <= amount <= 100
                or int(amount) != amount):
            raise ValueError('Pilot-patch controls must be integers in 0..100.')


def publish_chroma_component(model, numerator, normalizer):
    """Float64 division followed by the actual canonical final-E publication."""
    return publish_delta_component(model, numerator / normalizer)


def _build_guide(model, features, alpha, pilot_proposals):
    """Publish the complete immutable guide through the inherited RN32 seam."""
    return [[publish_guide_component(model, feature, proposal)
             for feature, proposal in zip(features[p], pilot_proposals[p])]
            if alpha[p] > 0 else [0.0, 0.0, 0.0]
            for p in range(len(features))]


def _guide_patch_distances(guide, alpha, width, height, px, py, dx, dy):
    """Direct ordered Q-normalized guide distances, or None for zero coverage.

    The caller already skipped hidden owner/neighbor centers. Clamp the search
    center before matching taps; every enumerated clamped sample is retained.
    Central u=0 guarantees positive coverage for visible admitted centers.
    """
    vx = max(0, min(width - 1, px + dx))
    vy = max(0, min(height - 1, py + dy))
    coverage, sum_l, sum_c = 0.0, 0.0, 0.0
    for uy in range(-C_MATCH_RADIUS, C_MATCH_RADIUS + 1):
        ay = max(0, min(height - 1, py + uy))
        by = max(0, min(height - 1, vy + uy))
        for ux in range(-C_MATCH_RADIUS, C_MATCH_RADIUS + 1):
            ax = max(0, min(width - 1, px + ux))
            bx = max(0, min(width - 1, vx + ux))
            a, b = ay * width + ax, by * width + bx
            q = alpha[a] * alpha[b]
            if q == 0:
                continue
            delta_l = float(guide[a][0]) - float(guide[b][0])
            delta_a = float(guide[a][1]) - float(guide[b][1])
            delta_b = float(guide[a][2]) - float(guide[b][2])
            coverage += q
            sum_l += q * (delta_l * delta_l)
            sum_c += q * ((delta_a * delta_a) + (delta_b * delta_b))
    if coverage == 0:
        return None
    return sum_l / coverage, sum_c / coverage


def _patch_chroma(model, features, guide, alpha, width, height, h_c):
    """Guide-patch similarities and original-value normalized owner E words."""
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
                    distances = _guide_patch_distances(
                        guide, alpha, width, height, px, py, dx, dy)
                    if distances is None:
                        continue
                    distance_l, distance_c = distances
                    weight = alpha[v] * alpha[v] * math.exp(
                        -distance_l / (.08 * .08) - distance_c / (h_c * h_c))
                    # Search order includes every clamped duplicate and every
                    # physical-self contribution, with no self replacement.
                    normalizer += weight
                    numerator_a += weight * (features[v][1] - features[p][1])
                    numerator_b += weight * (features[v][2] - features[p][2])
            if not normalizer > 0:
                raise ArithmeticError('Visible owner lost positive guide-patch normalizer.')
            for component, numerator in enumerate((numerator_a, numerator_b)):
                centers[p][component] = publish_chroma_component(model, numerator, normalizer)
    return centers


def _policy_metadata(candidate):
    return {
        'aggregation': candidate['aggregation'],
        'chromaSpatialPolicy': SPATIAL_POLICY,
        'guidePolicy': candidate['guidePolicy'],
        'chromaDistancePolicy': candidate['chromaDistancePolicy'],
        'matchingAlphaPolicy': candidate['matchingAlphaPolicy'],
        'valuePolicy': candidate['valuePolicy'],
        'neighborAlphaPolicy': candidate['neighborAlphaPolicy'],
        'luminanceSearchRadius': L_SEARCH_RADIUS,
        'chromaSearchRadius': C_SEARCH_RADIUS,
        'luminanceMatchingRadius': L_MATCH_RADIUS,
        'chromaMatchingRadius': C_MATCH_RADIUS,
        'luminanceTargetRadius': L_TARGET_RADIUS,
        'chromaTargetRadius': C_TARGET_RADIUS,
        'activeFinalStageLayout': STAGE_LAYOUT,
        'activeFinalStageScalars': 11,
        'prefixMemoization': 'none',
    }


def denoise(model, source, width, height, coefficients, luminance, chroma,
            candidate, oracle_variance=None, capture_deltas=False,
            estimate_snapshot=None, capture_stages=False):
    validate_candidate(candidate)
    _validate_controls(luminance, chroma)
    if chroma == 0:
        # Preserve the exact physical C9 route before allocating pilot/features.
        output, diagnostics = legacy_c9.denoise(model, source, width, height,
            coefficients, luminance, chroma, _legacy_candidate(), oracle_variance,
            capture_deltas, estimate_snapshot, capture_stages)
        diagnostics.update({**_policy_metadata(candidate),
            'dispatch': 'unchanged-c9-chroma-zero-v1',
            'physicalStage': 'legacy-27-if-present-neutral-may-have-none',
            'pilotConstructed': False, 'finalMetricApplied': False})
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
    chroma_centers = _patch_chroma(model, features, guide, alpha, width, height, h_c)
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
    return output, {**_policy_metadata(candidate),
        'estimator': snapshot,
        'dispatch': 'pilot-patch-chroma-v1',
        'physicalStage': STAGE_LAYOUT,
        'pilotStageLayout': PILOT_STAGE_LAYOUT,
        'pilotStageScalars': 59,
        'guideScalars': 3,
        'pilotConstructed': True,
        'finalMetricApplied': True,
        'sourceHalo': {'luminance': 5, 'chroma': 26},
        'pilotLuminanceGuideDependencyRadius': 17,
        'guideQueryRadius': 12,
        'combinedMaximumSharpeningHalo': 35,
        'proposalBoundRadii': [3, 10, 10],
        'finalMatching': {
            'normalization': 'ordered-alpha-product-Q-v1',
            'coordinates': 'center-first-global-clamp-v1',
            'order': 'uy=-2..2 outer; ux=-2..2 inner',
            'clampedDuplicates': 'retained',
            'zeroCoverage': 'zero-weight-defensive-only',
            'accumulation': 'direct-float64-no-reassociation',
            'chromaTargetRadius': 0,
            'chromaOuterGather': False},
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
                            'matchingRadius': C_MATCH_RADIUS,
                            'distanceBiasSubtraction': 'none'}},
        **({'featureDeltas': proposals} if capture_deltas else {}),
        **({'centerDeltas': centers, 'outputFloat64': unrounded,
             'pilotCenterDeltas': pilot_centers,
             'pilotFeatureDeltas': pilot_proposals,
             'guideFeatures': guide} if capture_stages else {})}
