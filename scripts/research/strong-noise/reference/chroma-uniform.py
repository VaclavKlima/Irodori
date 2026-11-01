#!/usr/bin/env python3
"""CC0-1.0 independent Decimal80 C11 uniform-chroma mathematical reference.

The shared direct oracle supplies source recipes, independent primary solving,
coordinates, stable inverse, local bounds and exact binary32 conversion. This
subclass changes only the chroma spatial term in directly enumerated patches.
Reference generation never imports a candidate; --check compares small numeric
vectors only. No source estimator, GPU, photograph or quality gate is run.
"""
from argparse import ArgumentParser
from decimal import Decimal, localcontext
from functools import lru_cache
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
SHARED = HERE / 'reference.py'
SHARED_PLAN = HERE / 'input-plan.json'
KIND = 'chroma-uniform-patchwise-decimal80-v1'
CANDIDATE_ID = 'noise-scaled-k40-chroma-uniform'
GROUPS = ('core', 'alpha', 'asymmetric', 'identity')
AMOUNTS = (0, 1, 25, 50, 75, 100)
BASE, FACTOR = '0.024', '0.4'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def input_plan(group):
    original = json.loads(SHARED_PLAN.read_text())
    core = ('signed-zero-identity', 'flat-gray', 'noise-like-low', 'signed-hdr',
            'one-pixel', 'one-axis', 'one-horizontal-axis', 'clamped-bias', 'clamped-zero-variance')
    alpha = ('hidden-zero-a', 'hidden-zero-b', 'partial-alpha', 'partial-alpha-common-scale',
             'noise-like-low', 'opaque-tiny-alpha', 'opaque-subnormal-alpha')
    names = core if group == 'core' else alpha if group == 'alpha' else ('noise-like-low',) if group == 'asymmetric' else tuple(c['id'] for c in original['cases'])
    controls = ([[1, 100], [100, 1], [25, 75], [75, 25], [50, 0], [0, 50]]
                if group == 'asymmetric' else [[a, 0 if group == 'identity' else a] for a in AMOUNTS])
    cases = [dict(c) for c in original['cases'] if c['id'] in names]
    if group == 'identity':
        cases = [{**c, 'points': []} for c in cases]
    return {'referenceKind': KIND, 'candidateId': CANDIDATE_ID,
            'group': group, 'primaries': original['primaries'],
            'controls': controls, 'baseLuminanceMaximum': BASE, 'baseChromaMaximum': BASE,
            'chromaSigmaFactor': FACTOR, 'chromaSpatialPolicy': 'uniform-search-v1',
            'cases': cases, 'pairChecks': [p for p in original['pairChecks']
                                          if p['left'] in names and p['right'] in names],
            'pointPolicy': 'C0 whole-grid bit identity only' if group == 'identity' else 'Unchanged original declared reference points',
            'configurations': len(cases) * len(controls) * len(original['primaries']),
            'sharedGeneratorSha256': digest(SHARED), 'sharedInputPlanSha256': digest(SHARED_PLAN),
            'math': {'searchRadius': 3, 'patchRadius': 1, 'luminanceSpatial': 'exp(-(dx^2+dy^2)/8)',
                     'chromaSpatial': '1 inside the same bounded search, including unchanged d=0 alpha mass',
                     'bandwidth': 'hC=sqrt(.024^2+.4^2*(vA+vB))*(C/100)^2; hL=.024*(L/100)^2',
                     'distances': 'Original alpha-normalized corrected L/C patch distances; no C10 mean guard',
                     'stage': '27 independently normalized binary32 E words; rounded zeros canonical +0',
                     'other': 'Original source-wide frozen variance inputs, alpha rules, outer gather, blend and stable inverse'},
            'limits': original['limits']}


def candidate_policy():
    return {'id': CANDIDATE_ID, 'aggregation': 'normalized-patch-estimates-f32-zero-v1',
            'variance': 'frozen-global-directional-mad-v1', 'correction': 'both',
            'adaptive': 'none', 'blend': 'quadratic-to-50-v1', 'selfPolicy': 'legacy',
            'bandwidthPolicy': 'global-chroma-sigma-floor-v1',
            'luminanceBandwidthMaximum': float(BASE), 'chromaBandwidthMaximum': float(BASE),
            'chromaSigmaFactor': float(FACTOR), 'chromaSpatialPolicy': 'uniform-search-v1'}


