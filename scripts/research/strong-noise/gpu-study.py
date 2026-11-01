#!/usr/bin/env python3
"""Frozen, sequential GPU research; unchanged C9 recipes and gates, no adoption."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import queue
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROTOCOL = HERE / 'comparison9.json'
OUTPUT = ROOT / 'artifacts/detail-research/strong-noise/comparison9-gpu'
LOCK = ROOT / 'artifacts/verification/.invocation-lock'
VERSION = 'detail-comparison9-gpu-declaration-v1'
STAGES = ('screen', 'nominal', 'comparison4-nominal-regression',
          'comparison7-nominal-regression', 'fresh-population', 'high-noise', 'weak-stress')
CANDIDATES = ('noise-scaled-k55', 'noise-scaled-k40')


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def save(path, value):
    AUDIT.atomic_json(path, value)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AUDIT = load('strong_noise_study_audit', HERE / 'study-audit.py')


def key(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def pins(paths):
    return [{'path': str(path), 'sha256': digest(path)}
            for path in sorted({Path(p).resolve() for p in paths})]


def check_pins(items):
    if len({item['path'] for item in items}) != len(items):
        raise RuntimeError('Repeated frozen GPU study source pins.')
    for item in items:
        if digest(item['path']) != item['sha256']:
            raise RuntimeError('Frozen GPU study input changed: ' + item['path'])


def default_node():
    operating_system = {'Darwin': 'darwin', 'Linux': 'linux', 'Windows': 'win'}.get(platform.system())
    architecture = {'x86_64': 'x64', 'AMD64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if not operating_system or not architecture:
        raise RuntimeError('Select a supported bundled Node 24 executable explicitly with --node.')
    package = ROOT / 'node_modules' / f'node-{operating_system}-{architecture}'
    return package / ('bin/node' if operating_system != 'win' else 'bin/node.exe')


def environment():
    result = dict(os.environ)
    # A frozen executable must not acquire injected modules or debug listeners.
    result.pop('NODE_OPTIONS', None)
    result.pop('NODE_PATH', None)
    return result


class Invocation:
    """Release only the lock whose unique owner token this invocation wrote."""
    def __init__(self, kind):
        self.token, self.kind = str(uuid.uuid4()), kind
        self.acquired = False

    def __enter__(self):
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        try:
            LOCK.mkdir()
        except FileExistsError:
            raise RuntimeError('Another verification or research invocation owns the lock.') from None
        self.acquired = True
        save(LOCK / 'owner.json', {'pid': os.getpid(), 'token': self.token,
             'kind': self.kind, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        return self

    def __exit__(self, *_error):
        if self.acquired:
            owner = LOCK / 'owner.json'
            if not owner.exists() or json.loads(owner.read_text()).get('token') != self.token:
                raise RuntimeError('Invocation ownership changed; preserving the foreign lock.')
            owner.unlink()
            LOCK.rmdir()


def stop_child(child):
    if child is None:
        return
    if child.stdin is not None and not child.stdin.closed:
        try:
            child.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def build_child(node, destination):
    child = None
    try:
        with (destination / 'build-stdout.txt').open('w') as stdout, (destination / 'build-stderr.txt').open('w') as stderr:
            child = subprocess.Popen([str(node), str(HERE / 'build-gpu-child.mjs'), str(destination)],
                                     cwd=ROOT, env=environment(), stdin=subprocess.DEVNULL,
                                     stdout=stdout, stderr=stderr)
            if child.wait(timeout=120) != 0:
                raise RuntimeError('GPU child build failed; preserve its build logs.')
    finally:
        stop_child(child)
    bundle, metadata = destination / 'bundle.cjs', destination / 'metafile.json'
    if not bundle.is_file() or not metadata.is_file():
        raise RuntimeError('GPU child build did not publish its bundle and metafile.')
    inputs = []
    for name in json.loads(metadata.read_text())['inputs']:
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise RuntimeError('Unsupported or missing esbuild source input: ' + name)
        inputs.append(path)
    if not inputs:
        raise RuntimeError('The GPU child build has no pinned source inputs.')
    return bundle, metadata, inputs


def selected_plan(args, protocol, cases):
    if args.stage is None:
        raise RuntimeError('--stage is required for --plan and --freeze.')
    if args.stage in ('nominal', 'fresh-population', 'comparison4-nominal-regression', 'comparison7-nominal-regression'):
        if args.strength is not None and args.strength != [50]:
            raise RuntimeError('Nominal cohorts retain their original scene-specific strength 50 controls.')
    identities = args.candidate or ['noise-scaled-k55']
    if len(set(identities)) != len(identities) or not set(identities) <= set(CANDIDATES):
        raise RuntimeError('Choose distinct declared noise-scaled-k55/k40 candidates.')
    candidates = [candidate for candidate in protocol['candidates'] if candidate['id'] in identities]
    if {item['id'] for item in candidates} != set(identities):
        raise RuntimeError('A selected noise-scaled policy is missing from C9.')
    for candidate in candidates:
        if (candidate['aggregation'] != 'normalized-patch-estimates-f32-zero-v1'
            or candidate['bandwidthPolicy'] != 'global-chroma-sigma-floor-v1'
            or candidate['luminanceBandwidthMaximum'] != .024
            or candidate['chromaBandwidthMaximum'] != .024
            or candidate['chromaSigmaFactor'] not in (.4, .55)):
            raise RuntimeError('The research child does not implement this candidate declaration.')
    declared = list(cases.selections(protocol, args.stage))
    selected = list(cases.selections(protocol, args.stage, args.scene, args.seed,
                                   args.primaries, args.sigma, args.strength))
    if not selected or any(row not in declared for row in selected):
        raise RuntimeError('Select a nonempty subset of the frozen C9 stage; no new recipes.')
    if len({key(row) for row in selected}) != len(selected):
        raise RuntimeError('Repeated source selectors are not permitted.')
    return {'stage': args.stage, 'selected': selected, 'candidates': candidates,
            'caseCount': len(selected), 'fullStageCaseCount': len(declared),
            'plannedMeasurements': len(selected) * len(candidates),
            'partialStage': len(selected) != len(declared),
            'unselectedCandidatesIncomplete': [item for item in CANDIDATES if item not in identities],
            'allC9StagesComplete': False, 'adoptionClaim': False,
            'requestTimeoutSeconds': args.request_timeout if args.request_timeout is not None else 120,
            'limits': 'Unadopted noise-only GPU research. Original C9 gates and labels remain mandatory. '
                      'Quality and RGB equivalence do not establish exact stage words, native photographic quality, '
                      'dosage bounds, full-source resource admission, sustained cadence or public v2 readiness.'}


def validate_estimator(snapshot, width, height):
    """Validate the independent CPU receipt schema without recomputing its policy."""
    if (snapshot.get('version') != 'frozen-global-directional-mad-v1'
        or type(snapshot.get('available')) is not bool or len(snapshot.get('directions', [])) != 4):
        raise RuntimeError('CPU evidence is missing the full frozen estimator descriptor.')
    for name in ('sigma', 'variance'):
        if len(snapshot.get(name, [])) != 3 or any(not math.isfinite(value) or value < 0 for value in snapshot[name]):
            raise RuntimeError('CPU evidence has invalid final estimator coefficients.')
    for row, direction in zip(snapshot['directions'], ([1, 0], [0, 1], [1, 1], [1, -1])):
        available = (width - abs(direction[0])) * (height - abs(direction[1]))
        if (row.get('direction') != direction or row.get('availablePairs') != available
            or row.get('stratifiedPairs') != min(65536, available)
            or type(row.get('validPairs')) is not int or not 0 <= row['validPairs'] <= row['stratifiedPairs']):
            raise RuntimeError('CPU evidence has invalid per-direction estimator coverage.')
        for name in ('centers', 'sigma'):
            if len(row.get(name, [])) != 3 or any(value is not None and
                (not math.isfinite(value) or (name == 'sigma' and value < 0)) for value in row[name]):
                raise RuntimeError('CPU evidence has invalid per-direction estimator statistics.')


def cpu_evidence(path, plan, cpu_declaration):
    if path is None:
        return None, []
    path = path.resolve()
    summary_path, rows_path, declaration_path = (path / name for name in ('summary.json', 'results.jsonl', 'declaration.json'))
    summary = json.loads(summary_path.read_text())
    rows = [json.loads(line) for line in rows_path.read_text().splitlines() if line.strip()]
    if (summary.get('state') != 'research-complete-no-adoption'
        or summary.get('completed') != len(rows)
        or digest(declaration_path) != digest(cpu_declaration)):
        raise RuntimeError('CPU evidence must be a complete terminal run from this C9 declaration.')
    references, files = [], [summary_path, rows_path, declaration_path]
    for recipe in plan['selected']:
        for candidate in plan['candidates']:
            matching = [row for row in rows if row['recipe'] == recipe and row['candidate'] == candidate]
            if len(matching) != 1:
                raise RuntimeError('CPU evidence is missing or repeats a selected recipe/candidate: ' + key(recipe))
            row = matching[0]
            width, height = (136, 136) if recipe['high'] or recipe.get('population') else (32, 24)
            if len(row['inputs']) != 2 or {item['kind'] for item in row['inputs']} != {'clean', 'entering'}:
                raise RuntimeError('CPU evidence is missing its retained source pair.')
            inputs = {}
            for item in row['inputs']:
                original = Path(item['path']).resolve()
                if (not original.is_relative_to(path) or original.stat().st_size != width * height * 16
                    or digest(original) != item['sha256']):
                    raise RuntimeError('CPU evidence source changed or escaped its run directory.')
                files.append(original)
                inputs[item['kind']] = {'path': str(original), 'sha256': item['sha256']}
            actual = Path(row['float32OutputPath']).resolve()
            if (not actual.is_relative_to(path) or actual.stat().st_size != width * height * 16
                or digest(actual) != row['float32OutputSha256']):
                raise RuntimeError('CPU evidence output changed or escaped its run directory.')
            files.append(actual)
            estimator = row.get('diagnostics', {}).get('estimator', {})
            validate_estimator(estimator, width, height)
            references.append({'recipe': recipe, 'candidate': candidate, 'inputs': inputs,
                               'output': {'path': str(actual), 'sha256': row['float32OutputSha256']},
                               'estimator': estimator,
                               'estimatorSource': {'width': width, 'height': height,
                                    'identity': inputs['entering']['sha256'], 'sha256': inputs['entering']['sha256'],
                                    'primaries': recipe['primaries']}})
    return {'directory': str(path), 'references': references,
            'qualityFailuresRetained': summary.get('requiredFailures', []),
            'agreement': {'absolute': 2e-6, 'relative': 2e-5, 'alpha': 'exact binary32 words',
                          'estimatorAbsolute': 2e-12, 'estimatorRelative': 2e-11}}, files


def validate_declaration(path, qualification, cases, protocol):
    declaration = json.loads(path.read_text())
    if declaration.get('version') != VERSION or declaration['protocol'] != protocol:
        raise RuntimeError('GPU declaration is missing or belongs to another protocol.')
    check_pins(declaration['sources'])
    runtime = declaration['runtime']
    if runtime['python'] != sys.version or runtime['pythonExecutable'] != str(Path(sys.executable).resolve()):
        raise RuntimeError('Execute with the same pinned Python runtime used to freeze the study.')
    cpu = declaration['cpuDeclaration']
    if digest(cpu['path']) != cpu['sha256']:
        raise RuntimeError('Frozen CPU C9 declaration changed.')
    receipt = declaration['qualification']
    qualified = qualification.validate_receipt(Path(receipt['path']), receipt['sha256'],
                                               Path(cpu['path']), protocol, cases)
    plan = declaration['plan']
    declared = list(cases.selections(protocol, plan['stage']))
    if (not plan['selected'] or any(row not in declared for row in plan['selected'])
        or len({key(row) for row in plan['selected']}) != len(plan['selected'])
        or plan['fullStageCaseCount'] != len(declared)
        or plan['caseCount'] != len(plan['selected'])
        or plan['plannedMeasurements'] != len(plan['selected']) * len(plan['candidates'])
        or not plan['candidates']
        or len({item['id'] for item in plan['candidates']}) != len(plan['candidates'])
        or any(item not in protocol['candidates'] or item['id'] not in CANDIDATES for item in plan['candidates'])
        or not 5 <= plan['requestTimeoutSeconds'] <= 900):
        raise RuntimeError('The frozen GPU selection is not an exact declared C9 subset.')
    cpu_pins = json.loads(Path(cpu['path']).read_text())['sources']
    required = {Path(item['path']).resolve() for item in cpu_pins}
    required.update(Path(value).resolve() for value in (Path(__file__), HERE / 'gpu.ts', HERE / 'gpu-wgsl.ts',
                    HERE / 'gpu-child.ts', HERE / 'build-gpu-child.mjs', HERE / 'study-audit.py', ROOT / 'package-lock.json',
                    cpu['path'], receipt['path'], runtime['node'], runtime['pythonExecutable'],
                    declaration['build']['bundle'], declaration['build']['metafile']))
    if declaration['cpuEvidence'] is not None:
        evidence = declaration['cpuEvidence']
        reconstructed, _files = cpu_evidence(Path(evidence['directory']), plan, Path(cpu['path']))
        if evidence != reconstructed:
            raise RuntimeError('Frozen CPU evidence descriptor differs from its pinned result rows.')
        required.update(Path(evidence['directory']) / name for name in ('summary.json', 'results.jsonl', 'declaration.json'))
        matches = {(key(row['recipe']), row['candidate']['id']) for row in evidence['references']}
        wanted = {(key(recipe), candidate['id']) for recipe in plan['selected'] for candidate in plan['candidates']}
        if len(evidence['references']) != len(wanted) or matches != wanted:
            raise RuntimeError('Frozen CPU evidence does not cover every selected measurement exactly once.')
        for row in evidence['references']:
            required.add(Path(row['output']['path']))
            required.update(Path(item['path']) for item in row['inputs'].values())
            width, height = (136, 136) if row['recipe']['high'] or row['recipe'].get('population') else (32, 24)
            validate_estimator(row['estimator'], width, height)
            if row['estimatorSource'] != {'width': width, 'height': height,
                'identity': row['inputs']['entering']['sha256'], 'sha256': row['inputs']['entering']['sha256'],
                'primaries': row['recipe']['primaries']}:
                raise RuntimeError('Frozen CPU estimator source provenance differs from its input words.')
    if not required <= {Path(item['path']).resolve() for item in declaration['sources']}:
        raise RuntimeError('The GPU declaration is missing a required runtime, source or evidence pin.')
    return declaration, qualified


def freeze(args, protocol, cases, qualification, plan):
    if args.cpu_declaration is None or args.qualification is None or args.qualification_sha256 is None:
        raise RuntimeError('--freeze requires --cpu-declaration, --qualification and --qualification-sha256.')
    cpu_path, receipt_path = args.cpu_declaration.resolve(), args.qualification.resolve()
    qualification.validate_receipt(receipt_path, args.qualification_sha256, cpu_path, protocol, cases)
    cpu = qualification.check_declaration(cpu_path, protocol)
    evidence, evidence_files = cpu_evidence(args.cpu_evidence, plan, cpu_path)
    node = (args.node or default_node()).resolve()
    with Invocation('comparison9-gpu-freeze'):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix='declaration-', dir=OUTPUT))
        try:
            runtime_version = subprocess.check_output([str(node), '--version'], cwd=ROOT,
                                                      env=environment(), timeout=15, text=True).strip()
            if not runtime_version.startswith('v24.'):
                raise RuntimeError('Select the bundled Node 24 runtime for GPU research.')
            # Dawn is external to the bundle; esbuild also launches an installed
            # native executable. Bind both packages before the build starts.
            runtime_files = [path for package in ('webgpu', 'esbuild', '@esbuild')
                             for path in (ROOT / 'node_modules' / package).rglob('*') if path.is_file()]
            node_package = node.parent.parent / 'package.json'
            if node_package.is_file():
                runtime_files.append(node_package)
            if not (ROOT / 'node_modules/webgpu/package.json').is_file():
                raise RuntimeError('The external Dawn runtime is not installed.')
            initial = pins([item['path'] for item in cpu['sources']] +
                           [Path(__file__), HERE / 'gpu.ts', HERE / 'gpu-wgsl.ts',
                            HERE / 'gpu-child.ts', HERE / 'build-gpu-child.mjs', HERE / 'study-audit.py',
                            ROOT / 'package-lock.json', cpu_path, receipt_path, node,
                            Path(sys.executable).resolve(), *evidence_files, *runtime_files])
            # Freeze actual esbuild inputs on both sides of the build. The broad
            # pre-read is discarded; only the bundle's real input graph is retained.
            before_build = {path.resolve(): digest(path) for folder in (ROOT / 'src', ROOT / 'scripts')
                            for path in folder.rglob('*.ts') if path.is_file()}
            bundle, metadata, inputs = build_child(node, destination)
            if any(path not in before_build or digest(path) != before_build[path] for path in inputs):
                raise RuntimeError('An esbuild source changed during the build or was not captured before it.')
            check_pins(initial)
            qualification.validate_receipt(receipt_path, args.qualification_sha256, cpu_path, protocol, cases)
            legal = sorted(destination.glob('bundle.cjs.LEGAL.txt'))
            sources = pins([Path(item['path']) for item in initial] + inputs + runtime_files + [bundle, metadata, *legal])
            declaration = {'version': VERSION, 'declaredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           'protocol': protocol, 'plan': plan,
                           'cpuDeclaration': {'path': str(cpu_path), 'sha256': digest(cpu_path)},
                           'qualification': {'path': str(receipt_path), 'sha256': args.qualification_sha256},
                           'runtime': {'node': str(node), 'version': runtime_version,
                                       'python': sys.version, 'pythonExecutable': str(Path(sys.executable).resolve()),
                                       'platform': platform.platform()},
                           'build': {'bundle': str(bundle), 'metafile': str(metadata),
                                     'legalComments': [str(path) for path in legal]},
                           'cpuEvidence': evidence, 'sources': sources, 'adoptionClaim': False}
            path = destination / 'declaration.json'
            save(path, declaration)
            print(json.dumps({'declaration': str(path), 'sha256': digest(path),
                              'plannedMeasurements': plan['plannedMeasurements'], 'adoption': False}))
        except BaseException as error:
            save(destination / 'failure.json', {'error': repr(error), 'filteringPerformed': False})
            raise


class GpuChild:
    def __init__(self, node, bundle, run_root, stderr):
        self.messages = queue.Queue()
        self.child = subprocess.Popen([node, str(bundle), str(run_root)], cwd=ROOT, env=environment(),
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                      text=True, encoding='utf-8', bufsize=1)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            while True:
                line = self.child.stdout.readline(1024 * 1024 + 1)
                if not line:
                    self.messages.put(RuntimeError('GPU child closed stdout before a reply.'))
                    return
                if len(line) > 1024 * 1024 or not line.endswith('\n'):
                    raise RuntimeError('GPU child returned an oversized or incomplete JSON line.')
                self.messages.put(json.loads(line))
        except BaseException as error:
            self.messages.put(error)

    def request(self, request, timeout):
        self.child.stdin.write(json.dumps(request, allow_nan=False) + '\n')
        self.child.stdin.flush()
        try:
            reply = self.messages.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError('GPU child request timed out; preserve its stderr and partial outputs.') from None
        if isinstance(reply, BaseException):
            raise reply
        if not isinstance(reply, dict) or reply.get('id') != request['id']:
            raise RuntimeError('GPU child returned an unexpected request identity.')
        if reply.get('error') is not None:
            raise RuntimeError('GPU child refused request: ' + str(reply['error']))
        return reply

    def close(self):
        stop_child(self.child)
        self.reader.join(timeout=2)
        self.child.stdout.close()
        if self.reader.is_alive():
            raise RuntimeError('GPU child stdout reader did not retire after process exit.')
        if self.child.returncode != 0:
            raise RuntimeError('GPU child did not close successfully: ' + str(self.child.returncode))


def compare_estimator(reference, actual, source):
    differences, checked, worst = [], 0, 0.
    def exact(name, value, wanted):
        if value != wanted or type(value) is not type(wanted):
            differences.append({'field': name, 'actual': value, 'reference': wanted})
    def numeric(name, value, wanted):
        nonlocal checked, worst
        if value is None or wanted is None:
            exact(name, value, wanted)
            return
        checked += 1
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            differences.append({'field': name, 'actual': repr(value), 'reference': wanted})
            return
        ratio = abs(value - wanted) / (2e-12 + 2e-11 * abs(wanted))
        worst = max(worst, ratio)
        if ratio > 1:
            differences.append({'field': name, 'actual': value, 'reference': wanted, 'normalizedError': ratio})
    for name, wanted in source.items():
        exact('source.' + name, actual.get('source', {}).get(name), wanted)
    for name in ('version', 'available'):
        exact(name, actual.get(name), reference[name])
    for name in ('sigma', 'variance'):
        values = actual.get(name, [])
        exact(name + '.length', len(values), 3)
        for index, wanted in enumerate(reference[name]):
            numeric(f'{name}[{index}]', values[index] if index < len(values) else None, wanted)
    rows = actual.get('directions', [])
    exact('directions.length', len(rows), len(reference['directions']))
    for index, wanted in enumerate(reference['directions']):
        row = rows[index] if index < len(rows) else {}
        for name in ('direction', 'availablePairs', 'stratifiedPairs', 'validPairs'):
            exact(f'directions[{index}].{name}', row.get(name), wanted[name])
        for name in ('centers', 'sigma'):
            values = row.get(name, [])
            exact(f'directions[{index}].{name}.length', len(values), 3)
            for component, value in enumerate(wanted[name]):
                numeric(f'directions[{index}].{name}[{component}]',
                        values[component] if component < len(values) else None, value)
    return {'passed': not differences, 'numericValuesCompared': checked,
            'maximumNormalizedError': worst, 'mismatchCount': len(differences), 'mismatches': differences,
            'tolerance': '2e-12 + 2e-11 * abs(reference); metadata and counts exact'}


def compare_cpu(evidence, recipe, candidate, inputs, output_bytes, width, height, estimate):
    if evidence is None:
        return None
    matches = [row for row in evidence['references'] if row['recipe'] == recipe and row['candidate'] == candidate]
    if len(matches) != 1:
        raise RuntimeError('A frozen CPU comparison row is missing or repeated.')
    row = matches[0]
    if {item['kind']: item['sha256'] for item in inputs} != {kind: item['sha256'] for kind, item in row['inputs'].items()}:
        raise RuntimeError('GPU source words differ from the selected CPU evidence.')
    expected = Path(row['output']['path']).read_bytes()
    if len(expected) != width * height * 16 or hashlib.sha256(expected).hexdigest() != row['output']['sha256']:
        raise RuntimeError('Frozen CPU output is missing, changed or has different dimensions.')
    differences, examples, worst, alpha_differences = 0, [], 0., 0
    for index, (actual, reference) in enumerate(zip(struct.iter_unpack('<f', output_bytes), struct.iter_unpack('<f', expected))):
        at = index * 4
        if index % 4 == 3:
            if output_bytes[at:at + 4] != expected[at:at + 4]:
                alpha_differences += 1
            continue
        value, wanted = actual[0], reference[0]
        finite = math.isfinite(value) and math.isfinite(wanted)
        ratio = abs(value - wanted) / (2e-6 + 2e-5 * abs(wanted)) if finite else None
        if ratio is not None:
            worst = max(worst, ratio)
        if ratio is None or ratio > 1:
            differences += 1
            if len(examples) < 16:
                examples.append({'pixel': index // 4, 'channel': index % 4,
                                 'actual': value if math.isfinite(value) else repr(value),
                                 'reference': wanted if math.isfinite(wanted) else repr(wanted), 'normalizedError': ratio})
    estimator = compare_estimator(row['estimator'], estimate, row['estimatorSource'])
    rgb_and_alpha = differences == alpha_differences == 0
    return {'passed': rgb_and_alpha and estimator['passed'], 'rgbAndAlphaPassed': rgb_and_alpha,
            'estimator': estimator, 'checkedRgbChannels': width * height * 3,
            'rgbMismatches': differences, 'alphaWordMismatches': alpha_differences,
            'maximumNormalizedError': worst, 'examples': examples, 'cpuOutput': row['output']}


def execute(args, protocol, cases, qualification):
    if args.declaration is None:
        raise RuntimeError('--execute requires an explicitly reviewed --declaration.')
    if any(getattr(args, name) is not None for name in ('stage', 'candidate', 'scene', 'seed', 'sigma', 'primaries', 'strength',
                                                     'cpu_declaration', 'qualification', 'qualification_sha256', 'cpu_evidence', 'node', 'request_timeout')):
        raise RuntimeError('Execute uses only its frozen declaration; selection and provenance overrides are forbidden.')
    path = args.declaration.resolve()
    declaration_sha = digest(path)
    declaration, qualified = validate_declaration(path, qualification, cases, protocol)
    plan = declaration['plan']
    started, completed, output, child = time.monotonic(), 0, None, None
    failures, agreements = [], []
    live_audit = AUDIT.RowAudit(plan, declaration['cpuEvidence'] is not None)
    execution_state = 'running'
    with Invocation('comparison9-gpu-study') as invocation:
        try:
            OUTPUT.mkdir(parents=True, exist_ok=True)
            output = Path(tempfile.mkdtemp(prefix='run-', dir=OUTPUT))
            save(output / 'plan.json', plan)
            save(output / 'owner.json', {'pid': os.getpid(), 'token': invocation.token,
                                       'kind': 'comparison9-gpu-study', 'artifacts': str(output)})
            shutil.copyfile(path, output / 'declaration.json')
            shutil.copyfile(declaration['qualification']['path'], output / 'qualification.json')
            save(output / 'source-pins.json', declaration['sources'])
            save(output / 'provenance.json', {'gpuDeclaration': str(path), 'sha256': declaration_sha})
            for item in declaration['sources']:
                original = Path(item['path'])
                if original.is_relative_to(ROOT) and not original.is_relative_to(ROOT / 'node_modules') and not original.is_relative_to(ROOT / 'artifacts'):
                    archived = output / 'sources' / original.relative_to(ROOT)
                    archived.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(original, archived)
            bundle = output / 'bundle.cjs'
            shutil.copyfile(declaration['build']['bundle'], bundle)
            shutil.copyfile(declaration['build']['metafile'], output / 'metafile.json')
            for legal in declaration['build']['legalComments']:
                shutil.copyfile(legal, output / Path(legal).name)
            baseline = load('gpu_study_baseline', ROOT / 'scripts/research/detail-candidates.py')
            cases.verify_original_inputs(baseline)
            # Reproduce every selected qualified input before launching the GPU child.
            reproduction = []
            for recipe in plan['selected']:
                if recipe.get('cohort') == 'fresh-population-required':
                    case = cases.scene(baseline, **recipe)
                    reproduction.append({'recipe': recipe, 'hashes': qualification.check_regenerated(case, recipe, qualified)})
            save(output / 'qualification-reproduction.json', {'candidateProcessStarted': False, 'records': reproduction})
            validate_declaration(path, qualification, cases, protocol)
            with (output / 'child-stderr.txt').open('w') as stderr, (output / 'results.jsonl').open('w') as results, (output / 'requests.jsonl').open('w') as requests:
                child = GpuChild(declaration['runtime']['node'], bundle, output, stderr)
                for index, recipe in enumerate(plan['selected']):
                    case = cases.scene(baseline, **recipe)
                    if recipe.get('cohort') == 'fresh-population-required':
                        qualification.check_regenerated(case, recipe, qualified)
                    width, height = case['width'], case['height']
                    if not 1 <= width <= 256 or not 1 <= height <= 256:
                        raise RuntimeError('This research child only accepts full synthetic frames at most 256 squared.')
                    input_files = []
                    encoded = qualification.source_bytes(case)
                    for kind, data in encoded.items():
                        original = output / f'case-{index}-{kind}.f32'
                        original.write_bytes(data)
                        input_files.append({'kind': kind, 'path': str(original), 'sha256': digest(original)})
                    entering = next(item for item in input_files if item['kind'] == 'entering')
                    for candidate in plan['candidates']:
                        # Match CPU inputs before sending the first request, rather
                        # than discovering a different source after GPU filtering.
                        if declaration['cpuEvidence'] is not None:
                            reference = [row for row in declaration['cpuEvidence']['references']
                                         if row['recipe'] == recipe and row['candidate'] == candidate]
                            actual_inputs = {item['kind']: item['sha256'] for item in input_files}
                            if len(reference) != 1 or actual_inputs != {kind: item['sha256'] for kind, item in reference[0]['inputs'].items()}:
                                raise RuntimeError('The selected GPU source differs from its frozen CPU comparison.')
                        request_id = f'{index}-{candidate["id"]}'
                        output_path = output / f'case-{request_id}.f32'
                        request = {'id': request_id, 'inputPath': entering['path'], 'outputPath': str(output_path),
                                   'width': width, 'height': height, 'sourceSha256': entering['sha256'],
                                   'primaries': recipe['primaries'], 'luminance': case['luminance'], 'chroma': case['chroma'],
                                   'chromaSigmaFactor': candidate['chromaSigmaFactor']}
                        if output_path.exists():
                            raise RuntimeError('Refusing to overwrite an existing candidate output.')
                        requests.write(json.dumps(request, allow_nan=False) + '\n')
                        requests.flush()
                        at = time.monotonic()
                        reply = child.request(request, plan['requestTimeoutSeconds'])
                        estimate = reply.get('estimate', {})
                        expected_source = {'width': width, 'height': height, 'identity': entering['sha256'],
                                           'sha256': entering['sha256'], 'primaries': recipe['primaries']}
                        if (estimate.get('version') != 'frozen-global-directional-mad-v1'
                            or any(estimate.get('source', {}).get(name) != value for name, value in expected_source.items())
                            or len(estimate.get('variance', [])) != 3
                            or any(not math.isfinite(value) or value < 0 for value in estimate['variance'])
                            or not isinstance(reply.get('adapter'), str)
                            or not isinstance(reply.get('gpuBytes'), int) or reply['gpuBytes'] < 0
                            or not isinstance(reply.get('elapsedMs'), (int, float)) or not math.isfinite(reply['elapsedMs'])
                            or reply['elapsedMs'] < 0
                            or reply.get('nodeVersion', declaration['runtime']['version']) != declaration['runtime']['version']):
                            raise RuntimeError('GPU child returned invalid estimator, runtime or backend provenance.')
                        if output_path.is_symlink() or output_path.stat().st_size != width * height * 16:
                            raise RuntimeError('GPU child output has invalid dimensions or is a symbolic link.')
                        data = output_path.read_bytes()
                        if (len(data) != width * height * 16
                            or reply.get('sourceSha256') != entering['sha256']
                            or digest(entering['path']) != entering['sha256']
                            or reply.get('outputSha256') != hashlib.sha256(data).hexdigest()):
                            raise RuntimeError('GPU child source/output dimensions or hashes differ.')
                        filtered = list(struct.iter_unpack('<4f', data))
                        if any(not all(math.isfinite(v) for v in pixel) for pixel in filtered):
                            raise RuntimeError('GPU child returned nonfinite source-space pixels.')
                        if any(data[at:at + 4] != encoded['entering'][at:at + 4] for at in range(12, len(data), 16)):
                            raise RuntimeError('GPU child changed a source alpha word.')
                        result = cases.evaluate(baseline, case, filtered)
                        agreement = compare_cpu(declaration['cpuEvidence'], recipe, candidate, input_files, data, width, height, estimate)
                        if agreement is not None:
                            result['gates']['frozenCpuRgbAndAlphaAgreement'] = agreement['rgbAndAlphaPassed']
                            result['gates']['frozenCpuEstimatorAgreement'] = agreement['estimator']['passed']
                            agreements.append({'recipe': recipe, 'candidate': candidate['id'], **agreement})
                        failed = [name for name, valid in result['gates'].items() if not valid]
                        if result['required'] and failed:
                            failures.append({'recipe': recipe, 'candidate': candidate['id'], 'gates': failed,
                                             'cohort': result['cohort'], 'adoptionCandidate': candidate['adoptionCandidate']})
                        row = {'recipe': recipe, 'candidate': candidate, 'inputs': input_files, 'metrics': result,
                               'diagnostics': reply, 'cpuAgreement': agreement,
                               'float32OutputPath': str(output_path), 'float32OutputSha256': digest(output_path),
                               'elapsedSeconds': time.monotonic() - at}
                        results.write(json.dumps(row, allow_nan=False) + '\n')
                        results.flush()
                        os.fsync(results.fileno())
                        if not live_audit.append(row):
                            raise RuntimeError('A completed GPU measurement failed the retained-row audit.')
                        completed += 1
                        save(output / 'progress.json', {**live_audit.snapshot(),
                             'state': 'research-running-no-adoption', 'childClosed': False,
                             'elapsedSeconds': time.monotonic() - started})
                child.close()
                save(output / 'cleanup.json', {'childClosed': True, 'pid': child.child.pid,
                                               'returncode': child.child.returncode, 'readerJoined': not child.reader.is_alive()})
                child = None
            validate_declaration(path, qualification, cases, protocol)
            if digest(path) != declaration_sha:
                raise RuntimeError('The reviewed GPU declaration changed during execution.')
            execution_state = 'completed'
        except BaseException as error:
            execution_state = 'interrupted' if isinstance(error, KeyboardInterrupt) else 'failed'
            if output is not None:
                save(output / 'failure.json', {'error': repr(error), 'completed': completed,
                                             'elapsedSeconds': time.monotonic() - started, 'adoption': False})
            raise
        finally:
            primary_error = sys.exc_info()[0] is not None
            cleanup_error = None
            if child is not None:
                try:
                    child.close()
                    if output is not None:
                        save(output / 'cleanup.json', {'childClosed': True, 'pid': child.child.pid,
                                                       'returncode': child.child.returncode, 'readerJoined': not child.reader.is_alive()})
                except BaseException as error:
                    cleanup_error = error
                    execution_state = 'failed' if not primary_error else execution_state
                    if output is not None:
                        save(output / 'cleanup.json', {'childClosed': child.child.poll() is not None,
                             'pid': child.child.pid, 'returncode': child.child.returncode,
                             'readerJoined': not child.reader.is_alive(), 'error': repr(cleanup_error)})
            if output is not None:
                summary = AUDIT.audit_run(output, execution_state)
                summary['elapsedSeconds'] = time.monotonic() - started
                save(output / 'cpu-agreement.json', summary.pop('cpuAgreementRecords'))
                AUDIT.publish_summary(output, summary)
            if cleanup_error is not None and not primary_error:
                raise cleanup_error
        print(json.dumps({'output': str(output), 'completed': summary['completed'],
            'requiredFailures': summary['requiredFailureCount'],
            'cpuAgreementFailures': summary['cpuAgreementFailures'], 'adoption': False}))
        return 1 if (not summary['selectedRunComplete'] or summary['requiredFailures']
                     or summary['cpuAgreementFailures']) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--plan', action='store_true')
    action.add_argument('--freeze', action='store_true')
    action.add_argument('--execute', action='store_true')
    parser.add_argument('--declaration', type=Path)
    parser.add_argument('--cpu-declaration', type=Path)
    parser.add_argument('--qualification', type=Path)
    parser.add_argument('--qualification-sha256')
    parser.add_argument('--cpu-evidence', type=Path)
    parser.add_argument('--node', type=Path)
    parser.add_argument('--stage', choices=STAGES)
    parser.add_argument('--candidate', action='append', choices=CANDIDATES)
    parser.add_argument('--scene', action='append')
    parser.add_argument('--seed', type=lambda value: int(value, 0), action='append')
    parser.add_argument('--sigma', type=float, action='append')
    parser.add_argument('--primaries', choices=('srgb', 'rec2020'), action='append')
    parser.add_argument('--strength', type=int, action='append')
    parser.add_argument('--request-timeout', type=int)
    args = parser.parse_args()
    if args.request_timeout is not None and not 5 <= args.request_timeout <= 900:
        parser.error('Choose a per-request timeout between 5 and 900 seconds.')
    def interrupted(_number, _frame):
        raise KeyboardInterrupt('GPU study interrupted.')
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        protocol = json.loads(PROTOCOL.read_text())
        cases = load('gpu_study_cases', HERE / 'cases.py')
        qualification = load('gpu_study_qualification', HERE / 'qualification.py')
        if args.execute:
            return execute(args, protocol, cases, qualification)
        plan = selected_plan(args, protocol, cases)
        if args.plan:
            print(json.dumps(plan, indent=2, allow_nan=False))
            return 0
        freeze(args, protocol, cases, qualification, plan)
        return 0
    finally:
        signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    sys.exit(main())
