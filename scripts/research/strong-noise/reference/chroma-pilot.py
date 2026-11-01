#!/usr/bin/env python3
"""CC0-1.0 C15 independent Decimal80 / host-F64 reference source draft.

Artifact-free --plan is metadata only. Numerical generation and candidate
comparison require a later exact root-approved source freeze. No candidate or
application implementation is imported during planning or reference generation.
"""

from argparse import ArgumentParser
from decimal import Decimal, localcontext
from hashlib import sha256
from functools import lru_cache
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
ROOT = Path.cwd().resolve()
SHARED = ROOT / 'scripts/research/strong-noise/reference/reference.py'
SHARED_PLAN = ROOT / 'scripts/research/strong-noise/reference/input-plan.json'
PILOT_REFERENCE = ROOT / 'scripts/research/strong-noise/reference/chroma-full.py'
HOST = HERE / 'pilot-host-f64.py'
POLICY = ROOT / 'assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md'
COMPARISON = ROOT / 'scripts/research/strong-noise/comparison15.json'
KIND = 'chroma-pilot-pointwise-decimal80-host-f64-v1'
CANDIDATE_ID = 'noise-scaled-k40-c14-pilot-pointwise-r10'
GROUPS = ('core', 'alpha', 'asymmetric', 'identity', 'publication')
AMOUNTS = (0, 1, 25, 50, 75, 100)
BASE, FACTOR = '0.024', '0.4'
WORD_ORACLE = {
    'kind': 'host-f64-operation-graph-v1',
    'scope': 'host-runtime-libm-v1',
    'coefficientPolicy': 'independent-Decimal80-primary-solve-rounded-to-binary64-v1',
    'coefficientWords': None,
    'candidateImported': False,
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def source_bindings():
    return {
        'scripts/research/strong-noise/reference/chroma-pilot.py': digest(__file__),
        'scripts/research/strong-noise/reference/pilot-host-f64.py': digest(HOST),
        'scripts/research/strong-noise/reference/reference.py': digest(SHARED),
        'scripts/research/strong-noise/reference/input-plan.json': digest(SHARED_PLAN),
        'scripts/research/strong-noise/reference/chroma-full.py': digest(PILOT_REFERENCE),
        'assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md': digest(POLICY),
        'scripts/research/strong-noise/comparison15.json': digest(COMPARISON),
        **{name: digest(ROOT / name) for name in (
            'scripts/research/detail-candidates.py', 'scripts/research/color-reference.py',
            'scripts/research/strong-noise/noise-scaled-patchwise.py',
            'scripts/research/strong-noise/chroma-pilot-pointwise.py',
            'scripts/research/strong-noise/patchwise.py',
            'scripts/research/strong-noise/pixelwise.py')},
    }


def input_plan(group):
    """Read recipes and build metadata; do not solve coefficients or evaluate pixels."""
    original = json.loads(SHARED_PLAN.read_text())
    core = ('signed-zero-identity', 'flat-gray', 'noise-like-low', 'signed-hdr',
            'one-pixel', 'one-axis', 'one-horizontal-axis', 'clamped-bias', 'clamped-zero-variance')
    alpha = ('hidden-zero-a', 'hidden-zero-b', 'partial-alpha', 'partial-alpha-common-scale',
             'noise-like-low', 'opaque-tiny-alpha', 'opaque-subnormal-alpha')
    names = core if group == 'core' else alpha if group == 'alpha' else ('noise-like-low',) if group == 'asymmetric' else tuple(c['id'] for c in original['cases'])
    controls = ([[1, 100], [100, 1], [25, 75], [75, 25], [50, 0], [0, 50]]
                if group == 'asymmetric' else [[a, 0 if group == 'identity' else a] for a in AMOUNTS])
    cases = [dict(c) for c in original['cases'] if c['id'] in names]
    marker = {'rgbaDecimal': ['0.25', '0.125', '0.0625', '1'],
              'rgba32Words': ['3e800000', '3e000000', '3d800000', '3f800000']}
    variance = ['0.000144', '0.0001', '0.000225']
    if group == 'core':
        cases.extend([
            {'id': 'wide-search-support', 'width': 25, 'height': 3, 'recipe': 'pattern-low',
             'frozenVariance': variance, 'points': [[0, 1], [12, 1], [24, 1]],
             'pixelOverrides': [{'x': 21, 'y': 1, **marker}]},
            {'id': 'matching-context-only', 'width': 29, 'height': 7, 'recipe': 'pattern-low',
             'frozenVariance': variance, 'points': [[12, 3]],
             'pixelOverrides': [{'x': 25, 'y': 3, **marker}]},
            {'id': 'full-target-context-halo14', 'width': 31, 'height': 9, 'recipe': 'pattern-low',
             'frozenVariance': variance, 'points': [[12, 4]],
             'pixelOverrides': [{'x': 26, 'y': 4, **marker}]},
            {'id': 'pilot-pointwise-context-halo24', 'width': 49, 'height': 9, 'recipe': 'pattern-low',
             'frozenVariance': variance, 'points': [[12, 4]],
             'pixelOverrides': [{'x': 36, 'y': 4, **marker}],
             'contextRequirement': 'Marker24 from owner: final guide neighbor+10, pilot gather center+2, pilot search+10 and matching tap+2. Outside prior halo23; inside declared24. Nonzero guide/stage/RGB counterfeit observability must still be demonstrated.'},
        ])
    if group == 'identity':
        cases = [{**c, 'points': []} for c in cases]
    publication = load('c15_plan_host_metadata', HOST).publication_vectors() if group == 'publication' else []
    if group == 'publication':
        cases, controls = [], []
    return {
        'referenceKind': KIND, 'candidateId': CANDIDATE_ID, 'group': group,
        'candidateImported': False, 'wordOracle': dict(WORD_ORACLE),
        'sourceBindings': source_bindings(),
        'primaries': original['primaries'], 'controls': controls, 'cases': cases,
        'configurations': len(publication) if publication else len(cases) * len(original['primaries']) * len(controls),
        'publicationVectors': publication,
        'baseLuminanceMaximum': BASE, 'baseChromaMaximum': BASE, 'chromaSigmaFactor': FACTOR,
        'aggregation': 'normalized-l9-patch-c1-owner-estimates-f32-zero-v1',
        'chromaSpatialPolicy': 'uniform-search-v1',
        'luminanceSearchRadius': 3, 'chromaSearchRadius': 10,
        'luminanceMatchingRadius': 1, 'chromaMatchingRadius': 0,
        'luminanceTargetRadius': 1, 'chromaTargetRadius': 0,
        'guidePolicy': 'fixed-c14-100-100-preinverse-feature-rn32-v1',
        'valuePolicy': 'original-features-only-v1',
        'chromaDistancePolicy': 'pointwise-pilot-l08-ab-sum-hc-no-bias-v1',
        'neighborAlphaPolicy': 'squared-visible-neighbor-v1',
        'guideScalars': 3, 'pilotStageScalars': 59,
        'pilotStageLayout': 'l9-row-major-c25-ab-row-major-v1',
        'stageScalars': 11, 'stageLayout': 'l9-row-major-c1-ab-owner-v1',
        'sourceHalo': {'luminance': 5, 'chroma': 24},
        'proposalBoundRadii': [3, 10, 10], 'limits': original['limits'],
        'pairChecks': [p for p in original['pairChecks'] if p['left'] in names and p['right'] in names]
                     if group != 'publication' else [],
        'pointPolicy': 'Independent source recipes and publication boundaries; identity group checks exact old C0 whole-grid state. Pilot fixed100/100 reused once per scene/primary across active controls.',
        'roundingPolicy': 'Host-F64 feature/ordered outer gather/division/addition and final point estimator; independent Decimal80 C14 E59 words and strict Decimal80 mathematical/RGB checks; no candidate intermediates used as truth.',
    }


def scene_types(shared, pilot_reference):
    full_type = pilot_reference.full_scene(shared)

    class PilotScene(full_type):
        # The fixed pilot is reused for every active user control, once per
        # scene/primary. Cache all declared source coordinates and stage words,
        # but retain C14's bounded direct-matching cache rather than all pairs.
        @lru_cache(maxsize=None)
        def coordinates(self, index):
            return super().coordinates(index)

        @lru_cache(maxsize=None)
        def center_stage(self, x, y, amount_l, amount_c, max_l, max_c):
            return super().center_stage(x, y, amount_l, amount_c, max_l, max_c)

    class OriginalLScene(shared.Scene):
        def __init__(self, spec, primary):
            super().__init__(spec, primary)
            for override in spec.get('pixelOverrides', []):
                x, y = override['x'], override['y']
                if not 0 <= x < self.width or not 0 <= y < self.height:
                    raise ValueError('Override is outside the declared source.')
                words = [int(word, 16) for word in override['rgba32Words']]
                if words != [shared.binary32_word(Decimal(value))
                             for value in override['rgbaDecimal']]:
                    raise ValueError('Override Decimal literals and binary32 words disagree.')
                self.words[y * self.width + x] = words
                self.pixels[y * self.width + x] = [Decimal.from_float(shared.word_value(word))
                                                  for word in words]

        @lru_cache(maxsize=None)
        def coordinates(self, index):
            return super().coordinates(index)

        @lru_cache(maxsize=None)
        def center_stage(self, x, y, amount_l, amount_c, max_l, max_c):
            return super().center_stage(x, y, amount_l, amount_c, max_l, max_c)

    return PilotScene, OriginalLScene


def decimal_point(shared, scene, old_scene, x, y, amount_l, amount_c, maximum,
                  guide, owner_words, host_raw_mean):
    D, Z, O = Decimal, shared.ZERO, shared.ONE
    old = old_scene.point(x, y, amount_l, 0, D(BASE), maximum)
    at = scene.index(x, y)
    original, original_words = scene.pixels[at], scene.words[at]
    if not original[3]:
        return {**old, 'idealNormalizedChromaDecimal80': ['0', '0'],
                'hostNormalizedChromaFloat64': [0.0, 0.0],
                'gentleFeatureBounds': old.get('gentleFeatureBounds', ['0', '0', '0']),
                'proposalBoundRadii': [3, 10, 10], 'localFeatureRanges': ['0', '0', '0'],
                'featureRangesRadius3': ['0', '0', '0']}
    luminance, scale, features = scene.coordinates(at)
    deltas = [D(old['proposedFeatureDelta'][0]),
              shared.blend(amount_c) * D.from_float(shared.word_value(owner_words[0])) if amount_c else Z,
              shared.blend(amount_c) * D.from_float(shared.word_value(owner_words[1])) if amount_c else Z]
    denominator, numerators = Z, [Z, Z]
    bandwidth = maximum * (D(amount_c) / 100) ** 2
    maxima, near_maxima = [Z, Z, Z], [Z, Z, Z]
    for dy in range(-10, 11):
        for dx in range(-10, 11):
            neighbor = scene.index(x + dx, y + dy)
            if not scene.pixels[neighbor][3]:
                continue
            other = scene.coordinates(neighbor)[2]
            for component in range(3):
                if abs(dx) <= 3 and abs(dy) <= 3:
                    near_maxima[component] = max(near_maxima[component], abs(other[component] - features[component]))
                if component or (abs(dx) <= 3 and abs(dy) <= 3):
                    maxima[component] = max(maxima[component], abs(other[component] - features[component]))
            if amount_c:
                g_left, g_right = ([D.from_float(value) for value in guide[index]]
                                   for index in (at, neighbor))
                dl = (g_left[0] - g_right[0]) ** 2
                dc = (g_left[1] - g_right[1]) ** 2 + (g_left[2] - g_right[2]) ** 2
                weight = scene.pixels[neighbor][3] ** 2 * shared.weight_exp(
                    -dl / D('.08') ** 2 - dc / bandwidth ** 2)
                denominator += weight
                for index, component in enumerate((1, 2)):
                    numerators[index] += weight * (other[component] - features[component])
    if amount_c and not denominator:
        raise ArithmeticError('Independent Decimal point lost positive normalization.')
    means = [value / denominator for value in numerators] if amount_c else [Z, Z]
    for host, exact in zip(host_raw_mean or (0.0, 0.0), means):
        if abs(D.from_float(host) - exact) > D('2e-12') + D('2e-11') * abs(exact):
            raise ArithmeticError('Host point graph disagrees with independent Decimal80 mathematics.')
    bounds = []
    for component in range(3):
        with localcontext() as bound_context:
            bound_context.rounding = shared.ROUND_CEILING
            bound = (shared.blend(amount_l if component == 0 else amount_c) *
                     (maxima[component] * (O + D(2) ** -24) + D(2) ** -150)
                     if maxima[component] else Z)
        if abs(deltas[component]) > bound:
            raise ArithmeticError('Independent proposal exceeds original-value local bound.')
        bounds.append(bound)
    change_y = shared.stable_difference(luminance, shared.K, deltas[0]) if amount_l else Z
    change_a = shared.stable_difference(original[0] - luminance, scale, deltas[1])
    change_b = shared.stable_difference(original[2] - luminance, scale, deltas[2])
    if not (change_y or change_a or change_b):
        output, words = original[:], original_words[:]
    else:
        output = [original[0] + change_y + change_a,
                  original[1] + change_y - (scene.y_coeff[0] * change_a +
                      scene.y_coeff[2] * change_b) / scene.y_coeff[1],
                  original[2] + change_y + change_b, original[3]]
        words = [shared.binary32_word(value) for value in output[:3]] + [original_words[3]]
    return {'x': x, 'y': y, 'identityCopy': not (change_y or change_a or change_b),
            'inputWords': [f'{word:08x}' for word in original_words],
            'outputWords': [f'{word:08x}' for word in words],
            'outputFloat64': [float(value) for value in output],
            'outputDecimal80': [str(value) for value in output],
            'proposedFeatureDelta': [str(value) for value in deltas],
            'gentleFeatureBounds': [str(value) for value in bounds],
            'proposalBoundRadii': [3, 10, 10],
            'idealNormalizedChromaDecimal80': [str(value) for value in means],
            'hostNormalizedChromaFloat64': host_raw_mean or [0.0, 0.0],
            'localFeatureRanges': [str(value) for value in maxima],
            'featureRangesRadius3': [str(value) for value in near_maxima]}


def generate(plan):
    shared = load('c15_independent_decimal', SHARED)
    host = load('c15_independent_host_graph', HOST)
    word_oracle = {**WORD_ORACLE, 'coefficientWords': {
        primary: [host.binary64_word(value) for value in
                  host.independently_rounded_coefficients(shared, primary)]
        for primary in plan['primaries']}}
    common = {'version': KIND, 'referenceKind': KIND, 'candidateId': CANDIDATE_ID,
              'candidateImported': False, 'group': plan['group'], 'precision': 80,
              'license': 'CC0-1.0', 'generatorSha256': digest(__file__),
              'hostAdapterSha256': digest(HOST), 'sharedGeneratorSha256': digest(SHARED),
              'sharedInputPlanSha256': digest(SHARED_PLAN), 'sourceBindings': source_bindings(),
              'planSha256': sha256(canonical(plan)).hexdigest(), 'plan': plan,
              'wordOracle': word_oracle, 'runtimeFingerprint': runtime_fingerprint(),
              'selection': {key: plan[key]
                  for key in ('primaries', 'controls', 'configurations')},
              **{key: value for key, value in plan.items() if key not in (
                  'referenceKind', 'candidateId', 'candidateImported', 'group', 'wordOracle',
                  'cases', 'controls', 'primaries', 'sourceBindings', 'publicationVectors')}}
    if plan['group'] == 'publication':
        rows = []
        for spec in plan['publicationVectors']:
            first, second, normalized = (float.fromhex(spec[key]) for key in
                                         ('featureHex', 'proposalHex', 'normalizedDeltaHex'))
            summed = first + second
            if host.binary64_word(summed) != host.binary64_word(normalized):
                raise ArithmeticError('Declared publication seam sum and normalized operand disagree.')
            # These fixed seam operands have binary denominators at most 2**150.
            # Precision250 contains their finite decimal expansions exactly;
            # this diagnostic ideal sum is distinct from the host sum contract.
            with localcontext() as seam_context:
                seam_context.prec = 250
                ideal_word = shared.binary32_word(Decimal.from_float(first) + Decimal.from_float(second))
            rows.append({**spec, 'guideWord': f'{host.binary32_word(summed):08x}',
                         'finalDeltaWord': f'{host.binary32_word(normalized, True):08x}',
                         'idealDecimalGuideWord': f'{ideal_word:08x}',
                         'sumFloat64Word': host.binary64_word(summed)})
        return {**common, 'publicationVectors': rows, 'scenes': []}
    pilot_reference = load('c15_independent_c14_direct', PILOT_REFERENCE)
    pilot_type, l_type = scene_types(shared, pilot_reference)
    scenes = []
    for spec in plan['cases']:
        primaries, scene_cases, source_bytes = [], [], None
        for primary in plan['primaries']:
            scene, old_scene = pilot_type(spec, primary), l_type(spec, primary)
            if scene.words != old_scene.words:
                raise ArithmeticError('Independent L/pilot source recipes disagree.')
            current_bytes = b''.join(struct.pack('<4I', *pixel) for pixel in scene.words)
            if source_bytes is not None and source_bytes != current_bytes:
                raise ArithmeticError('Primary selection changed source words.')
            source_bytes = current_bytes
            source = [list(pixel) for pixel in struct.iter_unpack('<4f', source_bytes)]
            alpha = [pixel[3] for pixel in source]
            coefficients = host.independently_rounded_coefficients(shared, primary)
            maximum = (Decimal(BASE) ** 2 + Decimal(FACTOR) ** 2 *
                       (scene.variance[1] + scene.variance[2])).sqrt()
            has_active_c = any(chroma for _, chroma in plan['controls'])
            pilot_words, guide, pilot_proposals, features = None, None, None, None
            if has_active_c:
                pilot_words = [scene.center_stage(x, y, 100, 100, Decimal(BASE), maximum)
                               for y in range(scene.height) for x in range(scene.width)]
                features = host.source_features(source, coefficients)
                guide, pilot_proposals = host.gather_guide(features, alpha, scene.width, scene.height,
                    lambda x, y: pilot_words[y * scene.width + x])
            cases = []
            for amount_l, amount_c in plan['controls']:
                e_words, raw_means = None, None
                if amount_c:
                    e_words, _, raw_means = host.owner_chroma(features, guide, alpha,
                        scene.width, scene.height, amount_c,
                        [float(value) for value in spec['frozenVariance']])
                points = [decimal_point(shared, scene, old_scene, x, y, amount_l,
                          amount_c, maximum, guide, e_words[y * scene.width + x] if amount_c else None,
                          raw_means[y * scene.width + x] if amount_c else None)
                          for x, y in spec['points']]
                original_l_words = []
                if amount_c:
                    for y in range(scene.height):
                        for x in range(scene.width):
                            words = old_scene.center_stage(x, y, amount_l, 0, Decimal(BASE), maximum)
                            original_l_words.append([words[index * 3] for index in range(9)])
                cases.append({'primaries': primary, 'luminance': amount_l, 'chroma': amount_c,
                              'points': points,
                              'finalStageWords': [[f'{word:08x}' for word in
                                  original_l_words[index] + list(e_words[index])]
                                  for index in range(len(source))] if amount_c else None})
            primaries.append({'primaries': primary, 'coefficientWords': word_oracle['coefficientWords'][primary],
                'pilotStageWords': [[f'{word:08x}' for word in stage] for stage in pilot_words]
                                  if has_active_c else None,
                'guideWords': [[f'{host.binary32_word(value):08x}' for value in pixel] for pixel in guide]
                              if has_active_c else None,
                'pilotFeatureProposalWords64': [[host.binary64_word(value) for value in pixel]
                                              for pixel in pilot_proposals] if has_active_c else None,
                })
            scene_cases.extend(cases)
            for obj in (scene, old_scene):
                obj.coordinates.cache_clear()
                obj.center_stage.cache_clear()
                obj.direct_patches.cache_clear()
            shared.Scene.coordinates.cache_clear()
            shared.Scene.center_stage.cache_clear()
        scenes.append({'id': spec['id'], 'width': spec['width'], 'height': spec['height'],
                       'frozenVariance': spec['frozenVariance'],
                       'inputRgba32leHex': source_bytes.hex(),
                       'sourceSha256': sha256(source_bytes).hexdigest(), 'primaries': primaries,
                       'cases': scene_cases})
    return {**common, 'scenes': scenes, 'publicationVectors': []}


def runtime_fingerprint():
    """Called only after numeric approval, never by artifact-free planning."""
    executable = Path(sys.executable).resolve(strict=True)
    extension = Path(math.__file__).resolve(strict=True) if getattr(math, '__file__', None) else None
    files, status = [], 'unavailable-platform'
    if sys.platform.startswith('linux'):
        maps = Path('/proc/self/maps')
        status = 'unavailable-process-maps'
        if maps.is_file():
            found = set()
            for line in maps.read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and fields[5].startswith('/'):
                    path = Path(fields[5])
                    if path.name.startswith('libm.so') and path.is_file():
                        found.add(path.resolve(strict=True))
            files = [{'path': str(path), 'sha256': digest(path)} for path in sorted(found)]
            status = 'identified' if files else 'unavailable-loaded-libm-not-identified'
    return {'scope': 'Pinned host operation graph; not a portable correctly-rounded libm theorem.',
            'platform': sys.platform,
            'python': {'path': str(executable), 'sha256': digest(executable), 'version': sys.version},
            'mathExtension': {'path': str(extension), 'sha256': digest(extension)} if extension else None,
            'loadedLibm': {'status': status, 'files': files}}


def compare(reference_path, candidate_path):
    reference = json.loads(reference_path.read_text())
    plan = input_plan(reference['group'])
    if (reference.get('referenceKind') != KIND or reference.get('candidateId') != CANDIDATE_ID
            or reference.get('plan') != plan or reference.get('candidateImported') is not False
            or reference.get('planSha256') != sha256(canonical(plan)).hexdigest()
            or reference.get('sourceBindings') != source_bindings()
            or reference.get('runtimeFingerprint') != runtime_fingerprint()):
        raise ValueError('Reference source/plan/runtime freeze changed.')
    approved_path = Path(reference['generationApprovalPath'])
    if digest(approved_path) != reference['approvalSha256']:
        raise ValueError('Reference generation approval bytes changed.')
    approval(plan, approved_path)
    shared = load('c15_checker_independent_decimal', SHARED)
    host = load('c15_checker_independent_host', HOST)
    model = load('c15_comparison_only_cpu_helpers', ROOT / 'scripts/research/detail-candidates.py')
    method = load('c15_comparison_only_candidate', candidate_path)
    legacy = load('c15_comparison_only_old_c9', ROOT / 'scripts/research/strong-noise/noise-scaled-patchwise.py')
    candidate_policy = json.loads(COMPARISON.read_text())['candidate']
    legacy_policy = {'id': 'noise-scaled-k40', 'aggregation': 'normalized-patch-estimates-f32-zero-v1',
                     'variance': 'frozen-global-directional-mad-v1', 'correction': 'both',
                     'adaptive': 'none', 'blend': 'quadratic-to-50-v1', 'selfPolicy': 'legacy',
                     'luminanceBandwidthMaximum': .024, 'chromaBandwidthMaximum': .024,
                     'chromaSigmaFactor': .4, 'bandwidthPolicy': 'global-chroma-sigma-floor-v1'}
    fields = ('preFinalRgbChannelsChecked', 'finalRgbChannelsChecked', 'exactCenterWordsChecked',
              'exactPilotCenterWordsChecked', 'exactGuideWordsChecked', 'exactPilotProposalWords64Checked',
              'allGridAlphaWordsChecked', 'allGridTransparentRgbaCopiesChecked',
              'allGridNeutralRgbaCopiesChecked', 'pairedRgbChannelsChecked',
              'pairedProposalWordsChecked', 'pairedCenterWordsChecked',
              'C0OldC9RgbaWordsChecked', 'C0OldC9ProposalWordsChecked', 'C0OldC9StageWordsChecked',
              'allLuminanceProposalWordsChecked', 'allLuminanceCenterWordsChecked',
              'nonzeroChromaLuminanceProposalWordsChecked', 'nonzeroChromaLuminanceCenterWordsChecked',
              'C0GuideAbsencesChecked', 'C0PilotAbsencesChecked', 'guidePublicationSeamsChecked',
              'finalPublicationSeamsChecked', 'chromaNormalizationSeamsChecked',
              'independentCoefficientWordsChecked')
    counts, failures, outputs = dict.fromkeys(fields, 0), [], {}
    coefficients = {}
    for primary in plan['primaries']:
        derived = host.independently_rounded_coefficients(shared, primary)
        words = [host.binary64_word(value) for value in derived]
        if words != reference['wordOracle']['coefficientWords'][primary]:
            raise ValueError('Independent generated coefficient words changed.')
        coefficients[primary] = words
        for actual, expected in zip(model.LUMINANCE[primary], words):
            counts['independentCoefficientWordsChecked'] += 1
            if host.binary64_word(actual) != expected:
                failures.append({'kind': 'independent-primary-coefficient-word', 'primary': primary})

    def fail(kind, context, **detail):
        failures.append({'kind': kind, **context, **detail})

    def published_grid(actual, expected, prefix, counter, context, canonical_delta):
        if not isinstance(actual, list) or len(actual) != len(expected):
            fail(prefix + '-publication-grid', context)
            return
        for index, (values, words) in enumerate(zip(actual, expected)):
            if not isinstance(values, (list, tuple)) or len(values) != len(words):
                fail(prefix + '-publication-shape', context, index=index)
                continue
            for slot, (value, word) in enumerate(zip(values, words)):
                try:
                    observed = host.require_published(value, canonical_delta)
                except (ValueError, OverflowError, TypeError) as error:
                    fail(prefix + '-publication-not-f32', context, index=index, slot=slot,
                         reason=str(error))
                    continue
                counts[counter] += 1
                if observed != int(word, 16):
                    fail(prefix + '-publication-word', context, index=index, slot=slot,
                         actual=f'{observed:08x}', expected=word)

    if plan['group'] == 'publication':
        if len(reference['publicationVectors']) != len(plan['publicationVectors']):
            raise ValueError('Publication seam selection changed.')
        for spec, row in zip(plan['publicationVectors'], reference['publicationVectors']):
            if any(row.get(key) != value for key, value in spec.items()):
                raise ValueError('Publication seam operands changed.')
            first, second, normalized = [float.fromhex(spec[key]) for key in
                                        ('featureHex', 'proposalHex', 'normalizedDeltaHex')]
            context = {'scene': 'publication', 'vector': spec['id']}
            for helper, args, expected, canonical_delta, counter, prefix in (
                (method.publish_guide_component, (model, first, second), row['guideWord'], False,
                 'guidePublicationSeamsChecked', 'guide'),
                (method.publish_delta_component, (model, normalized), row['finalDeltaWord'], True,
                 'finalPublicationSeamsChecked', 'center'),
                (method.publish_chroma_component, (model, normalized, 1.0), row['finalDeltaWord'], True,
                 'chromaNormalizationSeamsChecked', 'center')):
                published_grid([[helper(*args)]], [[expected]], prefix, counter, context, canonical_delta)
        configurations = len(plan['publicationVectors'])
    else:
        if [scene['id'] for scene in reference['scenes']] != [scene['id'] for scene in plan['cases']]:
            raise ValueError('Reference scene selection changed.')
        configurations = 0
        for spec, scene in zip(plan['cases'], reference['scenes']):
            if any(scene[key] != spec[key] for key in ('width', 'height', 'frozenVariance')):
                raise ValueError('Declared source geometry or variance changed.')
            source_bytes = bytes.fromhex(scene['inputRgba32leHex'])
            if sha256(source_bytes).hexdigest() != scene['sourceSha256']:
                raise ValueError('Reference source bytes changed.')
            source = [list(pixel) for pixel in struct.iter_unpack('<4f', source_bytes)]
            width, height = spec['width'], spec['height']
            if len(source) != width * height:
                raise ValueError('Incomplete reference source.')
            if [primary['primaries'] for primary in scene['primaries']] != plan['primaries']:
                raise ValueError('Primary selection changed.')
            outputs[spec['id']] = {}
            snapshot = {'version': 'frozen-global-directional-mad-v1',
                        'variance': [float(value) for value in scene['frozenVariance']]}
            for primary in scene['primaries']:
                name = primary['primaries']
                cases = [case for case in scene['cases'] if case['primaries'] == name]
                if [[case['luminance'], case['chroma']] for case in cases] != plan['controls']:
                    raise ValueError('Reference controls missing, added or reordered.')
                for case in cases:
                    amount_l, amount_c = case['luminance'], case['chroma']
                    context = {'scene': spec['id'], 'primary': name, 'controls': [amount_l, amount_c]}
                    filtered, diagnostics = method.denoise(model, source, width, height,
                        model.LUMINANCE[name], amount_l, amount_c, candidate_policy,
                        capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
                    old_output, old = legacy.denoise(model, source, width, height,
                        model.LUMINANCE[name], amount_l, 0, legacy_policy,
                        capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
                    configurations += 1
                    if len(filtered) != len(source):
                        fail('output-grid-length', context)
                        continue
                    actual_stage, old_stage = diagnostics.get('centerDeltas'), old.get('centerDeltas')
                    deltas, old_deltas = diagnostics.get('featureDeltas'), old.get('featureDeltas')
                    if not isinstance(deltas, list) or len(deltas) != len(source):
                        fail('feature-proposal-grid', context)
                        continue
                    for index, (actual, expected) in enumerate(zip(deltas, old_deltas)):
                        counts['allLuminanceProposalWordsChecked'] += 1
                        counts['nonzeroChromaLuminanceProposalWordsChecked'] += int(amount_c != 0)
                        if host.binary64_word(actual[0]) != host.binary64_word(expected[0]):
                            fail('old-C9-L-proposal-identity', context, index=index)
                    if old_stage is not None:
                        if actual_stage is None or len(actual_stage) != len(source):
                            fail('old-C9-L-stage-shape', context)
                        else:
                            for index, (actual, expected) in enumerate(zip(actual_stage, old_stage)):
                                for offset in range(9):
                                    counts['allLuminanceCenterWordsChecked'] += 1
                                    counts['nonzeroChromaLuminanceCenterWordsChecked'] += int(amount_c != 0)
                                    actual_slot = offset if amount_c else offset * 3
                                    if host.binary64_word(actual[actual_slot]) != host.binary64_word(expected[offset * 3]):
                                        fail('old-C9-L-stage-identity', context, index=index, offset=offset)
                    elif amount_c and isinstance(actual_stage, list):
                        for index, values in enumerate(actual_stage):
                            for value in values[:9]:
                                counts['allLuminanceCenterWordsChecked'] += 1
                                counts['nonzeroChromaLuminanceCenterWordsChecked'] += 1
                                if host.binary64_word(value) != '0000000000000000':
                                    fail('old-C9-disabled-L-stage-identity', context, index=index)
                    if amount_c:
                        for prefix, field, expected, counter, canonical_delta in (
                            ('pilot-center', 'pilotCenterDeltas', primary['pilotStageWords'], 'exactPilotCenterWordsChecked', True),
                            ('guide', 'guideFeatures', primary['guideWords'], 'exactGuideWordsChecked', False),
                            ('center', 'centerDeltas', case['finalStageWords'], 'exactCenterWordsChecked', True)):
                            published_grid(diagnostics.get(field), expected, prefix, counter, context, canonical_delta)
                        proposal = diagnostics.get('pilotFeatureDeltas')
                        expected = primary['pilotFeatureProposalWords64']
                        if not isinstance(proposal, list) or len(proposal) != len(expected):
                            fail('pilot-proposal-grid', context)
                        else:
                            for index, (actual, words) in enumerate(zip(proposal, expected)):
                                for component, word in enumerate(words):
                                    counts['exactPilotProposalWords64Checked'] += 1
                                    if host.binary64_word(actual[component]) != word:
                                        fail('pilot-feature-proposal-word64', context, index=index, component=component)
                        metadata = {'activeFinalStageScalars': 11, 'activeFinalStageLayout': plan['stageLayout'],
                            'pilotStageScalars': 59, 'pilotStageLayout': plan['pilotStageLayout'],
                            'guideScalars': 3, 'pilotConstructed': True,
                            **{key: plan[key] for key in ('sourceHalo', 'proposalBoundRadii',
                                'guidePolicy', 'chromaDistancePolicy', 'valuePolicy', 'neighborAlphaPolicy')}}
                        if any(diagnostics.get(key) != value for key, value in metadata.items()):
                            fail('active-publication-metadata', context)
                        if diagnostics.get('estimator') != snapshot:
                            fail('original-frozen-variance-descriptor', context)
                    else:
                        counts['C0GuideAbsencesChecked'] += 1
                        counts['C0PilotAbsencesChecked'] += 1
                        if diagnostics.get('pilotConstructed') is not False or any(key in diagnostics
                                for key in ('pilotCenterDeltas', 'pilotFeatureDeltas', 'guideFeatures')):
                            fail('C0-unexpected-pilot-or-guide', context)
                        if (actual_stage is None) != (old_stage is None):
                            fail('C0-stage-presence', context)
                        if old_stage is not None:
                            expected_words = [[f'{host.binary32_word(value):08x}' for value in row] for row in old_stage]
                            published_grid(actual_stage, expected_words, 'old-C9', 'C0OldC9StageWordsChecked', context, True)
                        for index, (actual, expected) in enumerate(zip(deltas, old_deltas)):
                            for component in range(3):
                                counts['C0OldC9ProposalWordsChecked'] += 1
                                if host.binary64_word(actual[component]) != host.binary64_word(expected[component]):
                                    fail('old-C9-C0-proposal-identity', context, index=index, component=component)
                    for index, (pixel, original) in enumerate(zip(filtered, source)):
                        try:
                            words = [host.require_published(value) for value in pixel]
                        except (ValueError, TypeError, OverflowError) as error:
                            fail('final-publication-not-f32', context, index=index, reason=str(error))
                            continue
                        original_words = [host.binary32_word(value) for value in original]
                        counts['allGridAlphaWordsChecked'] += 1
                        if words[3] != original_words[3]:
                            fail('alpha-word', context, index=index)
                        if not original[3] or (not amount_l and not amount_c):
                            field = 'allGridTransparentRgbaCopiesChecked' if not original[3] else 'allGridNeutralRgbaCopiesChecked'
                            counts[field] += 4
                            if words != original_words:
                                fail('transparent-or-neutral-copy', context, index=index)
                        if not amount_c:
                            counts['C0OldC9RgbaWordsChecked'] += 4
                            if words != [host.binary32_word(value) for value in old_output[index]]:
                                fail('old-C9-C0-rgba-identity', context, index=index)
                    unrounded = diagnostics.get('outputFloat64', filtered)
                    if (amount_l or amount_c) and ('outputFloat64' not in diagnostics
                            or len(unrounded) != len(source)):
                        fail('missing-pre-final-rgb-evidence', context)
                    if len(case['points']) != len(spec['points']):
                        raise ValueError('Reference selected point count changed.')
                    for point, selected in zip(case['points'], spec['points']):
                        if [point['x'], point['y']] != selected:
                            raise ValueError('Reference selected points changed.')
                        index = point['y'] * width + point['x']
                        if point['proposalBoundRadii'] != [3, 10, 10]:
                            raise ValueError('Reference proposal support changed.')
                        for component, bound in enumerate(point['gentleFeatureBounds']):
                            proposal = deltas[index][component]
                            if not math.isfinite(proposal) or abs(Decimal.from_float(proposal)) > Decimal(bound):
                                fail('gentle-feature-bound', context, point=selected, component=component)
                        for component in range(3):
                            actual, exact = unrounded[index][component], Decimal(point['outputDecimal80'][component])
                            counts['preFinalRgbChannelsChecked'] += 1
                            if not math.isfinite(actual) or abs(Decimal.from_float(actual) - exact) > Decimal('2e-12') + Decimal('2e-11') * abs(exact):
                                fail('strict-pre-final-rgb', context, point=selected, component=component)
                            actual32 = filtered[index][component]
                            counts['finalRgbChannelsChecked'] += 1
                            if not math.isfinite(actual32) or abs(Decimal.from_float(actual32) - exact) > Decimal('2e-6') + Decimal('2e-5') * abs(exact):
                                fail('final-rgb', context, point=selected, component=component)
                    outputs[spec['id']][(name, amount_l, amount_c)] = (filtered, deltas, actual_stage, source)
        for pair in plan['pairChecks']:
            left, right = outputs[pair['left']], outputs[pair['right']]
            for key, (pixels, deltas, stages, source) in left.items():
                other_pixels, other_deltas, other_stages, _ = right[key]
                for index, original in enumerate(source):
                    if not original[3]:
                        continue
                    for component in range(3):
                        counts['pairedRgbChannelsChecked'] += 1
                        counts['pairedProposalWordsChecked'] += 1
                        if host.binary64_word(pixels[index][component]) != host.binary64_word(other_pixels[index][component]):
                            fail('paired-rgb', {'scene': pair['left'], 'other': pair['right'], 'configuration': key}, index=index)
                        if host.binary64_word(deltas[index][component]) != host.binary64_word(other_deltas[index][component]):
                            fail('paired-proposal', {'scene': pair['left'], 'other': pair['right'], 'configuration': key}, index=index)
                    if stages is not None:
                        for actual, expected in zip(stages[index], other_stages[index]):
                            counts['pairedCenterWordsChecked'] += 1
                            if host.binary64_word(actual) != host.binary64_word(expected):
                                fail('paired-stage', {'scene': pair['left'], 'other': pair['right'], 'configuration': key}, index=index)
    if configurations != plan['configurations']:
        raise ValueError('Missing or additional numerical configurations.')
    return {'status': 'failed' if failures else 'passed', 'referenceKind': KIND,
            'candidateId': CANDIDATE_ID, 'group': plan['group'], 'configurations': configurations,
            'generatorSha256': digest(__file__), 'candidateSha256': digest(candidate_path),
            'planSha256': reference['planSha256'], 'sourceBindings': source_bindings(),
            'referenceSha256': digest(reference_path), 'wordOracle': reference['wordOracle'],
            'runtimeFingerprint': reference['runtimeFingerprint'],
            'coefficientWordsAgreed': not any(row['kind'] == 'independent-primary-coefficient-word' for row in failures),
            **counts, 'failures': failures,
            'scope': 'Small independent Decimal80 and pinned host-F64 publication vectors only; no photographic, GPU, resource or application adoption.'}


def approval(plan, path):
    approved = json.loads(Path(path).read_text())
    expected = {'referenceGenerationApproved': True, 'referenceKind': KIND,
                'generatorSha256': digest(__file__), 'sourceBindings': source_bindings(),
                'sharedGeneratorSha256': digest(SHARED), 'sharedInputPlanSha256': digest(SHARED_PLAN),
                'planSha256': sha256(canonical(plan)).hexdigest(), 'group': plan['group'],
                'candidateSha256': digest(ROOT / 'scripts/research/strong-noise/chroma-pilot-pointwise.py'),
                'wordOracle': {key: value for key, value in WORD_ORACLE.items() if key != 'coefficientWords'}}
    if any(approved.get(key) != value for key, value in expected.items()):
        raise ValueError('Numerical execution is missing exact reviewed source/plan approval.')
    requested = approved.get('groups', {}).get(plan['group'])
    if requested != {'planSha256': expected['planSha256'], 'configurations': plan['configurations']}:
        raise ValueError('Requested numerical group has no exact approval; another group does not authorize it.')
    return approved


def publish(path, result):
    path = path.resolve()
    if not path.is_relative_to(ROOT / 'artifacts') or path.exists():
        raise ValueError('Choose a fresh output file under ignored artifacts/.')
    with path.open('x') as stream:
        stream.write(json.dumps(result, indent=2, allow_nan=False) + '\n')


def main():
    parser = ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true')
    mode.add_argument('--generate', action='store_true')
    mode.add_argument('--check', type=Path)
    parser.add_argument('--group', choices=GROUPS)
    parser.add_argument('--approved-freeze', type=Path)
    parser.add_argument('--candidate', type=Path,
                        default=ROOT / 'scripts/research/strong-noise/chroma-pilot-pointwise.py')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.plan or args.generate:
        if args.group is None:
            parser.error('--plan/--generate require an explicit group.')
        plan = input_plan(args.group)
        if args.plan:
            if args.output is not None:
                parser.error('--plan does not create artifacts.')
            print(json.dumps({**plan, 'planSha256': sha256(canonical(plan)).hexdigest()}))
            return
        if args.approved_freeze is None:
            parser.error('--generate requires exact group-specific --approved-freeze.')
        approval(plan, args.approved_freeze)
    if args.output is None:
        parser.error('Choose a fresh --output under artifacts/.')
    with localcontext() as context:
        context.prec = 80
        result = generate(plan) if args.generate else compare(args.check, args.candidate)
    if args.generate:
        result['approvalSha256'] = digest(args.approved_freeze)
        result['generationApprovalPath'] = str(args.approved_freeze.resolve())
    publish(args.output, result)
    print(json.dumps({'status': result.get('status', 'reference-created'),
                      'output': str(args.output.resolve()), 'sha256': digest(args.output)}))
    if result.get('status') == 'failed':
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exit1 is reserved for a fully written structured numeric comparison
        # with status=failed. Missing approval/runtime/source or an unresolved
        # reference calculation is incomplete execution, never a counterfeit.
        print(f'C15 reference validation/execution error: {type(error).__name__}: {error}',
              file=sys.stderr)
        raise SystemExit(2) from error
