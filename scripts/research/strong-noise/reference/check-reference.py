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


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Preserve prior comparisons; choose a fresh output.')
    reference = json.loads(args.reference.read_text())
    plan = json.loads((HERE / 'input-plan.json').read_text())
    if reference['generatorSha256'] != hashlib.sha256((HERE / 'reference.py').read_bytes()).hexdigest() or reference['inputPlanSha256'] != hashlib.sha256((HERE / 'input-plan.json').read_bytes()).hexdigest():
        raise SystemExit('Reference generator or input plan changed.')
    model = load('c7_independent_prefix_helpers', ROOT / 'scripts/research/detail-candidates.py')
    method = load('c7_independent_prefix_candidate', HERE.parent / 'patchwise.py')
    configurations = checked = stage_words = 0
    failures = []
    outputs = {}
    for scene in reference['scenes']:
        source = [list(p) for p in struct.iter_unpack('<4f', bytes.fromhex(scene['inputRgba32leHex']))]
        width, height = scene['width'], scene['height']
        assert len(source) == width * height
        snapshot = {'version': 'frozen-global-directional-mad-v1',
                    'variance': [float(v) for v in scene['frozenVariance']]}
        outputs[scene['id']] = {}
        for case in scene['cases']:
            l, c = case['luminance'], case['chroma']
            candidate = {'aggregation': 'normalized-patch-estimates-f32-v1',
                         'luminanceBandwidthMaximum': float(case['hLMax']),
                         'chromaBandwidthMaximum': float(case['hCMax'])}
            filtered, diagnostics = method.denoise(model, source, width, height,
                model.LUMINANCE[case['primaries']], l, c, candidate,
                capture_deltas=True, estimate_snapshot=snapshot, capture_stages=True)
            configurations += 1
            key = (case['primaries'], l, c, case['hLMax'], case['hCMax'])
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
                        for ri, (rx, ry) in enumerate(method.OFFSETS):
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
        'preFinalRgbChannelsChecked': checked, 'exactCenterWordsChecked': stage_words,
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
