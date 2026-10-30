#!/usr/bin/env python3
"""CC0-1.0 independent Decimal80 C8 width compilation and direct-patch reference.

Imports only the separately checked C7 Decimal oracle. Neither the candidate,
application processing nor source-noise estimator is imported or run here.
"""
from argparse import ArgumentParser
from decimal import Decimal, localcontext
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
PLAN = ROOT / 'assets/tests/references/detail/strong-noise/noise-scaled-input-plan.json'
KIND = 'noise-scaled-patchwise-decimal80-v1'
SHARED = HERE / 'reference.py'


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def canonical_math(value):
    if not json.dumps(value, ensure_ascii=False).isascii():
        raise ValueError('Frozen math keys and strings must be ASCII for Node/Python parity.')
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')


def shared_oracle():
    spec = importlib.util.spec_from_file_location('checked_direct_decimal_oracle', SHARED)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def generate(plan, oracle):
    scenes = []
    base_l = Decimal(plan['baseLuminanceMaximum'])
    base_c = Decimal(plan['baseChromaMaximum'])
    for spec in plan['cases']:
        cases, source_words = [], None
        for primaries in plan['primaries']:
            scene = oracle.Scene(spec, primaries)
            if source_words is not None and scene.words != source_words:
                raise ArithmeticError('Changing primaries changed the declared source words.')
            source_words = scene.words
            for factor_text in plan['sigmaFactors']:
                factor = Decimal(factor_text)
                # Scene converts each declared variance through the same Float64
                # word as the candidate. All width arithmetic here is Decimal80.
                maximum = (base_c * base_c + factor * factor *
                           (scene.variance[1] + scene.variance[2])).sqrt()
                for luminance, chroma in plan['controls']:
                    cases.append({
                        'primaries': primaries, 'luminance': luminance, 'chroma': chroma,
                        'hLMax': plan['baseLuminanceMaximum'],
                        'hCBase': plan['baseChromaMaximum'],
                        'chromaSigmaFactor': factor_text,
                        'compiledChromaMaximumDecimal80': str(maximum),
                        'points': [scene.point(x, y, luminance, chroma, base_l, maximum)
                                   for x, y in spec['points']],
                    })
            scene.coordinates.cache_clear()
            scene.center_stage.cache_clear()
            scene.direct_patches.cache_clear()
        source_bytes = b''.join(struct.pack('<4I', *p) for p in source_words)
        scenes.append({
            'id': spec['id'], 'width': spec['width'], 'height': spec['height'],
            'frozenVariance': spec['frozenVariance'],
            'inputRgba32leHex': source_bytes.hex(),
            'sourceSha256': sha256(source_bytes).hexdigest(), 'cases': cases,
        })
    return scenes


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--approved-freeze', type=Path, required=True)
    parser.add_argument('--input-plan', type=Path, default=PLAN)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', action='append')
    parser.add_argument('--factor', action='append')
    args = parser.parse_args()
    plan_path = args.input_plan.resolve()
    plan = json.loads(plan_path.read_text())
    if plan.get('referenceKind') != KIND:
        raise SystemExit('Unsupported C8 reference input plan.')
    approval = json.loads(args.approved_freeze.read_text())
    if approval.get('referenceGenerationApproved') is not True or approval.get('referenceKind') != KIND:
        raise SystemExit('C8 reference generation has not been explicitly approved.')
    expected_shared = plan['sharedReference']
    if expected_shared['sha256'] != digest(SHARED):
        raise SystemExit('Shared direct Decimal oracle changed after the C8 declaration.')
    if expected_shared['inputPlanSha256'] != digest(HERE / 'input-plan.json'):
        raise SystemExit('Shared C7 input declaration changed.')
    for key, actual in (
        ('inputPlanSha256', digest(plan_path)),
        ('generatorSha256', digest(Path(__file__))),
        ('sharedGeneratorSha256', digest(SHARED)),
        ('equationsSha256', sha256(canonical_math(plan['math'])).hexdigest()),
    ):
        if approval.get(key) != actual:
            raise SystemExit(f'Frozen {key} differs from the reviewed C8 declaration.')
    if approval.get('sigmaFactors') != plan['sigmaFactors']:
        raise SystemExit('Frozen C8 factors differ.')
    selected = dict(plan)
    if args.case:
        if len(set(args.case)) != len(args.case) or not set(args.case) <= {v['id'] for v in plan['cases']}:
            raise SystemExit('Choose distinct declared cases only.')
        selected['cases'] = [v for v in plan['cases'] if v['id'] in args.case]
    if args.factor:
        if len(set(args.factor)) != len(args.factor) or not set(args.factor) <= set(plan['sigmaFactors']):
            raise SystemExit('Choose distinct declared factors only.')
        selected['sigmaFactors'] = [v for v in plan['sigmaFactors'] if v in args.factor]
    destination = args.output.resolve()
    if not destination.is_relative_to(ROOT / 'artifacts') or destination.exists():
        raise SystemExit('Choose a fresh ignored output under artifacts/.')
    with localcontext() as context:
        context.prec = 80
        oracle = shared_oracle()
        result = {
            'version': KIND, 'referenceKind': KIND, 'license': 'CC0-1.0', 'precision': 80,
            'generatorSha256': digest(Path(__file__)),
            'sharedGeneratorSha256': digest(SHARED), 'inputPlanSha256': digest(plan_path),
            'approvalSha256': digest(args.approved_freeze),
            'method': 'Independent Decimal80 source-variance width compilation and shared direct-patch oracle; no candidate, application or estimator imports.',
            'selection': {'cases': [v['id'] for v in selected['cases']],
                          'sigmaFactors': selected['sigmaFactors'],
                          'partial': selected != plan},
            'scenes': generate(selected, oracle),
        }
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('x') as output:
        json.dump(result, output, indent=2, allow_nan=False)
        output.write('\n')


if __name__ == '__main__':
    main()
