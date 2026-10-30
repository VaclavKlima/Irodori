#!/usr/bin/env python3
"""Explicit, lock-guarded, artifact-only driver. No production code imports."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LOCK = ROOT/'artifacts/verification/.invocation-lock'
OUTPUT = ROOT/'artifacts/detail-research/strong-noise'
NOMINAL_STAGES = ('nominal','fresh-nominal','comparison4-nominal-regression','comparison7-nominal-regression')
DOSE_STAGES = ('dosage','dose-corners')


def hash_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as file:
        while chunk := file.read(1024*1024):
            h.update(chunk)
    return h.hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def json_file(path, value):
    Path(path).write_text(json.dumps(value,indent=2)+'\n')


def source_pins(protocol):
    names=[ACTIVE_PROTOCOL,HERE/protocol.get('mathModule','patchwise.py')]
    names += [HERE/name for name in ('patchwise.py','pixelwise.py','cases.py','dose-diagnostics.py','run.py','README.md')]
    names=list(dict.fromkeys(names))
    names += [ROOT/name for name in ('scripts/research/detail-candidates.py','scripts/research/color-reference.py','scripts/research/detail-reference.py','tests/fixtures/detail-reference.json','tests/fixtures/detail-quality.json','AGENTS.md','assets/README.md')]
    return [{'path':str(path),'sha256':hash_file(path)} for path in names]


def check_pins(items):
    for item in items:
        if hash_file(item['path']) != item['sha256']:
            raise RuntimeError('Frozen comparison source changed: '+item['path'])


def controls(recipe):
    if 'controls' in recipe:
        return tuple(recipe['controls'])
    name, amount = recipe['name'],recipe['strength']
    only_l = name.startswith('period-') or name in ('flat-luminance','stars')
    only_c = name == 'flat-chroma' or name.startswith('color-')
    return (0 if only_c else amount,0 if only_l else amount)


def identity_key(source_sha, width, height, coefficients, luminance, chroma, candidate):
    # Inactive coefficients do not affect output; active ones must match exactly.
    return (source_sha,width,height,coefficients,luminance,chroma,
        candidate['luminanceBandwidthMaximum'] if luminance else 0,
        candidate.get('chromaBandwidthMaximum',.16) if chroma else 0)


def historical_outputs(protocol):
    # Historical machine-local evidence stays ignored. Fresh reproduction never
    # invents an old source/output identity attestation from missing reports.
    return {}


def dose_interval_summary(items):
    groups = {}
    for item in items:
        recipe = item['recipe']
        l,c = controls(recipe)
        if recipe['name'] == 'mixed-flat':
            modes = ['equal'] if l == c else ['vary-luminance' if c == 50 else 'vary-chroma']
            if l == c == 50:
                modes += ['vary-luminance','vary-chroma']
        else:
            modes = ['scene']
        for mode in modes:
            key = (item['candidate']['id'],recipe['name'],recipe['sigma'],recipe['primaries'],mode)
            groups.setdefault(key,[]).append(item)
    rows = []
    for key,values in groups.items():
        values.sort(key=lambda item:item['recipe']['strength'])
        for before,after in zip(values,values[1:]):
            rows.append({'candidate':key[0],'scene':key[1],'sigma':key[2],'primaries':key[3],'mode':key[4],
                'amounts':[before['recipe']['strength'],after['recipe']['strength']],
                'effectRmsDecreases':[c for c in range(3) if after['metrics']['effectFeatureRms'][c] < before['metrics']['effectFeatureRms'][c]],
                'cleanResidualIncreases':[c for c in range(3) if after['metrics']['knownCleanResidualFeatureRms'][c] > before['metrics']['knownCleanResidualFeatureRms'][c]]})
    return {'interpretation':'Every adjacent selected interval reported. Descriptive only; no global monotonicity acceptance claim. Equal50 coincides with the two single-axis sweep anchors; the source/output row is retained once.',
        'intervals':rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--freeze',action='store_true')
    action.add_argument('--plan',action='store_true')
    action.add_argument('--execute',action='store_true')
    parser.add_argument('--declaration',type=Path)
    parser.add_argument('--comparison',choices=['7','8'],default='7')
    parser.add_argument('--stage',choices=['screen',*NOMINAL_STAGES,'high-noise','weak-stress',*DOSE_STAGES])
    parser.add_argument('--candidate',action='append')
    parser.add_argument('--scene',action='append')
    parser.add_argument('--seed',type=int,action='append')
    parser.add_argument('--primaries',action='append',choices=['srgb','rec2020'])
    parser.add_argument('--sigma',type=float,action='append')
    parser.add_argument('--strength',type=int,action='append')
    args = parser.parse_args()
    global ACTIVE_PROTOCOL,OUTPUT
    ACTIVE_PROTOCOL=HERE/('protocol.json' if args.comparison=='7' else 'comparison8.json')
    OUTPUT=ROOT/'artifacts/detail-research/strong-noise'/('comparison8' if args.comparison=='8' else '')
    protocol = json.loads(ACTIVE_PROTOCOL.read_text())
    if args.freeze:
        OUTPUT.mkdir(parents=True,exist_ok=True)
        destination = OUTPUT/('declaration-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
        with destination.open('x') as file:
            json.dump({'version':f'detail-comparison{args.comparison}-declaration-v1',
                'declaredAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'protocol':protocol,'sources':source_pins(protocol)},file,indent=2)
            file.write('\n')
        print(json.dumps({'declaration':str(destination),'sha256':hash_file(destination)}))
        return
    if not args.stage:
        parser.error('--stage is required for every plan or execution.')
    if args.stage in NOMINAL_STAGES and args.stage not in protocol['cohorts']:
        parser.error('This comparison does not declare that nominal cohort.')
    if args.stage in NOMINAL_STAGES and args.strength is not None and args.strength != [50]:
        parser.error('Nominal strengths are original scene-specific50; choose only --strength50 or omit it.')
    if args.stage in DOSE_STAGES and args.seed is not None and args.seed != [protocol['cohorts']['dosage']['seed']]:
        parser.error('Dose source seed is frozen independently from the amount.')
    candidate_ids = args.candidate or [candidate['id'] for candidate in protocol['candidates']]
    if len(set(candidate_ids)) != len(candidate_ids) or not set(candidate_ids) <= {candidate['id'] for candidate in protocol['candidates']}:
        parser.error('Choose distinct declared candidate IDs.')
    cases = load('comparison7_cases',HERE/'cases.py')
    selected = list(cases.selections(protocol,args.stage,args.scene,args.seed,args.primaries,args.sigma,args.strength))
    declared = list(cases.selections(protocol,args.stage))
    if not selected or any(row not in declared for row in selected):
        parser.error('Choose a nonempty subset of the frozen stage; new recipes need a new declaration.')
    if len({json.dumps(row,sort_keys=True) for row in selected}) != len(selected):
        parser.error('Repeated case selectors are not allowed.')
    plan = {'stage':args.stage,'candidateIds':candidate_ids,'caseCount':len(selected),
        'plannedMeasurements':len(selected)*len(candidate_ids),'selected':selected,
        'fullStageCaseCount':len(declared),
        'partial':len(selected)!=len(declared) or len(candidate_ids)!=len(protocol['candidates']),
        'adoptionClaim':False,
        'limits':'Independent Float64 chart screen/control diagnostics only. Decimal80/GPU/alpha-HDR/resource/native-photo proofs remain required; later stages need separate root review; no production adoption.'}
    if args.plan:
        print(json.dumps(plan,indent=2))
        return
    if not args.declaration:
        parser.error('--execute requires an explicitly reviewed --declaration.')
    declaration = json.loads(args.declaration.read_text())
    if declaration['protocol'] != protocol:
        raise RuntimeError('Current protocol differs from its declaration.')
    check_pins(declaration['sources'])
    token = str(uuid.uuid4())
    try:
        LOCK.parent.mkdir(parents=True,exist_ok=True)
        LOCK.mkdir()
    except FileExistsError:
        raise RuntimeError('An active verification/benchmark owns the invocation lock; do not run candidate math.')
    output = None
    started,completed = time.monotonic(),0
    try:
        OUTPUT.mkdir(parents=True,exist_ok=True)
        output = Path(tempfile.mkdtemp(prefix='run-',dir=OUTPUT))
        owner = {'pid':os.getpid(),'token':token,'artifacts':str(output),
            'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'kind':f'independent-noise-comparison{args.comparison}'}
        json_file(LOCK/'owner.json',owner)
        json_file(output/'owner.json',owner)
        json_file(output/'plan.json',plan)
        shutil.copyfile(args.declaration,output/'declaration.json')
        baseline = load('comparison7_baseline',ROOT/'scripts/research/detail-candidates.py')
        method = load('comparison_noise_aware',HERE/protocol.get('mathModule','patchwise.py'))
        dose = load('comparison7_dose',HERE/'dose-diagnostics.py')
        cases.verify_original_inputs(baseline)
        candidates = [c for c in protocol['candidates'] if c['id'] in candidate_ids]
        historical = historical_outputs(protocol)
        source_estimates,source_ranges,dose_sources = {},{},{}
        dose_rows,required_failures,identity_checks = [],[],0
        with (output/'results.jsonl').open('w') as stream:
            for case_index,recipe in enumerate(selected):
                case = cases.scene(baseline,**recipe)
                input_files = []
                for kind in ('clean','entering'):
                    path = output/f'case-{case_index}-{kind}.f32'
                    path.write_bytes(b''.join(struct.pack('<4f',*pixel) for pixel in case[kind]))
                    input_files.append({'kind':kind,'path':str(path),'sha256':hash_file(path)})
                source_sha = input_files[1]['sha256']
                coefficients = baseline.LUMINANCE[case['primaries']]
                cache_key = (source_sha,case['width'],case['height'],case['primaries'])
                if args.stage in DOSE_STAGES:
                    dose_source_key = (recipe['name'],recipe['seed'],recipe['primaries'],recipe['sigma'])
                    previous_sha = dose_sources.setdefault(dose_source_key,source_sha)
                    if previous_sha != source_sha:
                        raise RuntimeError('Changing a manual amount changed the frozen dose source words.')
                l,c = case['luminance'],case['chroma']
                if l or c:
                    if cache_key not in source_estimates:
                        features = [baseline.encode(pixel,coefficients) if pixel[3] > 0 else (0.0,0.0,0.0) for pixel in case['entering']]
                        source_estimates[cache_key] = method.estimate(features,[p[3] for p in case['entering']],case['width'],case['height'])
                    estimate_snapshot = source_estimates[cache_key]
                else:
                    estimate_snapshot = None
                if args.stage in DOSE_STAGES and cache_key not in source_ranges:
                    source_ranges[cache_key] = dose.ranges(baseline,case['entering'],case['width'],case['height'],coefficients)
                for candidate in candidates:
                    at = time.monotonic()
                    filtered,diagnostics = method.denoise(baseline,case['entering'],case['width'],case['height'],coefficients,l,c,candidate,
                        case['oracleVariance'],capture_deltas=args.stage in DOSE_STAGES,estimate_snapshot=estimate_snapshot)
                    bytes_ = b''.join(struct.pack('<4f',*pixel) for pixel in filtered)
                    output_path = output/f'case-{case_index}-{candidate["id"]}.f32'
                    output_path.write_bytes(bytes_)
                    output_sha = hashlib.sha256(bytes_).hexdigest()
                    identity_eligible = candidate['aggregation'] == 'pixelwise-comparator'
                    old = historical.get(identity_key(source_sha,case['width'],case['height'],case['primaries'],l,c,candidate)) if identity_eligible else None
                    identity_valid = True
                    if old is not None:
                        if hash_file(old['sourcePath']) != old['sourceSha256'] or hash_file(old['outputPath']) != old['sha256']:
                            raise RuntimeError('Historical source/output evidence changed; preserve the new output and investigate.')
                        identity_valid = output_sha == old['sha256']
                        identity_checks += 1
                    if args.stage in DOSE_STAGES:
                        deltas = diagnostics.pop('featureDeltas')
                        delta_path = output/f'case-{case_index}-{candidate["id"]}-deltas.f64'
                        delta_path.write_bytes(b''.join(struct.pack('<3d',*pixel) for pixel in deltas))
                        diagnostics['preInverseFeatureDeltas'] = {'path':str(delta_path),'sha256':hash_file(delta_path),'format':'LE Float64 L/A/B native row-major'}
                        result = dose.evaluate(baseline,case['entering'],case['clean'],filtered,deltas,source_ranges[cache_key],coefficients,l,c,candidate['blend'] != 'none',candidate['aggregation'] == 'normalized-patch-estimates-f32-zero-v1')
                        if l == c == 0:
                            result['gates']['neutralEstimatorBypassed'] = diagnostics.get('estimation') == 'neutral-bypass'
                    else:
                        result = cases.evaluate(baseline,case,filtered)
                    if old is not None:
                        result['gates']['matchingHistoricalOutputExact'] = identity_valid
                    item = {'recipe':recipe,'inputs':input_files,'candidate':candidate,'metrics':result,
                        'diagnostics':diagnostics,'historicalIdentity':old,
                        'float32OutputPath':str(output_path),'float32OutputSha256':output_sha,
                        'elapsedSeconds':time.monotonic()-at}
                    stream.write(json.dumps(item)+'\n')
                    stream.flush()
                    if args.stage in DOSE_STAGES:
                        dose_rows.append(item)
                    failures = [name for name,valid in result['gates'].items() if not valid]
                    if result['required'] and failures:
                        required_failures.append({'recipe':recipe,'candidate':candidate['id'],'gates':failures,
                            'adoptionCandidate':candidate.get('adoptionCandidate',candidate['aggregation'] == 'normalized-patch-estimates-f32-zero-v1')})
                    completed += 1
                    json_file(output/'progress.json',{'completed':completed,'planned':plan['plannedMeasurements'],
                        'last':{**recipe,'candidate':candidate['id']},'elapsedSeconds':time.monotonic()-started})
        if dose_rows:
            json_file(output/'dose-intervals.json',dose_interval_summary(dose_rows))
        check_pins(declaration['sources'])
        json_file(output/'summary.json',{'state':'research-complete-no-adoption','completed':completed,
            'plan':plan,'elapsedSeconds':time.monotonic()-started,'originalNominalInputsMatched':True,
            'historicalIdentityChecks':identity_checks,'requiredFailures':required_failures,
            'qualityPassIsNotAdoption':True})
        print(json.dumps({'output':str(output),'completed':completed,'requiredFailures':len(required_failures),'adoption':False}))
    except BaseException as error:
        if output is not None:
            json_file(output/'failure.json',{'error':repr(error),'completed':completed,'elapsedSeconds':time.monotonic()-started})
        raise
    finally:
        if (LOCK/'owner.json').exists():
            active = json.loads((LOCK/'owner.json').read_text())
            if active.get('token') != token:
                raise RuntimeError('Invocation ownership changed; preserving foreign lock.')
            (LOCK/'owner.json').unlink()
        LOCK.rmdir()


if __name__ == '__main__':
    main()
