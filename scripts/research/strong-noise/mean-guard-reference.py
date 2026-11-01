#!/usr/bin/env python3
"""CC0-1.0 Decimal80 and exact-rational patch-mean statistics reference.

The declared inputs are feature coordinates, not photographs. Reference creation
does not import any candidate. Only --check imports the named statistics and
distance helpers; no denoising, estimator, application or GPU path is executed.
"""
from argparse import ArgumentParser
from decimal import Decimal, localcontext
from fractions import Fraction
from hashlib import sha256
import importlib.util
import json
import math
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
VERSION = 'patch-mean-chroma-guard-decimal80-v1'
FIELDS = ('meanA', 'meanB', 'sumBetaSquared', 'coverage')
GROUPS = ('analytic', 'geometry', 'alpha', 'guard')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def word(value):
    return struct.pack('>d', value).hex()


def value(text):
    return struct.unpack('>d', bytes.fromhex(text))[0]


def decimal(number):
    return Decimal.from_float(number)


def rational_decimal(number):
    return Decimal(number.numerator) / Decimal(number.denominator)


def source(identifier, width, height, alpha_kind='opaque', hidden=False, step=False):
    features, alpha = [], []
    for y in range(height):
        for x in range(width):
            a = {'opaque': 1.0, 'zero': 0.0, 'tiny': 2.0 ** -149}.get(alpha_kind)
            if a is None:
                a = (0.0, 0.25, 0.5, 0.75, 1.0, 2.0 ** -149)[(x + 3 * y) % 6]
            f = [100.0 + 13 * x + 19 * y,
                 (-0.2 if x < width // 2 else 0.2) if step else ((5 * x + 3 * y) % 11 - 5) / 8,
                 0.0 if step else ((x * x + 7 * y) % 13 - 6) / 16]
            if hidden and a == 0:
                f = [math.nan, math.inf, -math.inf]
            features.append([word(v) for v in f])
            alpha.append(word(a))
    return {'id': identifier, 'width': width, 'height': height,
            'featureWords': features, 'alphaWords': alpha, 'queries': []}


def query(cx, cy, dx, dy, expected=None):
    return {'center': [cx, cy], 'offset': [dx, dy],
            **({'analyticSumBetaSquared': expected} if expected is not None else {})}


def inputs(group):
    sources = []
    if group == 'analytic':
        a = source('opaque-interior', 11, 9)
        a['queries'] = [query(4, 4, 1, 0, '2/27'), query(4, 4, 0, 1, '2/27'),
                        query(4, 4, 3, 0, '2/9'), query(4, 4, 0, 3, '2/9'),
                        query(4, 4, 0, 0, '0')]
        b = source('one-pixel', 1, 1)
        b['queries'] = [query(0, 0, dx, dy, '0') for dy in (-3, 0, 3) for dx in (-3, 0, 3)]
        sources = [a, b]
    elif group == 'geometry':
        for width, height in ((1, 7), (7, 1), (3, 5), (5, 3), (7, 5)):
            a = source(f'clamped-{width}x{height}', width, height)
            centers = sorted({(0, 0), (width - 1, height - 1), (width // 2, height // 2)})
            a['queries'] = [query(cx, cy, dx, dy) for cx, cy in centers
                            for dy in range(-3, 4) for dx in range(-3, 4)]
            sources.append(a)
    elif group == 'alpha':
        for kind, hidden in (('mixed', False), ('mixed', True), ('zero', True),
                             ('opaque', False), ('tiny', False)):
            a = source(f'alpha-{kind}-hidden-{hidden}', 5, 3, kind, hidden)
            a['queries'] = [query(cx, cy, dx, dy) for cx, cy in ((0, 0), (2, 1), (4, 2))
                            for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (3, -3), (-3, 3))]
            sources.append(a)
    elif group == 'guard':
        a = source('step-guard', 9, 7, step=True)
        a['queries'] = [query(3, 3, 1, 0), query(4, 3, -1, 0), query(4, 3, 0, 0),
                        query(0, 0, 1, 0), query(8, 6, -3, -3)]
        for q in a['queries']:
            q['guards'] = [{'distance': d, 'varianceA': va, 'varianceB': vb}
                           for d in (0.0, 0.001, 0.1)
                           for va, vb in ((0.0, 0.0), (0.01, 0.01), (0.0025, 0.02))]
        sources.append(a)
    else:
        raise ValueError('Unknown declared numerical group.')
    return sources


def direct_reference(spec, q):
    """Coalesce globally clamped indices before Decimal80 feature arithmetic."""
    width, height = spec['width'], spec['height']
    features = [[value(v) for v in p] for p in spec['featureWords']]
    alpha = [value(v) for v in spec['alphaWords']]
    cx, cy = q['center']
    dx, dy = q['offset']
    paired, paired_exact = [], []
    coverage, exact_coverage = Decimal(0), Fraction(0)
    for ry in (-1, 0, 1):
        for rx in (-1, 0, 1):
            # Clamp each original coordinate, never clamp(P) and then add d.
            px, py = min(width - 1, max(0, cx + rx)), min(height - 1, max(0, cy + ry))
            qx, qy = min(width - 1, max(0, cx + dx + rx)), min(height - 1, max(0, cy + dy + ry))
            p, other = py * width + px, qy * width + qx
            a = decimal(alpha[p]) * decimal(alpha[other])
            exact = Fraction(alpha[p]) * Fraction(alpha[other])
            if exact == 0:
                continue
            paired.append((p, other, a))
            paired_exact.append((p, other, exact))
            coverage += a
            exact_coverage += exact
    if not paired:
        return {'decimal80': {name: '0' for name in FIELDS},
                'exact': {name: '0' for name in FIELDS}, 'beta': [],
                'proof': {'pairwiseEqualsGrouped': True, 'coefficientSumZero': True,
                          'covarianceEqualsExact': True, 'positivePairs': 0}}
    grouped, exact_grouped = {}, {}
    for p, other, weight in paired:
        weight /= coverage
        grouped[p] = grouped.get(p, Decimal(0)) + weight
        grouped[other] = grouped.get(other, Decimal(0)) - weight
    for p, other, weight in paired_exact:
        weight /= exact_coverage
        exact_grouped[p] = exact_grouped.get(p, Fraction(0)) + weight
        exact_grouped[other] = exact_grouped.get(other, Fraction(0)) - weight
    means, exact_means, direct_means = [], [], []
    for component in (1, 2):
        means.append(sum((beta * decimal(features[p][component])
                          for p, beta in sorted(grouped.items()) if beta != 0), Decimal(0)))
        exact_means.append(sum((beta * Fraction(features[p][component])
                               for p, beta in exact_grouped.items() if beta), Fraction(0)))
        direct_means.append(sum((weight * (Fraction(features[p][component]) -
                                           Fraction(features[other][component]))
                                 for p, other, weight in paired_exact), Fraction(0)) / exact_coverage)
    squared = sum((beta * beta for beta in grouped.values()), Decimal(0))
    exact_squared = sum((beta * beta for beta in exact_grouped.values()), Fraction(0))
    # Independent pair covariance expansion: repeated and overlapping endpoints
    # cancel through Kronecker deltas, without using the grouped beta dictionary.
    pair_covariance = sum((wa * wb * ((p == s) - (p == t) - (q == s) + (q == t))
                           for p, q, wa in paired_exact for s, t, wb in paired_exact), Fraction(0))
    pair_covariance /= exact_coverage * exact_coverage
    if exact_means != direct_means or sum(exact_grouped.values(), Fraction(0)) != 0:
        raise ArithmeticError('Exact pair grouping proof failed.')
    if pair_covariance != exact_squared:
        raise ArithmeticError('Exact pair covariance and grouped coefficients disagree.')
    expected = dict(zip(FIELDS, (*means, squared, coverage)))
    exact = dict(zip(FIELDS, (*exact_means, exact_squared, exact_coverage)))
    for name in FIELDS:
        truth = rational_decimal(exact[name])
        if abs(expected[name] - truth) > Decimal('1e-70') * (1 + abs(truth)):
            raise ArithmeticError('Decimal80 and independent rational construction disagree.')
    if 'analyticSumBetaSquared' in q and exact_squared != Fraction(q['analyticSumBetaSquared']):
        raise ArithmeticError('Declared analytic covariance disagrees with exact construction.')
    return {'decimal80': {name: str(v) for name, v in expected.items()},
            'exact': {name: str(v) for name, v in exact.items()},
            'beta': [[p, str(v)] for p, v in sorted(exact_grouped.items()) if v],
            'proof': {'pairwiseEqualsGrouped': True, 'coefficientSumZero': True,
                      'covarianceEqualsExact': True, 'positivePairs': len(paired)}}


def guard_reference(stats, spec):
    a, b = (Decimal(stats['decimal80'][name]) for name in ('meanA', 'meanB'))
    beta = Decimal(stats['decimal80']['sumBetaSquared'])
    va, vb, old = (decimal(spec[name]) for name in ('varianceA', 'varianceB', 'distance'))
    return max(old, a * a + b * b - (va + vb) * beta, Decimal(0))


def generate(group):
    specs = inputs(group)
    result = {'version': VERSION, 'license': 'CC0-1.0', 'precision': 80,
              'group': group, 'generatorSha256': digest(__file__),
              'inputPlanSha256': sha256(canonical(specs)).hexdigest(),
              'candidateImported': False, 'sources': []}
    for spec in specs:
        row = {**spec, 'queries': []}
        for q in spec['queries']:
            stats = direct_reference(spec, q)
            row['queries'].append({**q, 'reference': stats,
                **({'guardReferences': [str(guard_reference(stats, g)) for g in q['guards']]}
                   if 'guards' in q else {})})
        result['sources'].append(row)
    return result


def compare(reference, candidate):
    if reference['version'] != VERSION or reference['generatorSha256'] != digest(__file__):
        raise ValueError('Numerical reference version or generator hash changed.')
    if reference['candidateImported'] is not False:
        raise ValueError('Reference must be generated without a candidate import.')
    if reference['inputPlanSha256'] != sha256(canonical(inputs(reference['group']))).hexdigest():
        raise ValueError('Numerical source declaration changed.')
    declared_sources = [{**source_spec, 'queries': [
        {name: entry for name, entry in q.items() if name not in ('reference', 'guardReferences')}
        for q in source_spec['queries']]} for source_spec in reference['sources']]
    if declared_sources != inputs(reference['group']):
        raise ValueError('Reference payload differs from the declared feature/alpha words or queries.')
    spec = importlib.util.spec_from_file_location('checked_mean_guard_candidate', candidate)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    count = checked = guards = preserved = zero = 0
    minimum_coverage, maximum_ratio = math.inf, 0.0
    answers = {}
    for source_spec in reference['sources']:
        features = [[value(v) for v in p] for p in source_spec['featureWords']]
        alpha = [value(v) for v in source_spec['alphaWords']]
        actual_rows = []
        for q in source_spec['queries']:
            result = module.patch_mean_statistics(features, alpha, source_spec['width'], source_spec['height'],
                *q['center'], *q['offset'])
            if not isinstance(result, dict) or set(result) != set(FIELDS):
                raise AssertionError('Statistics helper must return the canonical four-field dictionary.')
            for name in FIELDS:
                actual, expected = result[name], float(Decimal(q['reference']['decimal80'][name]))
                if not isinstance(actual, (float, int)) or not math.isfinite(actual):
                    raise AssertionError(f'Nonfinite {source_spec["id"]}/{name}.')
                # Coverage and covariance need relative checks even for tiny alpha.
                bound = ((1e-300 if expected != 0 else 0.0) + 2e-12 * abs(expected)
                         if name in ('coverage', 'sumBetaSquared') else 2e-13 + 2e-12 * abs(expected))
                error = abs(actual - expected)
                ratio = error / bound if bound else (0.0 if error == 0 else math.inf)
                if error > bound:
                    raise AssertionError(f'{source_spec["id"]}/{q["center"]}/{q["offset"]}/{name}: {actual!r} != {expected!r}.')
                maximum_ratio = max(maximum_ratio, ratio)
                checked += 1
            if result['coverage'] > 0:
                minimum_coverage = min(minimum_coverage, result['coverage'])
            else:
                if any(v != 0 for v in result.values()):
                    raise AssertionError('Zero coverage must not publish a feature or covariance.')
                zero += 1
            for g, expected_text in zip(q.get('guards', []), q.get('guardReferences', [])):
                actual = module.guarded_chroma_distance(g['distance'], result, g['varianceA'], g['varianceB'])
                expected = float(Decimal(expected_text))
                if not math.isfinite(actual) or abs(actual - expected) > 2e-13 + 2e-12 * abs(expected):
                    raise AssertionError('Guard does not implement the declared Decimal80 distance formula.')
                if actual < g['distance'] or actual < 0:
                    raise AssertionError('Guard weakened the inherited corrected distance.')
                if expected <= g['distance']:
                    if struct.pack('>d', actual) != struct.pack('>d', g['distance']):
                        raise AssertionError('Inactive guard did not preserve the old Float64 distance word.')
                    preserved += 1
                guards += 1
            actual_rows.append(result)
            count += 1
        answers[source_spec['id']] = actual_rows
    equivalent = []
    if reference['group'] == 'alpha':
        for left, right in (('alpha-mixed-hidden-False', 'alpha-mixed-hidden-True'),
                            ('alpha-opaque-hidden-False', 'alpha-tiny-hidden-False')):
            for a, b in zip(answers[left], answers[right]):
                for name in ('meanA', 'meanB', 'sumBetaSquared'):
                    if abs(a[name] - b[name]) > 2e-13 + 2e-12 * abs(a[name]):
                        raise AssertionError('Hidden features or common alpha scaling changed normalized statistics.')
            equivalent.append([left, right])
    return {'status': 'passed', 'version': VERSION, 'group': reference['group'],
            'generatorSha256': digest(__file__), 'candidateSha256': digest(candidate),
            'configurations': count, 'statisticFieldsChecked': checked,
            'exactRationalGroupingProofs': count, 'guardChecks': guards,
            'inactiveDistanceWordsPreserved': preserved, 'zeroCoverageCases': zero,
            'minimumPositiveCoverage': None if math.isinf(minimum_coverage) else minimum_coverage,
            'maximumNormalizedStatisticsError': maximum_ratio, 'equivalencePairs': equivalent,
            'filterExecutions': 0, 'gpuExecutions': 0, 'adoptionClaim': False}


def publish(path, result):
    path = path.resolve()
    if not path.is_relative_to(ROOT / 'artifacts') or path.exists():
        raise ValueError('Choose a fresh output file under ignored artifacts/.')
    with path.open('x') as stream:
        stream.write(json.dumps(result, indent=2, allow_nan=False) + '\n')


def main():
    parser = ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--plan', action='store_true')
    modes.add_argument('--reference', action='store_true')
    modes.add_argument('--check', type=Path)
    parser.add_argument('--group', choices=GROUPS)
    parser.add_argument('--candidate', type=Path, default=HERE / 'mean-guard-patchwise.py')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if (args.plan or args.reference) and args.group is None:
        parser.error('--plan and --reference require an explicit numerical group.')
    if args.plan:
        if args.output:
            parser.error('--plan is artifact-free.')
        specs = inputs(args.group)
        print(json.dumps({'version': VERSION, 'group': args.group,
            'inputPlanSha256': sha256(canonical(specs)).hexdigest(), 'sources': len(specs),
            'configurations': sum(len(s['queries']) for s in specs),
            'candidateImported': False, 'filterExecutions': 0, 'gpuExecutions': 0}))
        return
    if args.output is None:
        parser.error('An explicit fresh --output under artifacts/ is required.')
    with localcontext() as context:
        context.prec = 80
        result = generate(args.group) if args.reference else compare(json.loads(args.check.read_text()), args.candidate)
    publish(args.output, result)
    print(json.dumps({'output': str(args.output.resolve()), 'sha256': digest(args.output),
                      'status': result.get('status', 'reference-created')}))


if __name__ == '__main__':
    main()