def uniform_scene(shared):
    class UniformScene(shared.Scene):
        @lru_cache(maxsize=256)
        def center_stage(self, x, y, amount_l, amount_c, max_l, max_c):
            zero, number = Decimal(0), Decimal
            at = self.index(x, y)
            if not self.pixels[at][3] or (not amount_l and not amount_c):
                return tuple([0] * 27)
            hl, hc = max_l * (number(amount_l) / 100) ** 2, max_c * (number(amount_c) / 100) ** 2
            records = []
            for neighbor, dl, dc, spatial, *tail in self.direct_patches(x, y):
                dx, dy = tail[-2:]
                # The direct oracle's spatial field already includes alpha(q).
                wl = spatial * shared.weight_exp(-dl / hl ** 2 - dc / number('.12') ** 2) if amount_l else zero
                wc = self.pixels[neighbor][3] * shared.weight_exp(-dl / number('.08') ** 2 - dc / hc ** 2) if amount_c else zero
                records.append((dx, dy, wl, wc))
            words = []
            for ry in range(-1, 2):
                for rx in range(-1, 2):
                    tx, ty = x + rx, y + ry
                    if tx < 0 or tx >= self.width or ty < 0 or ty >= self.height:
                        words.extend([0, 0, 0])
                        continue
                    target_index = ty * self.width + tx
                    if not self.pixels[target_index][3]:
                        words.extend([0, 0, 0])
                        continue
                    target = self.coordinates(target_index)[2]
                    numerators, weights = [zero] * 3, [zero] * 2
                    for dx, dy, wl, wc in records:
                        sample_index = self.index(tx + dx, ty + dy)
                        alpha = self.pixels[sample_index][3]
                        if not alpha:
                            continue
                        sample = self.coordinates(sample_index)[2]
                        left, right = wl * alpha, wc * alpha
                        weights[0] += left
                        weights[1] += right
                        numerators[0] += left * (sample[0] - target[0])
                        numerators[1] += right * (sample[1] - target[1])
                        numerators[2] += right * (sample[2] - target[2])
                    for component, amount in enumerate((amount_l, amount_c, amount_c)):
                        denominator = weights[0 if component == 0 else 1]
                        if amount and not denominator:
                            raise ArithmeticError('Lost positive center normalization.')
                        delta = numerators[component] / denominator if amount else zero
                        word = shared.binary32_word(delta)
                        words.append(0 if (word & 0x7fffffff) == 0 else word)
            return tuple(words)
    return UniformScene


def generate(plan):
    shared = load('c11_independent_direct_shared', SHARED)
    scene_type = uniform_scene(shared)
    scenes = []
    for spec in plan['cases']:
        cases, input_words = [], None
        for primaries in plan['primaries']:
            scene = scene_type(spec, primaries)
            if input_words is not None and input_words != scene.words:
                raise ArithmeticError('Primary selection changed declared source words.')
            input_words = scene.words
            maximum = (Decimal(BASE) ** 2 + Decimal(FACTOR) ** 2 *
                       (scene.variance[1] + scene.variance[2])).sqrt()
            for luminance, chroma in plan['controls']:
                cases.append({'primaries': primaries, 'luminance': luminance, 'chroma': chroma,
                              'hLMax': BASE, 'hCBase': BASE, 'chromaSigmaFactor': FACTOR,
                              'chromaSpatialPolicy': 'uniform-search-v1',
                              'compiledChromaMaximumDecimal80': str(maximum),
                              'points': [scene.point(x, y, luminance, chroma, Decimal(BASE), maximum)
                                         for x, y in spec['points']]})
            scene.coordinates.cache_clear()
            scene.center_stage.cache_clear()
            scene.direct_patches.cache_clear()
        source_bytes = b''.join(struct.pack('<4I', *p) for p in input_words)
        scenes.append({'id': spec['id'], 'width': spec['width'], 'height': spec['height'],
                       'frozenVariance': spec['frozenVariance'],
                       'inputRgba32leHex': source_bytes.hex(), 'sourceSha256': sha256(source_bytes).hexdigest(),
                       'cases': cases})
    return {'version': KIND, 'referenceKind': KIND, 'candidateId': CANDIDATE_ID,
            'license': 'CC0-1.0', 'precision': 80,
            'group': plan['group'], 'generatorSha256': digest(__file__),
            'sharedGeneratorSha256': digest(SHARED), 'sharedInputPlanSha256': digest(SHARED_PLAN),
            'planSha256': sha256(canonical(plan)).hexdigest(), 'plan': plan,
            'candidateImported': False, 'chromaSpatialPolicy': 'uniform-search-v1',
            'baseLuminanceMaximum': BASE, 'baseChromaMaximum': BASE, 'chromaSigmaFactor': FACTOR,
            'selection': {'cases': [c['id'] for c in plan['cases']], 'controls': plan['controls'],
                          'primaries': plan['primaries'], 'configurations': plan['configurations']},
            'scenes': scenes}


