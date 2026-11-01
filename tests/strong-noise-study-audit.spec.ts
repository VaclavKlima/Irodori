import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'

const prelude = String.raw`
import copy, hashlib, importlib.util, json, os, sys, types
from pathlib import Path
root = Path(sys.argv[1])
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
audit = load('audit_under_test', root/'scripts/research/strong-noise/study-audit.py')
def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value)+'\n')
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
candidate = {'id':'noise-scaled-k55', 'chromaSigmaFactor':.55, 'adoptionCandidate':True}
recipes = [{'case':i} for i in range(3)]
plan = {'selected':recipes, 'candidates':[candidate], 'plannedMeasurements':3, 'partialStage':False,
    'stage':'screen', 'requestTimeoutSeconds':5}
def row(index, failed=False, cpu=False):
    gates = {'edgeLeakage':not failed, 'finite':True}
    agreement = None
    if cpu:
        gates.update({'frozenCpuRgbAndAlphaAgreement':False, 'frozenCpuEstimatorAgreement':True})
        agreement = {'passed':False, 'rgbAndAlphaPassed':False, 'estimator':{'passed':True}}
    return {'recipe':recipes[index], 'candidate':candidate, 'metrics':{'required':True,
        'cohort':'synthetic-required', 'gates':gates}, 'cpuAgreement':agreement}
def fixture(path, rows, tail=b'', cpu=False):
    path.mkdir()
    write(path/'plan.json', plan)
    write(path/'declaration.json', {'plan':plan, 'sources':[], 'cpuEvidence':{} if cpu else None})
    write(path/'source-pins.json', [])
    (path/'results.jsonl').write_bytes(b''.join(json.dumps(r).encode()+b'\n' for r in rows)+tail)
    write(path/'cleanup.json', {'childClosed':True, 'readerJoined':True, 'pid':1234, 'returncode':0})
    write(path/'failure.json', {'error':"KeyboardInterrupt('stopped')"})
`

