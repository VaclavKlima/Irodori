#!/usr/bin/env python3
"""C9 input qualification only: no candidate, estimator or application imports."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROTOCOL = HERE / 'comparison9.json'
LOCK = ROOT / 'artifacts/verification/.invocation-lock'
OUTPUT = ROOT / 'artifacts/detail-research/strong-noise/comparison9'
VERSION = 'detail-comparison9-source-qualification-v1'
STAGE = 'fresh-population'


def hash_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def recipe_key(recipe):
    return json.dumps(recipe, sort_keys=True, separators=(',', ':'))


def expected_size(recipe):
    return (136, 136) if recipe.get('population') else (32, 24)


def projection_design(recipe, width, height):
    """IID input-noise uncertainty only, using the actual centered pattern energy."""
    period = int(recipe['name'].rsplit('-', 1)[1])
    pattern = [(-1 if x % 2 else 1) if period == 2 else math.sin(2 * math.pi * x / period)
               for _y in range(4, height - 4) for x in range(4, width - 4)]
    mean = math.fsum(pattern) / len(pattern)
    energy = math.fsum((value - mean) ** 2 for value in pattern)
    amplitude = .024 if period == 2 else .03
    relative_sd = recipe['sigma'] / (amplitude * math.sqrt(energy))
    return {'interpretation': 'IID Gaussian design approximation for entering projection, not nonlinear output uncertainty.',
            'metricSamples': len(pattern), 'centeredPatternEnergy': energy,
            'declaredAmplitude': amplitude, 'sigma': recipe['sigma'],
            'relativeProjectionStandardDeviation': relative_sd,
            'upperGateStandardDeviationsFromIdentity': .05 / relative_sd}


def declared_recipes(protocol, cases):
    """Require the entire fixed family; qualification offers no case selectors."""
    previous = json.loads((HERE / 'comparison8.json').read_text())
    if protocol.get('version') != 'detail-texture-population-comparison-9-v1':
        raise RuntimeError('Unsupported C9 source methodology.')
    if protocol['methodology']['algorithmProtocolSha256'] != hash_file(HERE / 'comparison8.json'):
        raise RuntimeError('The preserved C8 algorithm declaration changed.')
    for key in ('candidates', 'mathModule', 'unchangedGates'):
        if protocol[key] != previous[key]:
            raise RuntimeError('C9 must preserve the declared C8 algorithms and gates.')
    for name in ('nominal', 'comparison4-nominal-regression', 'comparison7-nominal-regression'):
        if protocol['cohorts'][name] != previous['cohorts'][name]:
            raise RuntimeError('A mandatory small-chart regression changed.')
    cohort = protocol['cohorts'][STAGE]
    if cohort['seeds'] != [0x85EBCA6B, 0xC2B2AE35] or cohort['sigma'] != [.012] or cohort['primaries'] != ['srgb', 'rec2020']:
        raise RuntimeError('The C9 fresh source seeds, noise or primaries changed.')
    if cohort['scenes'] != previous['cohorts']['fresh-nominal']['scenes']:
        raise RuntimeError('The complete fresh scene family changed.')
    if protocol['sourceQualification']['identityTextureGate'] != [.90, 1.05]:
        raise RuntimeError('The identity texture qualification limit changed.')
    records = list(cases.selections(protocol, STAGE))
    if len(records) != 64 or len({recipe_key(row) for row in records}) != 64:
        raise RuntimeError('Qualification requires all 64 distinct declared inputs.')
    if sum(bool(row.get('population')) for row in records) != 36:
        raise RuntimeError('Qualification requires 36 population textures and 28 unchanged small sources.')
    for row in records:
        if row['strength'] != 50 or row['high'] or row['weak'] or not row['fresh']:
            raise RuntimeError('Fresh population inputs must retain nominal controls and amplitudes.')
        if row.get('population') != (row['name'] in cases.POPULATION_SCENES):
            raise RuntimeError('Only the nine periodic texture recipes may change geometry.')
    return records


def check_declaration(path, protocol):
    declaration = json.loads(Path(path).read_text())
    if declaration.get('version') != 'detail-comparison9-declaration-v1' or declaration['protocol'] != protocol:
        raise RuntimeError('Qualification requires the same frozen C9 declaration.')
    pins = declaration['sources']
    paths = [Path(item['path']).resolve() for item in pins]
    required = [PROTOCOL, HERE / 'qualification.py', HERE / 'cases.py', HERE / 'run.py',
                HERE / 'comparison8.json', HERE / 'noise-scaled-patchwise.py',
                HERE / 'patchwise.py', HERE / 'pixelwise.py',
                ROOT / 'scripts/research/detail-candidates.py',
                ROOT / 'scripts/research/color-reference.py',
                ROOT / 'assets/tests/references/detail/strong-noise/texture-population.md']
    if len(set(paths)) != len(paths) or not set(required) <= set(paths):
        raise RuntimeError('The C9 declaration is missing required source pins.')
    for item in pins:
        if hash_file(item['path']) != item['sha256']:
            raise RuntimeError('Frozen C9 source changed: ' + item['path'])
    return declaration


def source_bytes(case):
    """Validate synthetic source shape before serializing, without filtering."""
    import struct
    count = case['width'] * case['height']
    result = {}
    for name in ('clean', 'entering'):
        values = case[name]
        if len(values) != count or any(len(p) != 4 or not all(math.isfinite(v) for v in p)
            or not 0 <= p[3] <= 1 for p in values):
            raise RuntimeError('Invalid or incomplete qualification source.')
        result[name] = b''.join(struct.pack('<4f', *p) for p in values)
    return result


def check_regenerated(case, recipe, records):
    key = recipe_key(recipe)
    if key not in records:
        raise RuntimeError('A fresh C9 source is absent from the whole-family qualification.')
    record = records[key]
    if (case['width'], case['height']) != (record['width'], record['height']):
        raise RuntimeError('Regenerated fresh source dimensions differ from qualification.')
    encoded = source_bytes(case)
    expected = {item['kind']: item['sha256'] for item in record['inputs']}
    for name, data in encoded.items():
        if hashlib.sha256(data).hexdigest() != expected[name]:
            raise RuntimeError('Regenerated fresh ' + name + ' source differs from qualification.')
    return {name: hashlib.sha256(data).hexdigest() for name, data in encoded.items()}


def validate_receipt(path, expected_sha256, declaration_path, protocol, cases):
    """Fail closed before a C9 runner imports its candidate implementation."""
    path = Path(path).resolve()
    if len(expected_sha256) != 64 or hash_file(path) != expected_sha256:
        raise RuntimeError('The explicitly reviewed qualification receipt SHA-256 differs.')
    check_declaration(declaration_path, protocol)
    wanted = declared_recipes(protocol, cases)
    receipt = json.loads(path.read_text())
    if (receipt.get('version') != VERSION or receipt.get('status') != 'qualified'
        or receipt.get('candidateFilteringPerformed') is not False
        or receipt.get('declarationSha256') != hash_file(Path(declaration_path))
        or receipt.get('protocolSha256') != hash_file(PROTOCOL)
        or receipt.get('completedSources') != 64 or receipt.get('failures') != []):
        raise RuntimeError('The complete C9 population was not successfully qualified.')
    if receipt.get('sources') != json.loads(Path(declaration_path).read_text())['sources']:
        raise RuntimeError('Qualification provenance differs from the frozen declaration.')
    records = {recipe_key(row['recipe']): row for row in receipt['records']}
    if len(receipt['records']) != 64 or set(records) != {recipe_key(row) for row in wanted}:
        raise RuntimeError('Qualification is partial, repeated or from another source family.')
    for recipe in wanted:
        record = records[recipe_key(recipe)]
        if (record['width'], record['height']) != expected_size(recipe) or record.get('sourceValid') is not True:
            raise RuntimeError('Qualification contains invalid source geometry.')
        if record.get('identityTextureApplicable') is not recipe['population']:
            raise RuntimeError('Qualification changed the declared texture population.')
        if recipe['population']:
            score = record.get('identityTextureRetention')
            if score is None or not math.isfinite(score) or not .90 <= score <= 1.05:
                raise RuntimeError('A population input fails the unchanged identity texture limit.')
        inputs = record['inputs']
        if len(inputs) != 2 or {item['kind'] for item in inputs} != {'clean', 'entering'}:
            raise RuntimeError('Qualification is missing a complete source pair.')
        for item in inputs:
            original_path = Path(item['path'])
            original = original_path.resolve()
            if original_path.is_symlink() or not original.is_relative_to(path.parent) or not original.is_file():
                raise RuntimeError('Missing retained qualification source; qualify again explicitly.')
            if (original.stat().st_size != record['width'] * record['height'] * 16
                or hash_file(original) != item['sha256']):
                raise RuntimeError('Retained qualification source changed.')
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--plan', action='store_true')
    action.add_argument('--execute', action='store_true')
    parser.add_argument('--declaration', type=Path)
    args = parser.parse_args()
    protocol = json.loads(PROTOCOL.read_text())
    cases = load('qualification_cases_only', HERE / 'cases.py')
    recipes = declared_recipes(protocol, cases)
    plan = {'stage': STAGE, 'allSourceCount': len(recipes),
        'populationTextureCount': 36, 'unchangedSmallCount': 28,
        'identityTextureGate': [.90, 1.05],
        'recipes': [{'recipe': row, 'dimensions': list(expected_size(row))} for row in recipes],
        'candidateImports': False, 'filterOutputs': False, 'qualificationIsNotAdoption': True}
    if args.plan:
        print(json.dumps(plan, indent=2))
        return 0
    if args.declaration is None:
        parser.error('--execute requires the reviewed frozen C9 --declaration.')
    declaration = check_declaration(args.declaration, protocol)
    token = str(uuid.uuid4())
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    try:
        LOCK.mkdir()
    except FileExistsError:
        raise RuntimeError('An existing verification or research invocation owns the lock.')
    output, completed = None, 0
    started = time.monotonic()
    def interrupted(_number, _frame):
        raise KeyboardInterrupt('C9 source qualification interrupted.')
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix='qualification-', dir=OUTPUT))
        owner = {'pid': os.getpid(), 'token': token, 'artifacts': str(output),
                 'kind': 'comparison9-source-qualification',
                 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        save(LOCK / 'owner.json', owner)
        save(output / 'owner.json', owner)
        save(output / 'plan.json', plan)
        check_declaration(args.declaration, protocol)
        # This is the only computational model imported: source construction,
        # feature coordinates and the already declared clean projection metric.
        model = load('qualification_baseline_only', ROOT / 'scripts/research/detail-candidates.py')
        cases.verify_original_inputs(model)
        records, failures = [], []
        for index, recipe in enumerate(recipes):
            case = cases.scene(model, **recipe)
            if (case['width'], case['height']) != expected_size(recipe):
                raise RuntimeError('Qualification source does not have its declared geometry.')
            encoded = source_bytes(case)
            inputs = []
            for name, data in encoded.items():
                path = output / f'case-{index}-{name}.f32'
                path.write_bytes(data)
                inputs.append({'kind': name, 'path': str(path), 'sha256': hash_file(path)})
            record = {'recipe': recipe, 'width': case['width'], 'height': case['height'],
                'sourceValid': True, 'inputs': inputs, 'identityTextureApplicable': recipe['population'],
                'identityTextureRetention': None}
            if recipe['population']:
                record['projectionDesign'] = projection_design(recipe, case['width'], case['height'])
                metrics = cases.evaluate(model, case, case['entering'])
                record['identityTextureRetention'] = metrics['textureRetention']
                record['identityTextureMetrics'] = metrics
                if not all(metrics['gates'].values()):
                    failures.append({'recipe': recipe, 'gates': metrics['gates']})
            records.append(record)
            completed += 1
            save(output / 'progress.json', {'completedSources': completed, 'requiredSources': 64,
                                          'baselineFailures': len(failures), 'filteringPerformed': False})
        check_declaration(args.declaration, protocol)
        receipt = {'version': VERSION, 'status': 'failed' if failures else 'qualified',
            'declarationSha256': hash_file(args.declaration), 'protocolSha256': hash_file(PROTOCOL),
            'candidateFilteringPerformed': False, 'completedSources': completed,
            'elapsedSeconds': time.monotonic() - started, 'sources': declaration['sources'],
            'plan': plan, 'records': records, 'failures': failures,
            'limits': 'Input measurement qualification only; no denoiser, estimator or photographic acceptance.'}
        receipt_path = output / 'receipt.json'
        save(receipt_path, receipt)
        save(output / 'summary.json', {key: value for key, value in receipt.items() if key not in ('records', 'sources', 'plan')})
        (output / 'summary.md').write_text(
            '# C9 input qualification: ' + receipt['status'].upper() + '\n\n'
            + f'{completed}/64 complete sources; 36 population textures, 28 unchanged small sources.\n'
            + f'{len(failures)} identity texture baseline failures; {receipt["elapsedSeconds"]:.2f} seconds.\n\n'
            + 'Candidate code was not imported. No estimator or filtering was performed.\n'
            + 'Any baseline failure blocks the entire C9 study; no alternate seeds or passing subset.\n\n'
            + 'Receipt SHA-256: `' + hash_file(receipt_path) + '`.\n'
            + 'Input qualification does not accept a denoiser or rescind C8 failures.\n')
        print(json.dumps({'receipt': str(receipt_path), 'sha256': hash_file(receipt_path),
                          'status': receipt['status'], 'completedSources': completed,
                          'baselineFailures': len(failures), 'adoption': False}))
        return 1 if failures else 0
    except BaseException as error:
        if output is not None:
            save(output / 'failure.json', {'error': repr(error), 'completedSources': completed,
                                          'candidateFilteringPerformed': False})
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        owner_path = LOCK / 'owner.json'
        if owner_path.exists():
            owner = json.loads(owner_path.read_text())
            if owner.get('token') != token:
                raise RuntimeError('Invocation ownership changed; preserving foreign lock.')
            owner_path.unlink()
        LOCK.rmdir()


if __name__ == '__main__':
    raise SystemExit(main())