def compare(reference_path, candidate_path):
    reference = json.loads(reference_path.read_text())
    plan = input_plan(reference['group'])
    if (reference['referenceKind'] != KIND or reference['generatorSha256'] != digest(__file__)
        or reference['sharedGeneratorSha256'] != digest(SHARED)
        or reference['sharedInputPlanSha256'] != digest(SHARED_PLAN)
        or reference['planSha256'] != sha256(canonical(plan)).hexdigest()
        or reference['plan'] != plan or reference['candidateImported'] is not False):
        raise ValueError('Frozen numerical generator, shared reference or plan changed.')
    expected_scenes = [c['id'] for c in plan['cases']]
    if [s['id'] for s in reference['scenes']] != expected_scenes:
        raise ValueError('Reference scene selection is missing or reordered.')
    for spec, scene in zip(plan['cases'], reference['scenes']):
        if any(scene[key] != spec[key] for key in ('width', 'height', 'frozenVariance')):
            raise ValueError('Reference source dimensions or frozen variance changed.')
        expected_controls = [(primary, l, c) for primary in plan['primaries'] for l, c in plan['controls']]
        if [(c['primaries'], c['luminance'], c['chroma']) for c in scene['cases']] != expected_controls:
            raise ValueError('Reference primary/control selection is missing or reordered.')
        for case in scene['cases']:
            if (case['hLMax'], case['hCBase'], case['chromaSigmaFactor'], case['chromaSpatialPolicy']) != (BASE, BASE, FACTOR, 'uniform-search-v1'):
                raise ValueError('Reference does not use the declared C11 constants.')
            if [[p['x'], p['y']] for p in case['points']] != spec['points']:
                raise ValueError('Reference point selection changed.')
    scaled = True
    model = load('c7_independent_prefix_helpers', ROOT / 'scripts/research/detail-candidates.py')
    method = load('c11_uniform_candidate', candidate_path)
    old_method = load('c11_unchanged_c9_context', HERE.parent / 'noise-scaled-patchwise.py')
    stage_offsets = method.OFFSETS
    c0_rgba_words = c0_float64_words = c0_stage_words = 0
    configurations = checked = stage_words = 0
    compiled_widths = 0
    grid_alpha = grid_transparent = grid_neutral = final_rgb = 0
    failures = []
    outputs = {}
    for scene in reference['scenes']:
        source_bytes = bytes.fromhex(scene['inputRgba32leHex'])
        if sha256(source_bytes).hexdigest() != scene['sourceSha256']:
            raise SystemExit('Independent source frame hash changed.')
        source = [list(p) for p in struct.iter_unpack('<4f', source_bytes)]
        width, height = scene['width'], scene['height']
        assert len(source) == width * height
        snapshot = {'version': 'frozen-global-directional-mad-v1',
                    'variance': [float(v) for v in scene['frozenVariance']]}
        outputs[scene['id']] = {}
        for case in scene['cases']:
            l, c = case['luminance'], case['chroma']
            candidate = candidate_policy()
            filtered, diagnostics = method.denoise(model, source, width, height,
                model.LUMINANCE[case['primaries']], l, c, candidate,
                capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
            if (l or c) and diagnostics.get('chromaSpatialPolicy') != 'uniform-search-v1':
                failures.append({'kind': 'chroma-spatial-policy', 'scene': scene['id']})
            if c == 0:
                old_candidate = {k: v for k, v in candidate.items() if k != 'chromaSpatialPolicy'}
                old_output, old_diagnostics = old_method.denoise(model, source, width, height,
                    model.LUMINANCE[case['primaries']], l, c, old_candidate,
                    capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
                for a, b in zip(filtered, old_output):
                    c0_rgba_words += 4
                    if struct.pack('<4f', *a) != struct.pack('<4f', *b):
                        failures.append({'kind': 'C0-old-C9-rgba-identity', 'scene': scene['id'], 'controls': [l, c]})
                for a, b in zip(diagnostics['featureDeltas'], old_diagnostics['featureDeltas']):
                    c0_float64_words += 3
                    if struct.pack('<3d', *a) != struct.pack('<3d', *b):
                        failures.append({'kind': 'C0-old-C9-proposal-identity', 'scene': scene['id'], 'controls': [l, c]})
                if diagnostics.get('centerDeltas') is not None:
                    for a, b in zip(diagnostics['centerDeltas'], old_diagnostics['centerDeltas']):
                        c0_stage_words += 27
                        if struct.pack('<27f', *a) != struct.pack('<27f', *b):
                            failures.append({'kind': 'C0-old-C9-stage-identity', 'scene': scene['id'], 'controls': [l, c]})
            configurations += 1
            if scaled and (l or c):
                compiled_widths += 1
                bandwidth = diagnostics['chromaBandwidthPolicy']
                actual, expected = bandwidth['compiledMaximum'], float(case['compiledChromaMaximumDecimal80'])
                if not math.isfinite(actual) or abs(actual - expected) > 2e-12 + 2e-11 * abs(expected):
                    failures.append({'kind': 'compiled-chroma-maximum', 'scene': scene['id'],
                        'factor': case['chromaSigmaFactor'], 'actual': actual, 'reference': expected})
                if bandwidth['version'] != 'global-chroma-sigma-floor-v1' or bandwidth['baseMaximum'] != candidate['chromaBandwidthMaximum'] or bandwidth['noiseFactor'] != candidate['chromaSigmaFactor'] or bandwidth['frozenVariance'] != snapshot['variance']:
                    failures.append({'kind': 'compiled-chroma-policy', 'scene': scene['id'], 'factor': case['chromaSigmaFactor']})
            assert len(filtered) == len(source)
            for index,(original,actual) in enumerate(zip(source,filtered)):
                grid_alpha+=1
                if struct.pack('<f',original[3]) != struct.pack('<f',actual[3]):
                    failures.append({'kind':'all-grid-alpha-word','scene':scene['id'],'pixel':index,'controls':[l,c]})
                if original[3] == 0:
                    grid_transparent+=1
                    if struct.pack('<4f',*original) != struct.pack('<4f',*actual):
                        failures.append({'kind':'all-grid-transparent-rgba','scene':scene['id'],'pixel':index,'controls':[l,c]})
                if l == c == 0:
                    grid_neutral+=1
                    if struct.pack('<4f',*original) != struct.pack('<4f',*actual):
                        failures.append({'kind':'all-grid-neutral-rgba','scene':scene['id'],'pixel':index})
                if not all(math.isfinite(v) for v in actual):
                    failures.append({'kind':'all-grid-finite','scene':scene['id'],'pixel':index,'controls':[l,c]})
            key = (case['primaries'], l, c, case['hLMax'], case['hCBase'], case['chromaSigmaFactor']) if scaled else (case['primaries'], l, c, case['hLMax'], case['hCMax'])
            outputs[scene['id']][key] = {'filtered':filtered,'centers':diagnostics.get('centerDeltas'),'deltas':diagnostics['featureDeltas']}
            unrounded = diagnostics.get('outputFloat64', filtered)
            centers = diagnostics.get('centerDeltas')
            seen = set()
            for point in case['points']:
                at = point['y'] * width + point['x']
                original_words = struct.unpack('<4I', struct.pack('<4f', *source[at]))
                assert [f'{v:08x}' for v in original_words] == point['inputWords']
                for component in range(3):
                    actual, expected = unrounded[at][component], point['outputFloat64'][component]
                    checked += 1
                    if not math.isfinite(actual) or abs(actual - expected) > 2e-12 + 2e-11 * abs(expected):
                        failures.append({'kind': 'strict-pre-final-rgb', 'scene': scene['id'],
                            'configuration': key, 'point': [point['x'], point['y']],
                            'component': component, 'actual': actual, 'reference': expected})
                for component in range(3):
                    actual=filtered[at][component]
                    expected=point['outputFloat64'][component]
                    final_rgb+=1
                    if not math.isfinite(actual) or abs(actual-expected)>2e-6+2e-5*abs(expected):
                        failures.append({'kind':'final-rgb','scene':scene['id'],'configuration':key,'point':[point['x'],point['y']],'component':component,'actual':actual,'reference':expected})
                actual_alpha = struct.pack('<f', filtered[at][3]).hex()
                expected_alpha = bytes.fromhex(point['outputWords'][3])[::-1].hex()
                if actual_alpha != expected_alpha:
                    failures.append({'kind': 'alpha-word', 'scene': scene['id'], 'configuration': key})
                if point['identityCopy'] and struct.pack('<4f', *filtered[at]) != struct.pack('<4I', *[int(v, 16) for v in point['outputWords']]):
                    failures.append({'kind': 'identity-copy', 'scene': scene['id'], 'configuration': key})
                for stage in point.get('centerStages', []):
                    cx, cy = stage['center']
                    if (cx, cy) in seen:
                        continue
                    seen.add((cx, cy))
                    actual = [f'{v:08x}' for v in struct.unpack('<27I', struct.pack('<27f', *centers[cy * width + cx]))]
                    stage_words += 27
                    if actual != stage['publishedWords']:
                        failures.append({'kind': 'center-publication-word', 'scene': scene['id'],
                            'configuration': key, 'center': [cx, cy],
                            'wordIndices': [i for i, (a, b) in enumerate(zip(actual, stage['publishedWords'])) if a != b]})
            if centers is not None:
                for cy in range(height):
                    for cx in range(width):
                        for ri, (rx, ry) in enumerate(stage_offsets):
                            tx, ty = cx + rx, cy + ry
                            invalid = source[cy * width + cx][3] == 0 or tx < 0 or tx >= width or ty < 0 or ty >= height or source[ty * width + tx][3] == 0
                            if invalid and struct.pack('<3f', *centers[cy * width + cx][ri * 3:ri * 3 + 3]) != bytes(12):
                                failures.append({'kind': 'invalid-stage-slot', 'scene': scene['id'], 'configuration': key, 'center': [cx, cy], 'offset': [rx, ry]})
    pair_checks = pair_stage_words = pair_proposals = 0
    for pair in plan['pairChecks']:
        if pair['left'] not in outputs or pair['right'] not in outputs:
            continue
        left, right = outputs[pair['left']], outputs[pair['right']]
        for key in left.keys() & right.keys():
            for a, b in zip(left[key]['filtered'], right[key]['filtered']):
                if a[3] == 0 or b[3] == 0:
                    continue
                pair_checks += 3
                if struct.pack('<3f', *a[:3]) != struct.pack('<3f', *b[:3]):
                    failures.append({'kind': 'paired-visible-rgb-words', 'pair': pair, 'configuration': key})
            for a,b in zip(left[key]['deltas'],right[key]['deltas']):
                pair_proposals+=3
                if struct.pack('<3d',*a)!=struct.pack('<3d',*b):
                    failures.append({'kind':'paired-proposal-words','pair':pair,'configuration':key})
            if left[key]['centers'] is not None and right[key]['centers'] is not None:
                for a,b in zip(left[key]['centers'],right[key]['centers']):
                    pair_stage_words+=27
                    if struct.pack('<27f',*a)!=struct.pack('<27f',*b):
                        failures.append({'kind':'paired-center-words','pair':pair,'configuration':key})
    result = {'status': 'passed' if not failures else 'failed', 'configurations': configurations,
        'referenceKind': KIND, 'group': plan['group'],
        'generatorSha256': digest(__file__), 'candidateSha256': digest(candidate_path),
        'planSha256': reference['planSha256'],
        'C0OldC9RgbaWordsChecked': c0_rgba_words, 'C0OldC9ProposalWordsChecked': c0_float64_words,
        'C0OldC9StageWordsChecked': c0_stage_words,
        'compiledChromaWidthsChecked': compiled_widths,
        'preFinalRgbChannelsChecked': checked, 'finalRgbChannelsChecked':final_rgb,
        'allGridAlphaWordsChecked':grid_alpha,'allGridTransparentRgbaCopiesChecked':grid_transparent,
        'allGridNeutralRgbaCopiesChecked':grid_neutral,'exactCenterWordsChecked': stage_words,
        'pairedRgbChannelsChecked': pair_checks, 'pairedProposalWordsChecked':pair_proposals,
        'pairedCenterWordsChecked':pair_stage_words,'failures': failures,
        'scope': 'Independent direct Decimal80 versus artifact-only Float64 prefix prototype; no application/GPU/photographic acceptance.',
        'referenceSha256': sha256(reference_path.read_bytes()).hexdigest(),
        'selection': reference['selection']}
    if configurations != plan['configurations']:
        raise ValueError('Missing or additional numerical configurations.')
    return result


def publish(path, result):
    path = path.resolve()
    if not path.is_relative_to(ROOT / 'artifacts') or path.exists():
        raise ValueError('Choose a fresh output file under ignored artifacts/.')
    with path.open('x') as stream:
        stream.write(json.dumps(result, indent=2, allow_nan=False) + '\n')


def approval(plan, path):
    approved = json.loads(path.read_text())
    expected = {'referenceGenerationApproved': True, 'referenceKind': KIND,
                'generatorSha256': digest(__file__), 'sharedGeneratorSha256': digest(SHARED),
                'sharedInputPlanSha256': digest(SHARED_PLAN),
                'planSha256': sha256(canonical(plan)).hexdigest(), 'group': plan['group']}
    if any(approved.get(k) != v for k, v in expected.items()):
        raise ValueError('Numerical generation is missing its exact source/plan approval.')


def main():
    parser = ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan', action='store_true')
    mode.add_argument('--generate', action='store_true')
    mode.add_argument('--check', type=Path)
    parser.add_argument('--group', choices=GROUPS)
    parser.add_argument('--approved-freeze', type=Path)
    parser.add_argument('--candidate', type=Path, default=HERE.parent / 'chroma-uniform-patchwise.py')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.plan or args.generate:
        if args.group is None:
            parser.error('--plan and --generate require an explicit declared --group.')
        plan = input_plan(args.group)
        if args.plan:
            if args.output:
                parser.error('--plan is artifact-free.')
            print(json.dumps({'referenceKind': KIND, 'planSha256': sha256(canonical(plan)).hexdigest(),
                              'candidateImported': False, **plan}))
            return
        if args.approved_freeze is None:
            parser.error('--generate requires exact --approved-freeze metadata.')
        approval(plan, args.approved_freeze)
    if args.output is None:
        parser.error('Choose an explicit fresh --output under artifacts/.')
    with localcontext() as context:
        context.prec = 80
        result = generate(plan) if args.generate else compare(args.check, args.candidate)
    if args.generate:
        result['approvalSha256'] = digest(args.approved_freeze)
    publish(args.output, result)
    print(json.dumps({'status': result.get('status', 'reference-created'),
                      'output': str(args.output.resolve()), 'sha256': digest(args.output)}))
    if result.get('status') == 'failed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