function runPython(info: TestInfo, name: string, code: string) {
  return JSON.parse(
    execFileSync('python3', ['-c', prelude + code, resolve('.'), info.outputPath(name)], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 ** 2,
      encoding: 'utf8',
    }),
  )
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('streaming audit retains mandatory and CPU failures before malformed rows and an incomplete tail', async ({}, info) => {
  const actual = runPython(
    info,
    'streaming',
    String.raw`
run = output/'run'
fixture(run, [row(0, True, True)], b'not-json\n'+json.dumps(row(2, False, True)).encode()+b'\n'+b'{"partial":', True)
result = audit.audit_run(run)
assert result['completed'] == 2
assert result['requiredFailureCount'] == 2
assert result['cpuComparisons'] == 2 and result['cpuAgreementFailures'] == 2
assert result['candidateRejectionObserved'] is True
assert result['invalidRowCount'] >= 1 and result['incompleteTail'] is not None
assert result['selectedRunComplete'] is False
assert result['state'] == 'research-interrupted-incomplete-no-adoption'
assert result['childClosed'] is True
assert result['sourceContentRevalidated'] is False
live = audit.RowAudit(plan, True)
assert live.append(row(0, True, True))
progress = live.snapshot()
assert progress['requiredFailureCount'] == 1 and progress['cpuAgreementFailures'] == 1
assert progress['candidateRejectionObserved'] is True
assert not live.append(row(0, True, True))
assert live.snapshot()['invalidRowCount'] == 1
invalid = row(1, False, True)
invalid['metrics']['gates']['frozenCpuRgbAndAlphaAgreement'] = True
assert not live.append(invalid)
print(json.dumps(result))
`,
  )
  expect(actual).toMatchObject({
    completed: 2,
    planned: 3,
    candidateRejectionObserved: true,
    cpuAgreementFailures: 2,
    selectedRunComplete: false,
    adoption: false,
  })
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('standalone retained-run audit preserves original bytes and refuses existing or nested output directories', async ({}, info) => {
  const actual = runPython(
    info,
    'standalone',
    String.raw`
import subprocess
run, destination = output/'old-run', output/'new-audit'
fixture(run, [row(0, True)], b'{"truncated":')
before = {p.name:sha(p) for p in run.iterdir()}
command = [sys.executable, str(root/'scripts/research/strong-noise/study-audit.py'),
    '--run-dir', str(run), '--output-dir', str(destination)]
first = subprocess.run(command, capture_output=True, text=True, timeout=10)
assert first.returncode == 1, first.stderr
result = json.loads((destination/'summary.json').read_text())
assert result['completed'] == 1 and result['requiredFailureCount'] == 1
assert result['candidateRejectionObserved'] is True
assert result['incompleteTail'] is not None
assert {p.name:sha(p) for p in run.iterdir()} == before
for pin in result['inputPins']:
    assert pin['sha256'] == sha(Path(pin['path']))
    assert pin['bytes'] == Path(pin['path']).stat().st_size
assert {Path(p['path']).name for p in result['inputPins']} >= {'declaration.json','source-pins.json','results.jsonl'}
published = (destination/'summary.json').read_bytes()
second = subprocess.run(command, capture_output=True, text=True, timeout=10)
assert second.returncode != 0 and 'already exists' in second.stderr
assert (destination/'summary.json').read_bytes() == published
nested = subprocess.run(command[:-1]+[str(run/'nested')], capture_output=True, text=True, timeout=10)
assert nested.returncode != 0 and not (run/'nested').exists()
assert {p.name:sha(p) for p in run.iterdir()} == before
print(json.dumps(result))
`,
  )
  expect(actual).toMatchObject({
    requiredFailureCount: 1,
    completed: 1,
    selectedRunComplete: false,
    adoption: false,
  })
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('driver publishes retained gate failures after interruption and cleanup failure without launching a GPU', async ({}, info) => {
  const actual = runPython(
    info,
    'lifecycle',
    String.raw`
import contextlib, io, struct
study = load('driver_under_test', root/'scripts/research/strong-noise/gpu-study.py')
base = output/'frozen'
base.mkdir()
for name in ('qualification.json','metafile.json'):
    write(base/name, {})
(base/'bundle.cjs').write_text('not executed')
class Invocation:
    token = 'fake-no-shared-lock'
    def __init__(self, *_args): pass
    def __enter__(self): return self
    def __exit__(self, *_args): pass
class Cases:
    def verify_original_inputs(self, _baseline): pass
    def scene(self, _baseline, **recipe):
        return {'width':1, 'height':1, 'luminance':50, 'chroma':50,
            'clean':[[.1,.2,.3,1]], 'entering':[[.1,.2,.3,1]], 'case':recipe['case']}
    def evaluate(self, _baseline, case, _filtered):
        return {'required':True, 'cohort':'synthetic-required',
            'gates':{'edgeLeakage':case['case'] != 0, 'finite':True}}
class FakeChild:
    mode = None
    created = []
    def __init__(self, _node, _bundle, directory, _stderr):
        self.directory = directory
        self.requests = 0
        self.closed = False
        self.child = types.SimpleNamespace(pid=1234, returncode=0, poll=lambda:0)
        self.reader = types.SimpleNamespace(is_alive=lambda:False)
        self.created.append(self)
    def request(self, request, _timeout):
        self.requests += 1
        if self.mode == 'interrupted' and self.requests == 2:
            raise KeyboardInterrupt('fake interruption after a failed mandatory row')
        data = Path(request['inputPath']).read_bytes()
        Path(request['outputPath']).write_bytes(data)
        return {'sourceSha256':request['sourceSha256'],
            'outputSha256':hashlib.sha256(data).hexdigest(),
            'estimate':{'version':'frozen-global-directional-mad-v1', 'variance':[0,0,0],
                'source':{'width':1,'height':1,'identity':request['sourceSha256'],
                    'sha256':request['sourceSha256'],'primaries':request['primaries']}},
            'adapter':'fake-no-GPU', 'gpuBytes':0, 'elapsedMs':0, 'nodeVersion':'v24.fake'}
    def close(self):
        self.closed = True
        if self.mode == 'cleanup-failed': raise RuntimeError('fake cleanup failure')
study.Invocation = Invocation
study.GpuChild = FakeChild
study.load = lambda *_args: object()
local_plan = copy.deepcopy(plan)
local_plan['selected'] = [dict(recipe, primaries='rec2020') for recipe in recipes]
declaration = {'plan':local_plan, 'sources':[], 'cpuEvidence':None,
    'qualification':{'path':str(base/'qualification.json')},
    'runtime':{'node':'never-executed','version':'v24.fake'},
    'build':{'bundle':str(base/'bundle.cjs'),'metafile':str(base/'metafile.json'),'legalComments':[]}}
path = base/'declaration.json'
write(path, declaration)
study.validate_declaration = lambda *_args: (declaration,{})
args = types.SimpleNamespace(declaration=path, **{name:None for name in ('stage','candidate','scene','seed',
    'sigma','primaries','strength','cpu_declaration','qualification','qualification_sha256','cpu_evidence','node','request_timeout')})
qualification = types.SimpleNamespace(source_bytes=lambda case: {
    kind:b''.join(struct.pack('<4f', *pixel) for pixel in case[kind]) for kind in ('clean','entering')})
records = []
for mode in ('interrupted','cleanup-failed','completed'):
    study.OUTPUT = output/mode
    FakeChild.mode = mode
    caught = None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            code = study.execute(args, {}, Cases(), qualification)
        assert code == 1
    except (KeyboardInterrupt, RuntimeError) as error:
        caught = str(error)
    runs = list(study.OUTPUT.glob('run-*'))
    assert len(runs) == 1
    run = runs[0]
    result = json.loads((run/'summary.json').read_text())
    progress = json.loads((run/'progress.json').read_text())
    assert FakeChild.created[-1].closed
    assert result['requiredFailureCount'] == 1 and result['candidateRejectionObserved'] is True
    assert progress['requiredFailureCount'] == 1
    assert result['childClosed'] is True
    assert result['adoption'] is False
    assert result['completed'] == (1 if mode == 'interrupted' else 3)
    assert result['selectedRunComplete'] is (mode == 'completed')
    assert (caught is not None) is (mode != 'completed')
    records.append({'mode':mode, 'state':result['state'], 'completed':result['completed'],
        'requiredFailures':result['requiredFailureCount']})
print(json.dumps(records))
`,
  )
  expect(actual).toEqual([
    {
      mode: 'interrupted',
      state: 'research-interrupted-incomplete-no-adoption',
      completed: 1,
      requiredFailures: 1,
    },
    {
      mode: 'cleanup-failed',
      state: 'research-failed-incomplete-no-adoption',
      completed: 3,
      requiredFailures: 1,
    },
    {
      mode: 'completed',
      state: 'research-complete-no-adoption',
      completed: 3,
      requiredFailures: 1,
    },
  ])
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures.
test('GPU declaration rejects edited CPU descriptors despite unchanged pinned CPU receipts', async ({}, info) => {
  const actual = runPython(
    info,
    'cpu-binding',
    String.raw`
study = load('driver_binding_under_test', root/'scripts/research/strong-noise/gpu-study.py')
base = output/'cpu'
base.mkdir()
recipe = {'high':False,'name':'synthetic','primaries':'rec2020'}
local_plan = {'selected':[recipe], 'candidates':[candidate], 'plannedMeasurements':1,
    'caseCount':1,'fullStageCaseCount':1,'stage':'screen','requestTimeoutSeconds':5}
for name in ('clean.f32','entering.f32','output.f32'):
    (base/name).write_bytes(bytes(32*24*16))
write(base/'declaration.json', {'sources':[]})
estimator = {'version':'frozen-global-directional-mad-v1', 'available':True, 'sigma':[0.,0.,0.],
    'variance':[0.,0.,0.], 'directions':[]}
for direction in ([1,0],[0,1],[1,1],[1,-1]):
    available = (32-abs(direction[0]))*(24-abs(direction[1]))
    estimator['directions'].append({'direction':direction,'availablePairs':available,
        'stratifiedPairs':available,'validPairs':available,'centers':[0.,0.,0.],'sigma':[0.,0.,0.]})
reference = {'recipe':recipe,'candidate':candidate,
    'inputs':[{'kind':name,'path':str(base/(name+'.f32')),'sha256':sha(base/(name+'.f32'))}
        for name in ('clean','entering')], 'diagnostics':{'estimator':estimator},
    'float32OutputPath':str(base/'output.f32'), 'float32OutputSha256':sha(base/'output.f32')}
(base/'results.jsonl').write_text(json.dumps(reference)+'\n')
write(base/'summary.json', {'state':'research-complete-no-adoption','completed':1,'requiredFailures':[]})
evidence, files = study.cpu_evidence(base, local_plan, base/'declaration.json')
for name in ('receipt.json','bundle.cjs','metafile.json','fake-node'):
    (output/name).write_text('{}')
protocol = {'candidates':[candidate]}
required = [Path(study.__file__), study.HERE/'gpu.ts',study.HERE/'gpu-wgsl.ts',
    study.HERE/'gpu-child.ts',study.HERE/'build-gpu-child.mjs',study.HERE/'study-audit.py',
    root/'package-lock.json',base/'declaration.json',output/'receipt.json',output/'fake-node',
    Path(sys.executable).resolve(), output/'bundle.cjs',output/'metafile.json',*files]
declaration = {'version':study.VERSION,'protocol':protocol,'plan':local_plan,
    'sources':study.pins(required),'runtime':{'python':sys.version,
        'pythonExecutable':str(Path(sys.executable).resolve()),'node':str(output/'fake-node')},
    'cpuDeclaration':{'path':str(base/'declaration.json'),'sha256':sha(base/'declaration.json')},
    'qualification':{'path':str(output/'receipt.json'),'sha256':sha(output/'receipt.json')},
    'cpuEvidence':evidence,'build':{'bundle':str(output/'bundle.cjs'),'metafile':str(output/'metafile.json')}}
path = output/'gpu-declaration.json'
qualification = types.SimpleNamespace(validate_receipt=lambda *_args:{})
cases = types.SimpleNamespace(selections=lambda *_args:[recipe])
write(path, declaration)
study.validate_declaration(path, qualification, cases, protocol)
refused = []
for edit in ('estimator','output'):
    altered = copy.deepcopy(declaration)
    record = altered['cpuEvidence']['references'][0]
    if edit == 'estimator': record['estimator']['sigma'][0] = .123
    else: record['output']['sha256'] = 'f'*64
    write(path, altered)
    try:
        study.validate_declaration(path, qualification, cases, protocol)
        raise AssertionError('Edited CPU descriptor was accepted.')
    except RuntimeError as error:
        assert 'differs from its pinned result rows' in str(error)
        refused.append(edit)
print(json.dumps({'validDescriptorAccepted':True,'tamperingRefused':refused}))
`,
  )
  expect(actual).toEqual({
    validDescriptorAccepted: true,
    tamperingRefused: ['estimator', 'output'],
  })
})
