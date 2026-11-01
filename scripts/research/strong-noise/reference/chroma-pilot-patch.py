#!/usr/bin/env python3
"""CC0-1.0 C16 independent Decimal80 / host-F64 patch reference source draft.

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

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
ROOT = Path.cwd().resolve()
SHARED = ROOT / 'scripts/research/strong-noise/reference/reference.py'
SHARED_PLAN = ROOT / 'scripts/research/strong-noise/reference/input-plan.json'
PILOT_REFERENCE = ROOT / 'scripts/research/strong-noise/reference/chroma-full.py'
HOST = HERE / 'pilot-patch-host-f64.py'
POLICY = ROOT / 'assets/tests/references/detail/strong-noise/chroma-pilot-patch.md'
COMPARISON = ROOT / 'scripts/research/strong-noise/comparison16.json'
KIND = 'chroma-pilot-patch-decimal80-host-f64-v1'
PRIOR_KIND = 'chroma-pilot-pointwise-decimal80-host-f64-v1'
CANDIDATE_ID = 'noise-scaled-k40-c14-pilot-match5-owner-r10'
GROUPS = ('core', 'alpha', 'asymmetric', 'identity', 'publication')
AMOUNTS = (0, 1, 25, 50, 75, 100)
NUMERIC_FAILURES = frozenset(('pilot-center-publication-word', 'guide-publication-word',
    'center-publication-word', 'pilot-publication-not-f32', 'pilot-center-publication-not-f32',
    'guide-publication-not-f32', 'center-publication-not-f32', 'final-publication-not-f32',
    'strict-pre-final-rgb', 'final-rgb'))
COUNTERFEIT_GROUPS = {name: ('alpha' if name in ('linear-alpha', 'capped-self') else 'core')
    for name in ('raw-source-guide', 'guide-values-instead-of-original', 'unpublished-pilot',
                 'unpublished-guide', 'rgb-roundtrip-guide', 'short-halo23', 'linear-alpha', 'capped-self')}
COUNTERFEIT_SCENES = {
    'raw-source-guide': ('core', 'signed-zero-identity'),
    'unpublished-guide': ('core', 'flat-gray'),
    'guide-values-instead-of-original': ('core', 'noise-like-low'),
    'unpublished-pilot': ('core', 'noise-like-low'),
    'rgb-roundtrip-guide': ('core', 'noise-like-low'),
    'wrong-pointwise-final-metric': ('core', 'noise-like-low'),
    'capped-self': ('alpha', 'noise-like-low'),
    'short-halo23': ('core', 'pilot-pointwise-context-halo24'),
    'halo25-insufficient-for26': ('core', 'pilot-patch-context-halo26'),
    'shift-before-center-clamp': ('core', 'clamped-bias'),
    'linear-alpha': ('alpha', 'partial-alpha'),
    'uniform-visible-matching-q': ('alpha', 'partial-alpha'),
}
COMPLETE_TARGET_TITLES = (
    'independent pilot guidance preserves original values and rejects wrong guidance, publication and halo',
    'pilot guidance preserves hidden and common-scaled alpha state with squared neighbor weights and uncapped self',
    'pilot pointwise reference preserves asymmetric controls and unchanged strict RGB limits',
    'C zero preserves exact old C9 words, physical stage presence and absence of pilot and guide',
    'declared Float64 addition then guide RN32 and canonical delta publication retain tie and zero semantics')
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


def manifest():
    return json.loads(COMPARISON.read_text())


def bound_json(record):
    path = ROOT / record['path']
    payload = path.read_bytes()
    if sha256(payload).hexdigest() != record['sha256']:
        raise ValueError('Bound provenance bytes changed: ' + record['path'])
    return json.loads(payload)


def source_bindings():
    # Prior sources are immutable components, not files rewritten for C16.
    prior = manifest()['priorMathProof']['sourceBindings']
    for path, expected in prior.items():
        if digest(ROOT / path) != expected:
            raise ValueError('Immutable C15 component changed: ' + path)
    return {**prior, **{path: digest(ROOT / path) for path in (
        'scripts/research/strong-noise/reference/chroma-pilot-patch.py',
        'scripts/research/strong-noise/reference/pilot-patch-host-f64.py',
        'scripts/research/strong-noise/chroma-pilot-patch.py',
        'tests/strong-noise-chroma-pilot-patch.spec.ts',
        'assets/tests/references/detail/strong-noise/chroma-pilot-patch.md',
        'scripts/research/strong-noise/comparison16.json')}}


def reuse_policy():
    prior = manifest()['priorMathProof']
    return {'version': 'independent-c15-prefix-exact-binding-v1',
            'priorReferenceKind': PRIOR_KIND, 'priorLogicalConfigurations': 447,
            'requiredProofGroups': list(GROUPS),
            'priorSourceBindings': prior['sourceBindings'],
            'approval': prior['approval'], 'testSource': prior['testSource'],
            'completeVerification': prior['completeVerification'],
            'counterfeitEvidence': prior['counterfeitEvidence'],
            'groups': prior['groups'],
            'inputKeyFields': ['complete-original-rgba32-including-alpha-and-zero-signs',
                'dimensions', 'primaries', 'coefficient-words64', 'frozen-variance-words64',
                'component-source-bindings13', 'python-math-loaded-libm-fingerprint'],
            'candidateIntermediateInputs': False, 'oldFinalSuffixReused': False,
            'newPrefixPolicy': 'Independent Decimal80 C14 E59 plus host-F64 gather; separately approved execution only.'}


def input_plan(group):
    """Read bound prior metadata only; no features, coefficients or filtering."""
    if group not in GROUPS:
        raise ValueError('Unknown explicit reference group.')
    old = bound_json(manifest()['priorMathProof']['groups'][group]['reference'])
    prior = old['plan']
    if prior['referenceKind'] != PRIOR_KIND or prior['group'] != group:
        raise ValueError('Prior independent plan identity changed.')
    plan = json.loads(json.dumps(prior))
    plan.update({'referenceKind': KIND, 'candidateId': CANDIDATE_ID,
        'sourceBindings': source_bindings(), 'wordOracle': dict(WORD_ORACLE),
        'chromaMatchingRadius': 2,
        'chromaDistancePolicy': 'patch5-pilot-l08-ab-sum-qnormalized-hc-no-bias-v1',
        'matchingAlphaPolicy': 'product-visible-matching-pair-v1',
        'sourceHalo': {'luminance': 5, 'chroma': 26},
        'guideQueryRadius': 12, 'pilotLuminanceGuideDependencyRadius': 17,
        'combinedMaximumSharpeningHalo': 35,
        'prefixReuse': reuse_policy(),
        'baselineConfigurations': prior['configurations'],
        'pointPolicy': 'Retain every C15 configuration/selected point; new halo26 owner and actual wrong-point/clamp/q metric witnesses require separate numerical observability.',
        'roundingPolicy': 'Unchanged bound independent C15 pilot/L prefixes; independently authored host-F64 direct5x5 patch final graph and separate Decimal80 final mathematics/RGB/bounds; no candidate intermediate truth.'})
    if group == 'core':
        plan['cases'].append({'id': 'pilot-patch-context-halo26', 'width': 53, 'height': 9,
            'recipe': 'pattern-low', 'frozenVariance': ['0.000144', '0.0001', '0.000225'],
            'points': [[12, 4]], 'pixelOverrides': [{'x': 38, 'y': 4,
                'rgbaDecimal': ['0.25', '0.125', '0.0625', '1'],
                'rgba32Words': ['3e800000', '3e000000', '3d800000', '3f800000']}],
            'contextRequirement': 'Marker26 from owner: final neighbor10+matching2+pilot gather2+pilot search10+pilot matching2. Actual numeric visibility remains unresolved until approved evaluation.'})
    witnesses = [
        {'id': 'halo26', 'scene': 'pilot-patch-context-halo26', 'point': [12, 4],
         'counterfeit': 'halo25-insufficient-for26'},
        {'id': 'patch-versus-point', 'scene': 'noise-like-low', 'point': [3, 2],
         'counterfeit': 'wrong-pointwise-final-metric'},
        {'id': 'center-first-clamp', 'scene': 'clamped-bias', 'point': [0, 0],
         'counterfeit': 'shift-before-center-clamp'},
        {'id': 'nonuniform-matching-q', 'scene': 'partial-alpha', 'point': [3, 2],
         'counterfeit': 'uniform-visible-matching-q'}]
    plan['requiredNumericWitnesses'] = (witnesses[:3] if group == 'core' else
                                        witnesses[3:] if group == 'alpha' else [])
    plan['counterfeitScopes'] = {name: {'group': group, 'selectedScenes': [scene],
        'configurations': len(plan['primaries']) * len(plan['controls']),
        'primaries': 'all-declared', 'controls': 'all-declared', 'selectedPoints': 'all-declared'}
        for name, (owner_group, scene) in COUNTERFEIT_SCENES.items() if owner_group == group}
    if any(not set(scope['selectedScenes']).issubset({case['id'] for case in plan['cases']})
           for scope in plan['counterfeitScopes'].values()):
        raise ValueError('Declared negative witness scene is absent from its full plan.')
    plan['configurations'] = (len(plan['publicationVectors']) if group == 'publication' else
        len(plan['cases']) * len(plan['primaries']) * len(plan['controls']))
    return plan


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


class IndependentPrefixStore:
    """Only immutable independent references may supply unchanged prefix words.

    Validate all five original proofs before indexing any prefix. No candidate
    module is loaded here. Exact source bytes and host identities are part of
    each lookup; scene names alone are never sufficient cache keys.
    """
    def __init__(self, runtime):
        self.runtime = runtime
        self.policy = reuse_policy()
        prior = manifest()['priorMathProof']
        original_sources = prior['sourceBindings']
        if len(original_sources) != 13:
            raise ValueError('Expected all thirteen immutable C15 math bindings.')
        for path, expected in original_sources.items():
            if digest(ROOT / path) != expected:
                raise ValueError('Independent prefix source changed: ' + path)
        root_approval = bound_json(prior['approval'])
        if digest(ROOT / prior['testSource']['path']) != prior['testSource']['sha256']:
            raise ValueError('Original composed proof test source changed.')
        if (root_approval.get('referenceGenerationApproved') is not True or
                root_approval.get('referenceKind') != PRIOR_KIND or
                root_approval.get('sourceBindings') != original_sources or
                root_approval.get('candidateSha256') != prior['candidateSource']['sha256']):
            raise ValueError('Original complete mathematical approval changed.')
        if set(prior['groups']) != set(GROUPS):
            raise ValueError('Prefix reuse requires all five original proof groups.')
        self.references = {}
        self.artifacts = [prior['approval'], prior['testSource']]
        configurations = 0
        for group in GROUPS:
            record = prior['groups'][group]
            reference = bound_json(record['reference'])
            comparison = bound_json(record['comparison'])
            approved = bound_json(record['generationApproval'])
            self.artifacts.extend(record[name] for name in
                                  ('reference', 'comparison', 'generationApproval'))
            expected_group = {'planSha256': record['planSha256'],
                              'configurations': record['configurations']}
            if root_approval.get('groups', {}).get(group) != expected_group:
                raise ValueError('Original full approval lost a required group.')
            if (reference.get('referenceKind') != PRIOR_KIND or reference.get('group') != group
                    or reference.get('candidateImported') is not False
                    or reference.get('sourceBindings') != original_sources
                    or reference.get('runtimeFingerprint') != runtime
                    or reference.get('planSha256') != record['planSha256']
                    or sha256(canonical(reference['plan'])).hexdigest() != record['planSha256']
                    or reference.get('approvalSha256') != record['generationApproval']['sha256']
                    or reference['plan']['configurations'] != record['configurations']
                    or reference.get('generatorSha256') != original_sources[
                        'scripts/research/strong-noise/reference/chroma-pilot.py']
                    or reference.get('hostAdapterSha256') != original_sources[
                        'scripts/research/strong-noise/reference/pilot-host-f64.py']
                    or {key: value for key, value in reference['wordOracle'].items()
                        if key != 'coefficientWords'} != root_approval['wordOracle']):
                raise ValueError('Original independent reference binding changed: ' + group)
            if (comparison.get('status') != 'passed' or comparison.get('failures') != []
                    or comparison.get('referenceKind') != PRIOR_KIND
                    or comparison.get('group') != group
                    or comparison.get('configurations') != record['configurations']
                    or comparison.get('sourceBindings') != original_sources
                    or comparison.get('runtimeFingerprint') != runtime
                    or comparison.get('referenceSha256') != record['reference']['sha256']
                    or comparison.get('planSha256') != record['planSha256']
                    or comparison.get('candidateSha256') != prior['candidateSource']['sha256']
                    or comparison.get('coefficientWordsAgreed') is not True
                    or comparison.get('wordOracle') != reference['wordOracle']
                    or comparison.get('generatorSha256') != original_sources[
                        'scripts/research/strong-noise/reference/chroma-pilot.py']):
                raise ValueError('Original complete comparison did not pass unchanged: ' + group)
            if (approved.get('referenceGenerationApproved') is not True
                    or approved.get('referenceKind') != PRIOR_KIND
                    or approved.get('sourceBindings') != original_sources
                    or approved.get('group') != group
                    or approved.get('planSha256') != record['planSha256']
                    or approved.get('groups', {}).get(group) != expected_group
                    or approved.get('candidateSha256') != prior['candidateSource']['sha256']):
                raise ValueError('Original group-specific generation approval changed: ' + group)
            configurations += record['configurations']
            self.references[group] = reference
        if configurations != 447:
            raise ValueError('Incomplete original 447-configuration prefix proof.')
        self.validate_complete_proof(prior, original_sources)
        self.reused, self.generated, self.reused_l, self.generated_l = set(), set(), set(), set()

    def validate_complete_proof(self, prior, original_sources):
        complete = bound_json(prior['completeVerification'])
        self.artifacts.append(prior['completeVerification'])
        if (complete.get('status') != 'passed' or complete.get('exitCode') != 0
                or complete.get('passed') != 876 or any(complete.get(key) != 0 for key in
                    ('failed', 'skipped', 'interrupted'))
                or complete.get('plan', {}).get('requestedTargets') != ['strong-noise-chroma-pilot']):
            raise ValueError('Original registered proof did not complete without failures/skips.')
        outcomes = [row for row in complete.get('tests', []) if row.get('target') == 'strong-noise-chroma-pilot']
        if (len(outcomes) != 5 or sorted(row.get('title', '') for row in outcomes) != sorted(COMPLETE_TARGET_TITLES)
                or any(row.get('status') != 'passed' or row.get('errors') != []
                    or row.get('file') != 'tests/strong-noise-chroma-pilot.spec.ts'
                    or row.get('definitionFile') != 'tests/strong-noise-chroma-pilot.spec.ts'
                    for row in outcomes)):
            raise ValueError('Missing or incomplete original five registered target outcomes.')
        if set(prior['counterfeitEvidence']) != set(COUNTERFEIT_GROUPS) or set(prior['requiredCounterfeits']) != set(COUNTERFEIT_GROUPS):
            raise ValueError('Prefix reuse requires all eight original meaningful counterfeits.')
        for name, expected_group in COUNTERFEIT_GROUPS.items():
            record = prior['counterfeitEvidence'][name]
            failure = bound_json(record['comparison'])
            if digest(ROOT / record['candidate']['path']) != record['candidate']['sha256']:
                raise ValueError('Original counterfeit candidate bytes changed: ' + name)
            self.artifacts.extend((record['comparison'], record['candidate']))
            reference = self.references[expected_group]
            group_proof = prior['groups'][expected_group]
            if (record['group'] != expected_group or failure.get('status') != 'failed'
                    or failure.get('referenceKind') != PRIOR_KIND
                    or failure.get('group') != expected_group
                    or failure.get('configurations') != group_proof['configurations']
                    or failure.get('sourceBindings') != original_sources
                    or failure.get('runtimeFingerprint') != self.runtime
                    or failure.get('referenceSha256') != group_proof['reference']['sha256']
                    or failure.get('planSha256') != group_proof['planSha256']
                    or failure.get('generatorSha256') != original_sources[
                        'scripts/research/strong-noise/reference/chroma-pilot.py']
                    or failure.get('candidateSha256') != record['candidate']['sha256']
                    or failure.get('wordOracle') != reference['wordOracle']
                    or failure.get('coefficientWordsAgreed') is not True
                    or not any(row.get('kind') in NUMERIC_FAILURES for row in failure.get('failures', []))):
                raise ValueError('Original counterfeit lacks a bound actual numeric failure: ' + name)
            if name == 'short-halo23' and not any(
                    row.get('kind') in ('strict-pre-final-rgb', 'final-rgb')
                    and row.get('scene') == 'pilot-pointwise-context-halo24'
                    and row.get('point') == [12, 4] for row in failure['failures']):
                raise ValueError('Original halo24 claim lacks selected-owner strict RGB evidence.')

    def matches(self, spec, primary, source_bytes, coefficients, host):
        """Validate full identity before exposing any independent stored words."""
        result = []
        for group, reference in self.references.items():
            for scene, declared in zip(reference['scenes'], reference['plan']['cases']):
                if scene['id'] != spec['id']:
                    continue
                expected = {key: value for key, value in spec.items() if key != 'points'}
                actual = {key: value for key, value in declared.items() if key != 'points'}
                if actual != expected:
                    raise ValueError('Scene recipe changed under a retained prefix identity.')
                if (scene['width'] != spec['width'] or scene['height'] != spec['height']
                        or scene['frozenVariance'] != spec['frozenVariance']
                        or bytes.fromhex(scene['inputRgba32leHex']) != source_bytes
                        or scene['sourceSha256'] != sha256(source_bytes).hexdigest()):
                    raise ValueError('Original RGBA/geometry/variance prefix key differs.')
                original_variance = [host.binary64_word(float(value)) for value in scene['frozenVariance']]
                if original_variance != [host.binary64_word(float(value)) for value in spec['frozenVariance']]:
                    raise ValueError('Frozen variance words differ.')
                records = [row for row in scene['primaries'] if row['primaries'] == primary]
                if len(records) != 1:
                    raise ValueError('Independent prefix primary is missing or repeated.')
                record = records[0]
                words = [host.binary64_word(value) for value in coefficients]
                if record['coefficientWords'] != words or reference['wordOracle']['coefficientWords'][primary] != words:
                    raise ValueError('Independent coefficient words differ from prefix key.')
                result.append((group, scene, record))
        return result

    def pilot(self, matches, spec, primary, host):
        usable = [(group, scene, record) for group, scene, record in matches
                  if record['pilotStageWords'] is not None]
        if not usable:
            return None
        baseline = usable[0][2]
        for _, _, record in usable[1:]:
            if any(record[key] != baseline[key] for key in
                   ('pilotStageWords', 'pilotFeatureProposalWords64', 'guideWords')):
                raise ValueError('Original independent groups disagree on a fixed prefix.')
        count = spec['width'] * spec['height']
        if any(len(baseline[key]) != count for key in
               ('pilotStageWords', 'pilotFeatureProposalWords64', 'guideWords')):
            raise ValueError('Incomplete independent all-grid prefix.')
        self.reused.add((spec['id'], primary))
        stage = [[int(word, 16) for word in row] for row in baseline['pilotStageWords']]
        proposals = [[struct.unpack('>d', bytes.fromhex(word))[0] for word in row]
                     for row in baseline['pilotFeatureProposalWords64']]
        guide = [[host.word_value(int(word, 16)) for word in row] for row in baseline['guideWords']]
        if any(len(row) != 59 for row in stage) or any(len(row) != 3 for row in proposals + guide):
            raise ValueError('Independent prefix publication shape changed.')
        return stage, proposals, guide

    def luminance(self, matches, spec, primary, amount):
        if amount == 0:
            return [[0] * 9 for _ in range(spec['width'] * spec['height'])]
        candidates = []
        for _, scene, _ in matches:
            for case in scene['cases']:
                if case['primaries'] == primary and case['luminance'] == amount and case['chroma']:
                    candidates.append([row[:9] for row in case['finalStageWords']])
        if not candidates:
            return None
        if any(value != candidates[0] for value in candidates[1:]):
            raise ValueError('Independent groups disagree on unchanged user-L9.')
        self.reused_l.add((spec['id'], primary, amount))
        return [[int(word, 16) for word in row] for row in candidates[0]]

    def evidence(self):
        return {'version': self.policy['version'], 'proofGroupsValidated': 5,
                'logicalConfigurationsValidated': 447, 'sourceBindings13Validated': 13,
                'counterfeitProofsValidated': 8, 'completeTargetOutcomesValidated': 5,
                'registeredVerificationPassed': 876,
                'runtimeFingerprintSha256': sha256(canonical(self.runtime)).hexdigest(),
                'artifactsValidated': self.artifacts,
                'reusedScenePrimaries': len(self.reused),
                'generatedScenePrimaries': len(self.generated),
                'reusedLuminanceStageGrids': len(self.reused_l),
                'generatedLuminanceStageGrids': len(self.generated_l),
                'candidateIntermediateInputs': False, 'oldFinalSuffixReused': False}


def decimal_luminance(shared, scene, x, y, amount, words):
    if amount == 0 or scene.pixels[scene.index(x, y)][3] == 0:
        return shared.ZERO
    total, numerator = shared.ZERO, shared.ZERO
    for ry in range(-1, 2):
        for rx in range(-1, 2):
            cx, cy = x - rx, y - ry
            if not 0 <= cx < scene.width or not 0 <= cy < scene.height:
                continue
            center = cy * scene.width + cx
            alpha = scene.pixels[center][3]
            if not alpha:
                continue
            total += alpha
            numerator += alpha * Decimal.from_float(shared.word_value(words[center][(ry + 1) * 3 + rx + 1]))
    if not total:
        raise ArithmeticError('Independent Decimal user-L lost positive coverage.')
    return shared.blend(amount) * numerator / total


def decimal_point(shared, scene, x, y, amount_l, amount_c, maximum,
                  guide, owner_words, host_raw_mean, luminance_words):
    D, Z, O = Decimal, shared.ZERO, shared.ONE
    at = scene.index(x, y)
    original, original_words = scene.pixels[at], scene.words[at]
    if not original[3]:
        return {'x': x, 'y': y, 'identityCopy': True,
                'inputWords': [f'{word:08x}' for word in original_words],
                'outputWords': [f'{word:08x}' for word in original_words],
                'outputFloat64': [float(value) for value in original],
                'outputDecimal80': [str(value) for value in original],
                'proposedFeatureDelta': ['0', '0', '0'],
                'idealNormalizedChromaDecimal80': ['0', '0'],
                'hostNormalizedChromaFloat64': [0.0, 0.0],
                'gentleFeatureBounds': ['0', '0', '0'],
                'proposalBoundRadii': [3, 10, 10], 'localFeatureRanges': ['0', '0', '0'],
                'featureRangesRadius3': ['0', '0', '0']}
    luminance, scale, features = scene.coordinates(at)
    deltas = [decimal_luminance(shared, scene, x, y, amount_l, luminance_words),
              shared.blend(amount_c) * D.from_float(shared.word_value(owner_words[0])) if amount_c else Z,
              shared.blend(amount_c) * D.from_float(shared.word_value(owner_words[1])) if amount_c else Z]
    denominator, numerators = Z, [Z, Z]
    bandwidth = maximum * (D(amount_c) / 100) ** 2
    maxima, near_maxima = [Z, Z, Z], [Z, Z, Z]
    for dy in range(-10, 11):
        for dx in range(-10, 11):
            vx, vy = max(0, min(scene.width - 1, x + dx)), max(0, min(scene.height - 1, y + dy))
            neighbor = vy * scene.width + vx
            if not scene.pixels[neighbor][3]:
                continue
            other = scene.coordinates(neighbor)[2]
            for component in range(3):
                if abs(dx) <= 3 and abs(dy) <= 3:
                    near_maxima[component] = max(near_maxima[component], abs(other[component] - features[component]))
                if component or (abs(dx) <= 3 and abs(dy) <= 3):
                    maxima[component] = max(maxima[component], abs(other[component] - features[component]))
            if amount_c:
                coverage, sum_l, sum_c = Z, Z, Z
                for uy in range(-2, 3):
                    for ux in range(-2, 3):
                        left, right = scene.index(x + ux, y + uy), scene.index(vx + ux, vy + uy)
                        q = scene.pixels[left][3] * scene.pixels[right][3]
                        if not q:
                            continue
                        first, second = ([D.from_float(value) for value in guide[index]]
                                         for index in (left, right))
                        dl, da, db = [first[k] - second[k] for k in range(3)]
                        coverage += q
                        sum_l += q * (dl * dl)
                        sum_c += q * ((da * da) + (db * db))
                weight = (scene.pixels[neighbor][3] ** 2 * shared.weight_exp(
                    -(sum_l / coverage) / D('.08') ** 2 -
                    (sum_c / coverage) / bandwidth ** 2)) if coverage else Z
                denominator += weight
                for index, component in enumerate((1, 2)):
                    numerators[index] += weight * (other[component] - features[component])
    if amount_c and not denominator:
        raise ArithmeticError('Independent Decimal patch point lost positive normalization.')
    means = [value / denominator for value in numerators] if amount_c else [Z, Z]
    for host_value, exact in zip(host_raw_mean or (0.0, 0.0), means):
        if abs(D.from_float(host_value) - exact) > D('2e-12') + D('2e-11') * abs(exact):
            raise ArithmeticError('Host patch graph disagrees with independent Decimal80 mathematics.')
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
    shared = load('c16_independent_decimal', SHARED)
    host = load('c16_independent_host_graph', HOST)
    runtime = runtime_fingerprint()
    prefixes = IndependentPrefixStore(runtime)
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
              'wordOracle': word_oracle, 'runtimeFingerprint': runtime,
              'selection': {key: plan[key] for key in ('primaries', 'controls', 'configurations')},
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
            with localcontext() as seam_context:
                seam_context.prec = 250
                ideal_word = shared.binary32_word(Decimal.from_float(first) + Decimal.from_float(second))
            rows.append({**spec, 'guideWord': f'{host.binary32_word(summed):08x}',
                         'finalDeltaWord': f'{host.binary32_word(normalized, True):08x}',
                         'idealDecimalGuideWord': f'{ideal_word:08x}',
                         'sumFloat64Word': host.binary64_word(summed)})
        return {**common, 'publicationVectors': rows, 'scenes': [],
                'prefixReuseEvidence': prefixes.evidence()}
    pilot_reference = load('c16_independent_c14_direct', PILOT_REFERENCE)
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
            matches = prefixes.matches(spec, primary, source_bytes, coefficients, host)
            maximum = (Decimal(BASE) ** 2 + Decimal(FACTOR) ** 2 *
                       (scene.variance[1] + scene.variance[2])).sqrt()
            has_active_c = any(chroma for _, chroma in plan['controls'])
            pilot_words, guide, pilot_proposals, features = None, None, None, None
            prefix_origin = 'not-required-c0-only'
            if has_active_c:
                features = host.source_features(source, coefficients)
                reused = prefixes.pilot(matches, spec, primary, host)
                if reused is not None:
                    pilot_words, pilot_proposals, guide = reused
                    prefix_origin = 'bound-independent-c15-reference'
                else:
                    if matches:
                        raise ValueError('Retained scene unexpectedly lacks its independently proved pilot.')
                    pilot_words = [scene.center_stage(x, y, 100, 100, Decimal(BASE), maximum)
                                   for y in range(scene.height) for x in range(scene.width)]
                    guide, pilot_proposals = host.gather_guide(features, alpha, scene.width, scene.height,
                        lambda x, y: pilot_words[y * scene.width + x])
                    prefixes.generated.add((spec['id'], primary))
                    prefix_origin = 'new-independent-decimal80-c14-prefix'
            cases = []
            l_cache = {}
            for amount_l, amount_c in plan['controls']:
                e_words, raw_means = None, None
                if amount_c:
                    e_words, _, raw_means = host.owner_chroma(features, guide, alpha,
                        scene.width, scene.height, amount_c,
                        [float(value) for value in spec['frozenVariance']])
                if amount_l not in l_cache and (amount_c or spec['points']):
                    l_words = prefixes.luminance(matches, spec, primary, amount_l)
                    if l_words is None:
                        if matches:
                            raise ValueError('Retained scene lacks independent user-L9 at a retained amount.')
                        l_words = []
                        for y in range(scene.height):
                            for x in range(scene.width):
                                words = old_scene.center_stage(x, y, amount_l, 0, Decimal(BASE), maximum)
                                l_words.append([words[index * 3] for index in range(9)])
                        prefixes.generated_l.add((spec['id'], primary, amount_l))
                    l_cache[amount_l] = l_words
                luminance_words = l_cache.get(amount_l)
                points = [decimal_point(shared, scene, x, y, amount_l,
                          amount_c, maximum, guide, e_words[y * scene.width + x] if amount_c else None,
                          raw_means[y * scene.width + x] if amount_c else None, luminance_words)
                          for x, y in spec['points']]
                l_proposals = (host.gather_luminance(alpha, scene.width, scene.height,
                                                   luminance_words, amount_l) if amount_c else None)
                cases.append({'primaries': primary, 'luminance': amount_l, 'chroma': amount_c,
                              'points': points,
                              'originalLuminanceProposalWords64': [host.binary64_word(value)
                                   for value in l_proposals] if amount_c else None,
                              'finalStageWords': [[f'{word:08x}' for word in
                                  luminance_words[index] + list(e_words[index])]
                                  for index in range(len(source))] if amount_c else None})
            primaries.append({'primaries': primary, 'coefficientWords': word_oracle['coefficientWords'][primary],
                'prefixOrigin': prefix_origin,
                'pilotStageWords': [[f'{word:08x}' for word in stage] for stage in pilot_words]
                                  if has_active_c else None,
                'guideWords': [[f'{host.binary32_word(value):08x}' for value in pixel] for pixel in guide]
                              if has_active_c else None,
                'pilotFeatureProposalWords64': [[host.binary64_word(value) for value in pixel]
                                              for pixel in pilot_proposals] if has_active_c else None})
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
    return {**common, 'scenes': scenes, 'publicationVectors': [],
            'prefixReuseEvidence': prefixes.evidence()}


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


def compare(reference_path, candidate_path, counterfeit=None):
    reference = json.loads(reference_path.read_text())
    plan = input_plan(reference['group'])
    if counterfeit is None:
        selected_scenes = [case['id'] for case in plan['cases']]
        selected_configurations = plan['configurations']
    else:
        if counterfeit not in plan['counterfeitScopes']:
            raise ValueError('Named negative has no declared witness scope in this reference group.')
        if candidate_path.resolve() == (ROOT / 'scripts/research/strong-noise/chroma-pilot-patch.py').resolve():
            raise ValueError('Named negative requires an explicit distinct counterfeit candidate source.')
        scope = plan['counterfeitScopes'][counterfeit]
        selected_scenes = scope['selectedScenes']
        selected_configurations = scope['configurations']
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
    prefixes = IndependentPrefixStore(reference['runtimeFingerprint'])
    if reference.get('prefixReuse') != reuse_policy():
        raise ValueError('Independent prefix reuse policy changed.')
    shared = load('c16_checker_independent_decimal', SHARED)
    host = load('c16_checker_independent_host', HOST)
    model = load('c16_comparison_only_cpu_helpers', ROOT / 'scripts/research/detail-candidates.py')
    method = load('c16_comparison_only_candidate', candidate_path)
    legacy = load('c16_comparison_only_old_c9', ROOT / 'scripts/research/strong-noise/noise-scaled-patchwise.py')
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
              'independentCoefficientWordsChecked', 'exactLuminanceProposalWords64Checked',
              'actualComposedEntrypointsChecked')
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
                derived_coefficients = host.independently_rounded_coefficients(shared, name)
                prefix_matches = prefixes.matches(spec, name, source_bytes, derived_coefficients, host)
                if any(chroma for _, chroma in plan['controls']):
                    retained = prefixes.pilot(prefix_matches, spec, name, host)
                    if retained is not None:
                        stage, proposals, guide = retained
                        expected_prefix = {
                            'pilotStageWords': [[f'{word:08x}' for word in row] for row in stage],
                            'pilotFeatureProposalWords64': [[host.binary64_word(value) for value in row]
                                                           for row in proposals],
                            'guideWords': [[f'{host.binary32_word(value):08x}' for value in row] for row in guide]}
                        if primary.get('prefixOrigin') != 'bound-independent-c15-reference' or any(
                                primary.get(key) != value for key, value in expected_prefix.items()):
                            raise ValueError('Reference failed exact independent retained-prefix reuse.')
                    else:
                        if prefix_matches or primary.get('prefixOrigin') != 'new-independent-decimal80-c14-prefix':
                            raise ValueError('New prefix provenance was not independently declared.')
                        prefixes.generated.add((spec['id'], name))
                elif primary.get('prefixOrigin') != 'not-required-c0-only':
                    raise ValueError('C0-only reference constructed a forbidden prefix.')
                cases = [case for case in scene['cases'] if case['primaries'] == name]
                if [[case['luminance'], case['chroma']] for case in cases] != plan['controls']:
                    raise ValueError('Reference controls missing, added or reordered.')
                for case in cases:
                    amount_l, amount_c = case['luminance'], case['chroma']
                    context = {'scene': spec['id'], 'primary': name, 'controls': [amount_l, amount_c]}
                    independent_l_words = None
                    if amount_c or spec['points']:
                        independent_l_words = prefixes.luminance(prefix_matches, spec, name, amount_l)
                        if independent_l_words is None:
                            if prefix_matches or not amount_c:
                                raise ValueError('Independent user-L prefix is missing at a retained control.')
                            independent_l_words = [[int(word, 16) for word in row[:9]]
                                                   for row in case['finalStageWords']]
                            prefixes.generated_l.add((spec['id'], name, amount_l))
                    expected_l_proposals = None
                    if amount_c:
                        independent_l_proposals = host.gather_luminance([pixel[3] for pixel in source],
                            width, height, independent_l_words, amount_l)
                        expected_l_proposals = [host.binary64_word(value) for value in independent_l_proposals]
                        if case.get('originalLuminanceProposalWords64') != expected_l_proposals:
                            raise ValueError('Independent user-L Float64 proposal reference changed.')
                        if [row[:9] for row in case['finalStageWords']] != [
                                [f'{word:08x}' for word in row] for row in independent_l_words]:
                            raise ValueError('Independent user-L E9 publication reference changed.')
                    if len(case['points']) != len(spec['points']):
                        raise ValueError('Reference selected point count changed.')
                    for point, selected in zip(case['points'], spec['points']):
                        if ([point['x'], point['y']] != selected
                                or point['proposalBoundRadii'] != [3, 10, 10]):
                            raise ValueError('Reference selected point/support binding changed.')
                        offset = (point['y'] * width + point['x']) * 16
                        input_words = [f'{word:08x}' for word in struct.unpack('<4I', source_bytes[offset:offset + 16])]
                        if point['inputWords'] != input_words:
                            raise ValueError('Reference selected point source words changed.')
                    # Even a named negative validates every full-reference input,
                    # independent prefix and L binding above. It skips only the
                    # unselected actual candidate invocations/comparisons below.
                    if spec['id'] not in selected_scenes:
                        continue
                    candidate_source = [pixel[:] for pixel in source]
                    candidate_snapshot = json.loads(json.dumps(snapshot))
                    actual_policy = json.loads(json.dumps(candidate_policy))
                    filtered, diagnostics = method.denoise(model, candidate_source, width, height,
                        model.LUMINANCE[name], amount_l, amount_c, actual_policy,
                        capture_deltas=True, estimate_snapshot=candidate_snapshot, capture_stages=True)
                    counts['actualComposedEntrypointsChecked'] += 1
                    try:
                        after = b''.join(struct.pack('<4I', *(host.require_published(value) for value in pixel))
                                         for pixel in candidate_source)
                    except (TypeError, ValueError, OverflowError, struct.error):
                        after = None
                    if after != source_bytes:
                        fail('original-source-input-mutation', context)
                    try:
                        descriptor_equal = canonical(candidate_snapshot) == canonical(snapshot)
                        policy_equal = canonical(actual_policy) == canonical(candidate_policy)
                    except (TypeError, ValueError):
                        descriptor_equal = policy_equal = False
                    if not descriptor_equal:
                        fail('frozen-estimator-input-mutation', context)
                    if not policy_equal:
                        fail('candidate-policy-input-mutation', context)
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
                        for index, (actual, word) in enumerate(zip(deltas, expected_l_proposals)):
                            counts['exactLuminanceProposalWords64Checked'] += 1
                            if host.binary64_word(actual[0]) != word:
                                fail('independent-user-L-proposal-word64', context, index=index)
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
                            'guideScalars': 3, 'pilotConstructed': True, 'prefixMemoization': 'none',
                            'dispatch': 'pilot-patch-chroma-v1',
                            'chromaMatchingRadius': 2, 'chromaTargetRadius': 0,
                            **{key: plan[key] for key in ('sourceHalo', 'proposalBoundRadii',
                                'guidePolicy', 'chromaDistancePolicy', 'valuePolicy', 'neighborAlphaPolicy',
                                'matchingAlphaPolicy')}}
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
            if pair['left'] not in selected_scenes or pair['right'] not in selected_scenes:
                continue
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
    if reference.get('prefixReuseEvidence') != prefixes.evidence():
        raise ValueError('Independent prefix reuse evidence/counts changed.')
    if configurations != selected_configurations:
        raise ValueError('Missing or additional actual numerical configurations.')
    status = 'failed' if failures else 'counterfeit-not-rejected' if counterfeit else 'passed'
    return {'status': status, 'referenceKind': KIND,
            'candidateId': CANDIDATE_ID, 'group': plan['group'], 'configurations': configurations,
            'comparisonScope': 'counterfeit-witness-only' if counterfeit else 'complete-group',
            'completeGroup': counterfeit is None, 'fullPlanConfigurations': plan['configurations'],
            'selectedScenes': selected_scenes, 'counterfeit': counterfeit,
            'generatorSha256': digest(__file__), 'candidateSha256': digest(candidate_path),
            'planSha256': reference['planSha256'], 'sourceBindings': source_bindings(),
            'referenceSha256': digest(reference_path), 'wordOracle': reference['wordOracle'],
            'runtimeFingerprint': reference['runtimeFingerprint'],
            'prefixReuse': reuse_policy(), 'prefixReuseEvidence': prefixes.evidence(),
            'coefficientWordsAgreed': not any(row['kind'] == 'independent-primary-coefficient-word' for row in failures),
            **counts, 'failures': failures,
            'scope': 'Small independent Decimal80 and pinned host-F64 publication vectors only; no photographic, GPU, resource or application adoption.'}


def approval(plan, path):
    approved = json.loads(Path(path).read_text())
    expected = {'referenceGenerationApproved': True, 'referenceKind': KIND,
                'generatorSha256': digest(__file__), 'sourceBindings': source_bindings(),
                'sharedGeneratorSha256': digest(SHARED), 'sharedInputPlanSha256': digest(SHARED_PLAN),
                'planSha256': sha256(canonical(plan)).hexdigest(), 'group': plan['group'],
                'candidateSha256': digest(ROOT / 'scripts/research/strong-noise/chroma-pilot-patch.py'),
                'wordOracle': {key: value for key, value in WORD_ORACLE.items() if key != 'coefficientWords'},
                'prefixReuse': reuse_policy()}
    if any(approved.get(key) != value for key, value in expected.items()):
        raise ValueError('Numerical execution is missing exact reviewed source/plan approval.')
    requested = approved.get('groups', {}).get(plan['group'])
    if requested != {'planSha256': expected['planSha256'], 'configurations': plan['configurations']}:
        raise ValueError('Requested numerical group has no exact approval; another group does not authorize it.')
    return approved


def fresh_output(path):
    path = path.resolve()
    if not path.is_relative_to(ROOT / 'artifacts') or path.exists():
        raise ValueError('Choose a fresh output file under ignored artifacts/.')
    if not path.parent.is_dir():
        raise ValueError('Create the owned artifact directory before numerical execution.')
    return path


def publish(path, result):
    path = fresh_output(path)
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
                        default=ROOT / 'scripts/research/strong-noise/chroma-pilot-patch.py')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--counterfeit', choices=tuple(COUNTERFEIT_SCENES))
    args = parser.parse_args()
    if args.counterfeit is not None and args.check is None:
        parser.error('--counterfeit is negative-only and requires --check.')
    if (args.counterfeit is not None and args.candidate.resolve() ==
            (ROOT / 'scripts/research/strong-noise/chroma-pilot-patch.py').resolve()):
        parser.error('--counterfeit requires an explicit distinct --candidate source.')
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
    args.output = fresh_output(args.output)
    with localcontext() as context:
        context.prec = 80
        result = generate(plan) if args.generate else compare(args.check, args.candidate, args.counterfeit)
    if args.generate:
        result['approvalSha256'] = digest(args.approved_freeze)
        result['generationApprovalPath'] = str(args.approved_freeze.resolve())
    publish(args.output, result)
    print(json.dumps({'status': result.get('status', 'reference-created'),
                      'output': str(args.output.resolve()), 'sha256': digest(args.output)}))
    if result.get('status') == 'failed':
        raise SystemExit(1)
    if result.get('status') == 'counterfeit-not-rejected':
        raise SystemExit(2)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exit1 is reserved for a fully written structured numeric comparison
        # with status=failed. Missing approval/runtime/source or an unresolved
        # reference calculation is incomplete execution, never a counterfeit.
        print(f'C16 reference validation/execution error: {type(error).__name__}: {error}',
              file=sys.stderr)
        raise SystemExit(2) from error
