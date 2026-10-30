"""Unadopted C8 bandwidth hypothesis; reuse the independently checked estimator.

No application imports or new sampling engine. The source-bound variance is
frozen before filtering, and only the maximum chroma bandwidth changes.
"""
import importlib.util
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('c8_shared_patchwise', HERE / 'patchwise.py')
patchwise = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patchwise)
estimate = patchwise.estimate


def denoise(model, source, width, height, coefficients, luminance, chroma,
            candidate, oracle_variance=None, capture_deltas=False,
            estimate_snapshot=None, capture_stages=False):
    policy = candidate.get('bandwidthPolicy', 'fixed')
    if policy == 'fixed' or luminance == chroma == 0:
        return patchwise.denoise(model, source, width, height, coefficients,
            luminance, chroma, candidate, oracle_variance, capture_deltas,
            estimate_snapshot, capture_stages)
    if policy != 'global-chroma-sigma-floor-v1':
        raise ValueError('Unknown bandwidth policy.')
    if estimate_snapshot is None:
        features = [model.encode(p, coefficients) if p[3] > 0 else (0.0, 0.0, 0.0)
                    for p in source]
        estimate_snapshot = estimate(features, [p[3] for p in source], width, height)
    variance = estimate_snapshot['variance']
    if len(variance) != 3 or any(not math.isfinite(v) or v < 0 for v in variance):
        raise ValueError('Invalid frozen source variance.')
    base, factor = candidate['chromaBandwidthMaximum'], candidate['chromaSigmaFactor']
    maximum = math.sqrt(base * base + factor * factor * (variance[1] + variance[2]))
    if not math.isfinite(maximum):
        raise ValueError('Source variance exceeds finite bandwidth computation.')
    compiled = {**candidate, 'chromaBandwidthMaximum': maximum}
    result, diagnostics = patchwise.denoise(model, source, width, height, coefficients,
        luminance, chroma, compiled, oracle_variance, capture_deltas,
        estimate_snapshot, capture_stages)
    diagnostics['chromaBandwidthPolicy'] = {'version': policy, 'baseMaximum': base,
        'noiseFactor': factor, 'frozenVariance': variance, 'compiledMaximum': maximum,
        'scope': 'Whole prepared source; no ROI, viewport, crop, tile or amount re-estimation.'}
    return result, diagnostics
