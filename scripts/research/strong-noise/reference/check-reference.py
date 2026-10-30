"""Independent-artifact comparison; no application code and no adjusted tolerances."""
import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
C8_KIND = 'noise-scaled-patchwise-decimal80-v1'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path)
    parser.add_argument('--method', choices=['fixed', 'noise-scaled'])
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Preserve prior comparisons; choose a fresh output.')
    reference = json.loads(args.reference.read_text())
    scaled = reference.get('referenceKind') == C8_KIND
    if reference.get('referenceKind') not in (None, C8_KIND):
        raise SystemExit('Unsupported independent reference kind.')
    if scaled and not args.input_plan:
        raise SystemExit('C8 comparison requires its explicit asset input plan.')
    if args.method is not None and args.method != ('noise-scaled' if scaled else 'fixed'):
        raise SystemExit('Requested method does not match the independent reference kind.')
    plan_path = args.input_plan or HERE / 'input-plan.json'
    generator_path = HERE / ('noise-scaled-reference.py' if scaled else 'reference.py')
    plan = json.loads(plan_path.read_text())
    if reference['generatorSha256'] != hashlib.sha256(generator_path.read_bytes()).hexdigest() or reference['inputPlanSha256'] != hashlib.sha256(plan_path.read_bytes()).hexdigest():
        raise SystemExit('Reference generator or input plan changed.')
    if scaled:
        shared_hash = hashlib.sha256((HERE / 'reference.py').read_bytes()).hexdigest()
        if plan.get('referenceKind') != C8_KIND or reference['sharedGeneratorSha256'] != shared_hash or plan['sharedReference']['sha256'] != shared_hash:
            raise SystemExit('C8 shared direct oracle or declared kind changed.')
    model = load('c7_independent_prefix_helpers', ROOT / 'scripts/research/detail-candidates.py')
    method = load('independent_prefix_candidate', HERE.parent / ('noise-scaled-patchwise.py' if scaled else 'patchwise.py'))
    stage_offsets = method.patchwise.OFFSETS if scaled else method.OFFSETS
    configurations = checked = stage_words = 0
    compiled_widths = 0
    grid_alpha = grid_transparent = grid_neutral = final_rgb = 0
    failures = []
    outputs = {}
    for scene in reference['scenes']:
        source_bytes = bytes.fromhex(scene['inputRgba32leHex'])
        if hashlib.sha256(source_bytes).hexdigest() != scene['sourceSha256']:
            raise SystemExit('Independent source frame hash changed.')
        source = [list(p) for p in struct.iter_unpack('<4f', source_bytes)]
        width, height = scene['width'], scene['height']
        assert len(source) == width * height
        snapshot = {'version': 'frozen-global-directional-mad-v1',
                    'variance': [float(v) for v in scene['frozenVariance']]}
        outputs[scene['id']] = {}
        for case in scene['cases']:
            l, c = case['luminance'], case['chroma']
            candidate = {'aggregation': 'normalized-patch-estimates-f32-zero-v1',
                         'luminanceBandwidthMaximum': float(case['hLMax']),
                         'chromaBandwidthMaximum': float(case['hCBase'] if scaled else case['hCMax'])}
            if scaled:
                candidate.update({'bandwidthPolicy': 'global-chroma-sigma-floor-v1',
                                  'chromaSigmaFactor': float(case['chromaSigmaFactor'])})
            filtered, diagnostics = method.denoise(model, source, width, height,
                model.LUMINANCE[case['primaries']], l, c, candidate,
                capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
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
        'referenceKind': C8_KIND if scaled else 'fixed-patchwise-decimal80',
        'compiledChromaWidthsChecked': compiled_widths,
        'preFinalRgbChannelsChecked': checked, 'finalRgbChannelsChecked':final_rgb,
        'allGridAlphaWordsChecked':grid_alpha,'allGridTransparentRgbaCopiesChecked':grid_transparent,
        'allGridNeutralRgbaCopiesChecked':grid_neutral,'exactCenterWordsChecked': stage_words,
        'pairedRgbChannelsChecked': pair_checks, 'pairedProposalWordsChecked':pair_proposals,
        'pairedCenterWordsChecked':pair_stage_words,'failures': failures,
        'scope': 'Independent direct Decimal80 versus artifact-only Float64 prefix prototype; no application/GPU/photographic acceptance.',
        'referenceSha256': hashlib.sha256(args.reference.read_bytes()).hexdigest(),
        'selection': reference['selection']}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'failures'}))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
