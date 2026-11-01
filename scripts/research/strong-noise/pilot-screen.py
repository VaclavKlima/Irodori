#!/usr/bin/env python3
"""Frozen C15 retained-quality driver draft. No source generation or production adoption."""
import argparse, datetime, hashlib, importlib.util, json, math, os, pathlib, shutil, signal, struct, subprocess, sys, tempfile, time
from typing import NamedTuple
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = ROOT/'scripts/research/strong-noise'
POLICY = HERE/'comparison15.json'
OUT = ROOT/'artifacts/detail-research/strong-noise/comparison15-retained'
SOURCE_ROOTS = []
VERSION = 'c15-retained-regression-screen-v1'
DRIVER_ID = 'c15-retained-screen-driver-v1'
PROOF_KIND = 'chroma-pilot-pointwise-decimal80-host-f64-v1'
GROUP_COUNTS = {'core':156,'alpha':84,'asymmetric':12,'identity':180,'publication':15}
STAGES = ('context-edge-regression','edge-regression-anchors','flat-stress','texture-regression')
STAGE_ROWS = ([0,2],[1,3,4,5,6,7],[4,5,10,11,28,29,34,35,52,53,58,59,76,77,82,83,100,101,106,107,124,125,130,131],[12,13,20,21,48,49,52,53,56,57,60,61])
COUNTERFEITS = {'core':('raw-source-guide','guide-values-instead-of-original','unpublished-pilot','unpublished-guide','rgb-roundtrip-guide','short-halo23'), 'alpha':('linear-alpha','capped-self')}
REJECTION_KEYS = {'c12Results','inverseDiagnosis','c13AnchorResults','c13HardResults','c13InverseDiagnosis','c13BoundaryWeights','c14Results','c14Summary','c14Cleanup','c14FrozenDeclaration'}
BINDING_NAMES = {'scripts/research/strong-noise/reference/chroma-pilot.py','scripts/research/strong-noise/reference/pilot-host-f64.py','scripts/research/strong-noise/reference/reference.py','scripts/research/strong-noise/reference/input-plan.json','scripts/research/strong-noise/reference/chroma-full.py','assets/tests/references/detail/strong-noise/chroma-pilot-pointwise.md','scripts/research/strong-noise/comparison15.json','scripts/research/detail-candidates.py','scripts/research/color-reference.py','scripts/research/strong-noise/noise-scaled-patchwise.py','scripts/research/strong-noise/chroma-pilot-pointwise.py','scripts/research/strong-noise/patchwise.py','scripts/research/strong-noise/pixelwise.py'}
OUTCOME_TITLES = {'independent pilot guidance preserves original values and rejects wrong guidance, publication and halo','pilot guidance preserves hidden and common-scaled alpha state with squared neighbor weights and uncapped self','pilot pointwise reference preserves asymmetric controls and unchanged strict RGB limits','C zero preserves exact old C9 words, physical stage presence and absence of pilot and guide','declared Float64 addition then guide RN32 and canonical delta publication retain tie and zero semantics'}
MATH_LAYOUT = {'aggregation':'normalized-l9-patch-c1-owner-estimates-f32-zero-v1','chromaSpatialPolicy':'uniform-search-v1','luminanceSearchRadius':3,'chromaSearchRadius':10,'luminanceMatchingRadius':1,'chromaMatchingRadius':0,'luminanceTargetRadius':1,'chromaTargetRadius':0,'sourceHalo':{'luminance':5,'chroma':24},'stageScalars':11,'stageLayout':'l9-row-major-c1-ab-owner-v1','guideScalars':3,'pilotStageScalars':59,'pilotStageLayout':'l9-row-major-c25-ab-row-major-v1','guidePolicy':'fixed-c14-100-100-preinverse-feature-rn32-v1','valuePolicy':'original-features-only-v1','chromaDistancePolicy':'pointwise-pilot-l08-ab-sum-hc-no-bias-v1','neighborAlphaPolicy':'squared-visible-neighbor-v1','proposalBoundRadii':[3,10,10]}
WORD_DESIGN = {'kind':'host-f64-operation-graph-v1','scope':'host-runtime-libm-v1','coefficientPolicy':'independent-Decimal80-primary-solve-rounded-to-binary64-v1','candidateImported':False}
NUMERIC_FAILURES = {'pilot-center-publication-word','guide-publication-word','center-publication-word','pilot-publication-not-f32','pilot-center-publication-not-f32','guide-publication-not-f32','center-publication-not-f32','final-publication-not-f32','strict-pre-final-rgb','final-rgb'}

class IncompleteVerification(RuntimeError):
    """A required proof is absent or cannot authorize retained-quality execution."""

def sha(path):
    h=hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        while b:=f.read(1024*1024):h.update(b)
    return h.hexdigest()

def save(path,value):
    path=pathlib.Path(path);temporary=None;temporary_identity=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,
                prefix='.'+path.name+'.',suffix='.tmp',delete=False) as stream:
            temporary=pathlib.Path(stream.name)
            info=os.fstat(stream.fileno());temporary_identity=(info.st_dev,info.st_ino)
            json.dump(value,stream,indent=2,allow_nan=False)
            stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
        temporary=None
    finally:
        if temporary is not None:
            try:info=temporary.lstat()
            except FileNotFoundError:pass
            else:
                if temporary.is_symlink() or (info.st_dev,info.st_ino)!=temporary_identity:
                    raise RuntimeError('Atomic JSON temporary ownership changed; preserving it.')
                temporary.unlink()

def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def pins(paths):return [{'path':str(p.resolve()),'sha256':sha(p)} for p in sorted(set(map(pathlib.Path,paths)))]
def check(items):
    for p in items:
        if sha(p['path'])!=p['sha256']:raise RuntimeError('Pinned source/input changed: '+p['path'])

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode('ascii')


def artifact_path(value):
    path=pathlib.Path(value)
    if not path.is_absolute():return (ROOT/path).resolve()
    for previous,current in SOURCE_ROOTS:
        if path.is_relative_to(previous):return (current/path.relative_to(previous)).resolve()
    return path.resolve()


def read_json(path,label):
    path=artifact_path(path)
    if not path.is_file() or path.is_symlink():raise IncompleteVerification(label+' is missing or not a regular owned receipt: '+str(path))
    try:return json.loads(path.read_text())
    except (ValueError,OSError) as error:raise IncompleteVerification(label+' is unreadable: '+str(path)) from error


def require(condition,message):
    if not condition:raise IncompleteVerification(message)


def policy_evidence(policy):
    result={}
    for section in ('rejectionEvidence','inputBaselines'):
        for name,item in policy[section].items():
            if isinstance(item,dict) and set(item)>= {'path','sha256'}:result[section+'.'+name]=item
    for name in ('policySource','implementationSource'):result['pilot.'+name]=policy['pilot'][name]
    require(len(result)==14,'All14 exact retained evidence declarations are required')
    return result


def validate_stages(policy):
    require(policy.get('version')=='detail-chroma-pilot-pointwise-comparison-15-v1' and policy.get('candidate',{}).get('id')=='noise-scaled-k40-c14-pilot-pointwise-r10','Wrong C15 declaration/candidate identity')
    require(set(policy.get('rejectionEvidence',{}))==REJECTION_KEYS,'All10 retained rejection/diagnosis records are required')
    require(set(policy.get('inputBaselines',{}))=={'c12FrozenDeclaration','priorC14SelectionAudit','scope'},'Both retained input baselines are required')
    stages=policy.get('stages',[])
    require(len(stages)==4,'All four C15 quality stages are required')
    for index,(stage,rows) in enumerate(zip(stages,STAGE_ROWS)):
        require(stage=={'id':STAGES[index],'source':('edges','edges','flatStress','qualifiedTextures')[index],'rows':rows,'requiredEarlierStages':list(STAGES[:index])},'C15 exact2/6/24/12 stage order or source rows changed')
    for key,item in policy_evidence(policy).items():
        require(isinstance(item.get('path'),str) and isinstance(item.get('sha256'),str) and len(item['sha256'])==64,'Malformed evidence pin '+key)


def validate_math_layout(value):
    require(all(value.get(key)==expected for key,expected in MATH_LAYOUT.items()),'Executed proof changed C15 pilot/final layout, halo or source domain')


def source_bindings():
    return {name:sha(ROOT/name) for name in sorted(BINDING_NAMES)}


class FreezeDestination(NamedTuple):
    """Immutable capability for one freshly created freeze directory."""
    root: pathlib.Path
    device: int
    inode: int
    token: str

    @classmethod
    def create(cls,output_root,token,forbidden_directories=()):
        parent=pathlib.Path(output_root).resolve()
        if not parent.is_relative_to((ROOT/'artifacts').resolve()):
            raise RuntimeError('Freeze output must remain under repository artifacts/.')
        for protected in forbidden_directories:
            protected=pathlib.Path(protected).resolve()
            if parent==protected or parent.is_relative_to(protected):
                raise RuntimeError('A retained/source directory cannot own freeze output.')
        if not isinstance(token,str) or not token:
            raise RuntimeError('Freeze output requires its invocation token.')
        parent.mkdir(parents=True,exist_ok=True)
        root=pathlib.Path(tempfile.mkdtemp(prefix='freeze-',dir=parent)).resolve()
        info=root.lstat()
        return cls(root,info.st_dev,info.st_ino,token)

    def validate(self):
        if self.root.is_symlink() or not self.root.is_dir() or self.root.resolve()!=self.root:
            raise RuntimeError('Freeze directory changed; refusing destination writes.')
        info=self.root.lstat()
        if (info.st_dev,info.st_ino)!=(self.device,self.inode):
            raise RuntimeError('Freeze directory inode changed; preserving unknown output.')

    def target(self,relative):
        self.validate();relative=pathlib.Path(relative)
        if relative.is_absolute() or not relative.parts or any(part in ('.','..') for part in relative.parts):
            raise RuntimeError('Freeze destination must be a relative child path.')
        target=self.root/relative
        for parent in (target,*target.parents):
            if parent==self.root:break
            if parent.is_symlink():raise RuntimeError('Freeze destination contains a symlink.')
        resolved=target.resolve()
        if resolved==self.root or not resolved.is_relative_to(self.root):
            raise RuntimeError('Freeze destination escaped its fresh directory.')
        return resolved

    def write_json(self,relative,value,require_new=False):
        target=self.target(relative)
        if require_new and (target.exists() or target.is_symlink()):
            raise RuntimeError('Fresh freeze metadata already exists; refusing overwrite.')
        target.parent.mkdir(parents=True,exist_ok=True)
        target=self.target(relative)
        save(target,value)
        return target

    def copy_source(self,source,relative,expected):
        target=self.target(relative)
        target.parent.mkdir(parents=True,exist_ok=True)
        target=self.target(relative)
        with pathlib.Path(source).open('rb') as entering,target.open('xb') as output:
            shutil.copyfileobj(entering,output)
            output.flush();os.fsync(output.fileno())
        if sha(target)!=expected:raise RuntimeError('Frozen source copy mismatch')
        return target


def assemble_freeze(freeze_directory,paths,declaration):
    """Actual archive/declaration writer; metadata collection stays read-only."""
    if not isinstance(freeze_directory,FreezeDestination):
        raise RuntimeError('Freeze assembly requires its immutable fresh destination.')
    freeze_directory.validate()
    sources_to_pin={pathlib.Path(path).resolve() for path in paths}
    # Validate every source before the first archive directory/file is created.
    for source in sources_to_pin:
        if source==freeze_directory.root or source.is_relative_to(freeze_directory.root):
            raise RuntimeError('Freeze output contains an input/source; refusing archive writes.')
        if source.is_relative_to((ROOT/'artifacts').resolve()) and freeze_directory.root.is_relative_to(source.parent):
            raise RuntimeError('Freeze output is nested in retained evidence; refusing archive writes.')
    items=pins(sources_to_pin);source_copies=[]
    for item in items:
        source=pathlib.Path(item['path'])
        if source.suffix in ('.py','.ts','.json','.md') and source.is_relative_to(ROOT) and 'case-' not in source.name:
            target=freeze_directory.copy_source(source,pathlib.Path('sources')/source.relative_to(ROOT),item['sha256'])
            source_copies.append({'original':str(source),'path':str(target),'sha256':item['sha256']})
    check(items);check(source_copies)
    value={**declaration,'pins':items,'sourceCopies':source_copies,
        'freezeDestination':{'path':str(freeze_directory.root),'device':freeze_directory.device,
            'inode':freeze_directory.inode,'invocationToken':freeze_directory.token}}
    path=freeze_directory.write_json('declaration.json',value,require_new=True)
    if path!=freeze_directory.target('declaration.json'):
        raise RuntimeError('Freeze declaration is outside its captured fresh destination.')
    return {'declaration':str(path),'sha256':sha(path),'records':len(value.get('records',[])),
            'pins':len(items),'candidateImported':False}


def guarded_invocation(runtime,kind,audit_path):
    """Same lock namespace/token contract; preserve unknown acquisition failures."""
    class GuardedInvocation(runtime.Invocation):
        def __init__(self):
            super().__init__(kind)
            self.identity=None;self.retired=False;self.owner_published=False
            self.audit_path=audit_path;self.freeze_destination=None

        def record(self,status,error=None):
            value={'version':VERSION,'driverId':DRIVER_ID,'token':self.token,
                'pid':os.getpid(),'lock':str(runtime.LOCK),'status':status,
                'acquired':self.acquired,'directoryIdentity':self.identity,
                'ownerPublished':self.owner_published,'ownedLockReleased':self.retired,
                'error':None if error is None else repr(error)}
            if self.freeze_destination is None:save(self.audit_path,value)
            else:self.freeze_destination.write_json('acquisition.json',value)

        def same_directory(self):
            if not runtime.LOCK.exists():return False
            info=runtime.LOCK.lstat()
            return not runtime.LOCK.is_symlink() and runtime.LOCK.is_dir() and self.identity==[info.st_dev,info.st_ino]

        def retire(self):
            if not self.acquired:return
            if runtime.LOCK.is_symlink():
                raise RuntimeError('Invocation path became a symlink; preserving the foreign lock.')
            if not runtime.LOCK.exists():self.retired=True;return
            if self.identity is None or not self.same_directory():
                raise RuntimeError('Invocation directory changed; preserving unknown/foreign lock.')
            owner=runtime.LOCK/'owner.json';names={item.name for item in runtime.LOCK.iterdir()}
            if owner.exists() or owner.is_symlink():
                if owner.is_symlink() or names!={'owner.json'}:
                    raise RuntimeError('Invocation has unknown files; preserving its directory.')
                identity=json.loads(owner.read_text())
                if identity.get('token')!=self.token or identity.get('pid')!=os.getpid():
                    raise RuntimeError('Invocation token changed; preserving the foreign lock.')
                if not self.same_directory():raise RuntimeError('Invocation inode changed before owner retirement.')
                self.owner_published=True
                owner.unlink()
            elif names:
                raise RuntimeError('Owner publication failed with unknown directory contents; preserving lock.')
            # Ownerless removal is allowed only for our captured empty directory.
            if not self.same_directory() or any(runtime.LOCK.iterdir()):
                raise RuntimeError('Invocation inode/contents changed before directory retirement.')
            runtime.LOCK.rmdir();self.retired=True

        def __enter__(self):
            self.record('before-acquisition')
            try:
                runtime.LOCK.parent.mkdir(parents=True,exist_ok=True)
                runtime.LOCK.mkdir();self.acquired=True
                info=runtime.LOCK.lstat();self.identity=[info.st_dev,info.st_ino]
                runtime.save(runtime.LOCK/'owner.json',{'pid':os.getpid(),'token':self.token,
                    'kind':kind,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
                self.owner_published=True;self.record('acquired')
                return self
            except BaseException as error:
                cleanup_error=None
                try:self.retire()
                except BaseException as failure:cleanup_error=failure
                self.record('acquisition-failed',error)
                if cleanup_error is not None:raise BaseExceptionGroup('Acquisition and guarded retirement failed',[error,cleanup_error])
                raise

        def __exit__(self,*error):
            self.retire();self.record('released',error[1])
    return GuardedInvocation()


def runtime_fingerprint():
    # Same recorded host substrate, independently read without importing any candidate.
    executable=pathlib.Path(sys.executable).resolve(strict=True)
    extension=pathlib.Path(math.__file__).resolve(strict=True) if getattr(math,'__file__',None) else None
    files=[];status='unavailable-platform'
    if sys.platform.startswith('linux'):
        maps=pathlib.Path('/proc/self/maps');status='unavailable-process-maps'
        if maps.is_file():
            found=set()
            for line in maps.read_text().splitlines():
                fields=line.split(None,5)
                if len(fields)==6 and fields[5].startswith('/'):
                    path=pathlib.Path(fields[5])
                    if path.name.startswith('libm.so') and path.is_file():found.add(path.resolve(strict=True))
            files=[{'path':str(path),'sha256':sha(path)} for path in sorted(found)]
            status='identified' if files else 'unavailable-loaded-libm-not-identified'
    return {'scope':'Pinned host operation graph; not a portable correctly-rounded libm theorem.','platform':sys.platform,'python':{'path':str(executable),'sha256':sha(executable),'version':sys.version},'mathExtension':{'path':str(extension),'sha256':sha(extension)} if extension else None,'loadedLibm':{'status':status,'files':files}}


def reference_plan(group):
    command=[sys.executable,'-B',str(HERE/'reference/chroma-pilot.py'),'--plan','--group',group]
    completed=subprocess.run(command,cwd=ROOT,capture_output=True,check=False,timeout=30)
    require(completed.returncode==0,'Candidate-free numerical plan is unavailable: '+completed.stderr.decode(errors='replace')[-1000:])
    plan=json.loads(completed.stdout)
    require(plan.get('candidateImported') is False and plan.get('configurations')==GROUP_COUNTS[group] and plan.get('group')==group,'Wrong numerical group plan')
    require(plan.get('planSha256')==hashlib.sha256(canonical({key:value for key,value in plan.items() if key!='planSha256'})).hexdigest(),'Numerical plan digest differs from actual plan')
    require(plan.get('sourceBindings')==source_bindings(),'Plan source bindings differ from all13 current sources')
    validate_math_layout(plan)
    return plan


def expected_coverage(plan):
    if plan['group']=='publication':return {'guidePublicationSeamsChecked':15,'finalPublicationSeamsChecked':15,'chromaNormalizationSeamsChecked':15,'independentCoefficientWordsChecked':6}
    pixels=sum(row['width']*row['height'] for row in plan['cases']);primaries=len(plan['primaries']);controls=plan['controls']
    active=pixels*primaries*sum(c>0 for _,c in controls);c0=sum(c==0 for _,c in controls)
    result={'independentCoefficientWordsChecked':6,'allGridAlphaWordsChecked':pixels*primaries*len(controls),'exactPilotCenterWordsChecked':active*59,'exactPilotProposalWords64Checked':active*3,'exactGuideWordsChecked':active*3,'exactCenterWordsChecked':active*11,'C0OldC9RgbaWordsChecked':pixels*primaries*c0*4,'C0OldC9ProposalWordsChecked':pixels*primaries*c0*3,'C0OldC9StageWordsChecked':pixels*primaries*sum(l>0 and c==0 for l,c in controls)*27,'C0GuideAbsencesChecked':len(plan['cases'])*primaries*c0,'C0PilotAbsencesChecked':len(plan['cases'])*primaries*c0,'allLuminanceProposalWordsChecked':pixels*primaries*len(controls),'nonzeroChromaLuminanceProposalWordsChecked':active,'allLuminanceCenterWordsChecked':pixels*primaries*sum(bool(l or c) for l,c in controls)*9,'nonzeroChromaLuminanceCenterWordsChecked':active*9}
    rgb=sum(len(row['points']) for row in plan['cases'])*primaries*len(controls)*3
    result.update(preFinalRgbChannelsChecked=rgb,finalRgbChannelsChecked=rgb)
    return result


def validate_word_oracle(value):
    require(isinstance(value,dict) and {key:item for key,item in value.items() if key!='coefficientWords'}==WORD_DESIGN,'Wrong exact-word oracle design')
    words=value.get('coefficientWords')
    require(isinstance(words,dict) and set(words)=={'srgb','rec2020'},'Both independently solved primary sets are required')
    require(all(isinstance(row,list) and len(row)==3 and all(isinstance(word,str) and len(word)==16 and set(word)<=set('0123456789abcdef') for word in row) for row in words.values()),'Six exact binary64 coefficient words are required')


def verify_numeric_proofs(proofs,math_approval,verification_receipt):
    bindings=source_bindings();approval=read_json(math_approval,'Root numerical approval')
    require(approval.get('referenceGenerationApproved') is True and approval.get('referenceKind')==PROOF_KIND and approval.get('sourceBindings')==bindings and approval.get('candidateSha256')==bindings['scripts/research/strong-noise/chroma-pilot-pointwise.py'] and approval.get('wordOracle')==WORD_DESIGN and set(approval.get('groups',{}))==set(GROUP_COUNTS),'Root approval must cover all five exact C15 groups and all13 source bindings')
    verification=read_json(verification_receipt,'Complete target verification receipt')
    outcomes=[row for row in verification.get('tests',[]) if row.get('target')=='strong-noise-chroma-pilot']
    require(verification.get('status')=='passed' and verification.get('exitCode')==0 and all(verification.get(key)==0 for key in ('failed','skipped','interrupted')) and len(outcomes)==5 and {row.get('title') for row in outcomes}==OUTCOME_TITLES and all(row.get('file')=='tests/strong-noise-chroma-pilot.spec.ts' and row.get('status')=='passed' and row.get('errors')==[] for row in outcomes),'A publication-only or partial target receipt cannot authorize quality execution')
    runtime=runtime_fingerprint()
    require(runtime['loadedLibm']['status']=='identified' and runtime['loadedLibm']['files'] and runtime['mathExtension'] is not None,'Current host Python/math/libm identity is incomplete')
    paths=[artifact_path(math_approval),artifact_path(verification_receipt)] + [ROOT/name for name in BINDING_NAMES]
    paths += [pathlib.Path(runtime['python']['path']),pathlib.Path(runtime['mathExtension']['path'])]+[pathlib.Path(row['path']) for row in runtime['loadedLibm']['files']]
    receipts={};word_oracle=None
    for path in artifact_path(proofs).rglob('comparison.json'):
        actual=read_json(path,'Executed numerical comparison');group=actual.get('group')
        if group not in GROUP_COUNTS or actual.get('referenceKind')!=PROOF_KIND:continue
        require(group not in receipts,'Repeated C15 numerical proof group')
        plan=reference_plan(group);plan_without_sha={key:value for key,value in plan.items() if key!='planSha256'}
        require(approval['groups'][group]=={'planSha256':plan['planSha256'],'configurations':GROUP_COUNTS[group]},'Approved group differs from actual current input plan')
        require(actual.get('status')=='passed' and actual.get('failures')==[] and actual.get('candidateId')=='noise-scaled-k40-c14-pilot-pointwise-r10' and actual.get('configurations')==GROUP_COUNTS[group] and actual.get('planSha256')==plan['planSha256'] and actual.get('sourceBindings')==bindings and actual.get('runtimeFingerprint')==runtime and actual.get('generatorSha256')==bindings['scripts/research/strong-noise/reference/chroma-pilot.py'] and actual.get('candidateSha256')==bindings['scripts/research/strong-noise/chroma-pilot-pointwise.py'] and actual.get('coefficientWordsAgreed') is True,'Executed numerical proof/source/runtime/coefficient mismatch')
        validate_word_oracle(actual.get('wordOracle'))
        if word_oracle is None:word_oracle=actual['wordOracle']
        require(actual['wordOracle']==word_oracle,'Numerical groups use different coefficient words or oracle semantics')
        for key,count in expected_coverage(plan).items():require(type(actual.get(key)) is int and actual[key]==count,'Missing or partial actual numerical coverage: '+group+'/'+key)
        reference_path=path.parent/'reference.json';reference=read_json(reference_path,'Executed independent reference')
        require(sha(reference_path)==actual.get('referenceSha256') and reference.get('plan')==plan_without_sha and reference.get('planSha256')==plan['planSha256'] and reference.get('candidateImported') is False and reference.get('candidateId')==actual['candidateId'] and reference.get('sourceBindings')==bindings and reference.get('runtimeFingerprint')==runtime and reference.get('wordOracle')==word_oracle,'Executed reference does not bind the exact actual plan/runtime/sources')
        validate_math_layout(reference)
        generation_path=artifact_path(reference.get('generationApprovalPath',''))
        generated_approval=read_json(generation_path,'Actual generation approval')
        require(sha(generation_path)==reference.get('approvalSha256') and generated_approval.get('group')==group and generated_approval.get('planSha256')==plan['planSha256'] and generated_approval.get('sourceBindings')==bindings and generated_approval.get('groups')==approval['groups'] and generated_approval.get('referenceGenerationApproved') is True and generated_approval.get('referenceKind')==PROOF_KIND and generated_approval.get('candidateSha256')==actual['candidateSha256'] and generated_approval.get('generatorSha256')==actual['generatorSha256'] and generated_approval.get('wordOracle')==WORD_DESIGN,'Actual reference-generation approval differs from the reviewed full selection')
        if group=='alpha':require(all(actual.get(key,0)>0 for key in ('pairedRgbChannelsChecked','pairedProposalWordsChecked','pairedCenterWordsChecked','allGridTransparentRgbaCopiesChecked')),'Alpha/hidden paired proof is missing')
        if group not in ('identity','publication'):require(actual['preFinalRgbChannelsChecked']>0 and actual['exactPilotCenterWordsChecked']>0 and actual['exactGuideWordsChecked']>0,'Image arithmetic proof is absent')
        if group=='identity':require(actual['preFinalRgbChannelsChecked']==0 and actual['exactPilotCenterWordsChecked']==0 and actual['exactGuideWordsChecked']==0,'C0 whole-grid proof changed scope')
        paths += [path,reference_path,generation_path]
        receipts[group]={'path':str(path.resolve()),'sha256':sha(path),'referencePath':str(reference_path.resolve()),'referenceSha256':sha(reference_path),'approvalPath':str(generation_path.resolve()),'approvalSha256':sha(generation_path),'planSha256':plan['planSha256'],'configurations':GROUP_COUNTS[group]}
        for name in COUNTERFEITS.get(group,()):
            negative=path.parent/(name+'-comparison.json');fake=path.parent/(name+'.py');rejected=read_json(negative,'Required numerical counterfeit '+name)
            meaningful=[failure for failure in rejected.get('failures',[]) if failure.get('kind') in NUMERIC_FAILURES]
            if name=='short-halo23':meaningful=[failure for failure in meaningful if failure.get('scene')=='pilot-pointwise-context-halo24' and failure.get('point')==[12,4] and failure.get('kind') in ('strict-pre-final-rgb','final-rgb')]
            require(rejected.get('status')=='failed' and rejected.get('referenceKind')==PROOF_KIND and rejected.get('group')==group and rejected.get('configurations')==GROUP_COUNTS[group] and rejected.get('planSha256')==plan['planSha256'] and rejected.get('referenceSha256')==sha(reference_path) and rejected.get('sourceBindings')==bindings and rejected.get('runtimeFingerprint')==runtime and rejected.get('wordOracle')==word_oracle and rejected.get('generatorSha256')==actual['generatorSha256'] and rejected.get('candidateSha256')==sha(fake) and meaningful,'Actual numeric counterexample is missing for '+name)
            paths += [negative,fake]
    require(set(receipts)==set(GROUP_COUNTS),'All five executed numerical groups156/84/12/180/15 are required before a quality freeze')
    return receipts,paths,outcomes,runtime,word_oracle


def verify_selection(selection_audit,selection_sha,policy):
    selection_audit=artifact_path(selection_audit)
    require(sha(selection_audit)==selection_sha,'Independent selection audit SHA differs')
    selection=read_json(selection_audit,'Independent C15 selection audit');summary=selection.get('summary',{})
    require(selection.get('version')=='c15-independent-retained-input-selection-audit-v1' and selection.get('status')=='passed' and selection.get('failures')==[] and selection.get('candidateImported') is False and selection.get('referenceGenerated') is False and selection.get('filterExecutions')==0 and summary.get('selectedRecords')==44 and summary.get('uniqueSourceRows')==44 and summary.get('same44RecordSetIgnoringOnlyStage') is True and summary.get('stages')==policy['stages'] and selection.get('currentPolicy',{}).get('sha256')==sha(POLICY),'Independent C15 selection is incomplete or belongs to another policy')
    expected=policy_evidence(policy);actual=selection.get('policyEvidence',{})
    require(set(actual)==set(expected),'Independent selection must bind the exact14 named evidence pins')
    paths=[selection_audit]
    for key,item in expected.items():
        path=artifact_path(item['path']);record=actual[key]
        require(record.get('path')==item['path'] and record.get('matched') is True and record.get('expectedSha256')==item['sha256'] and record.get('actualSha256')==item['sha256'] and sha(path)==item['sha256'] and record.get('size')==path.stat().st_size,'Changed retained evidence pin '+key)
        paths.append(path)
    selected=selection.get('selectionRecords',{});selected_path=artifact_path(selected.get('path',''))
    require(selected.get('records')==44 and sha(selected_path)==selected.get('sha256') and selected_path.stat().st_size==selected.get('size'),'Full44 selected-record binding is missing')
    full=read_json(selected_path,'Full44 selected records')
    if isinstance(full,dict):full=full.get('records')
    require(isinstance(full,list) and len(full)==44,'Full44 selected records are incomplete')
    old_path=artifact_path(selection['c12FrozenDeclaration']['path'])
    require(sha(old_path)==selection['c12FrozenDeclaration']['sha256'],'Audited C12 input declaration changed')
    old=read_json(old_path,'C12 input declaration')
    stripped=lambda rows:{(row['source'],row['row']):{key:value for key,value in row.items() if key!='stage'} for row in rows}
    require(stripped(full)==stripped(old['records']),'Selected full source/estimate/metric fields changed from C12')
    expected_stage={(stage['source'],row):stage['id'] for stage in policy['stages'] for row in stage['rows']}
    require([(row['source'],row['row']) for row in full]==list(expected_stage) and all(row['stage']==expected_stage[(row['source'],row['row'])] for row in full),'Selected44 row/stage order changed')
    metadata=selection.get('records',[])
    require(len(metadata)==44,'Selection digest rows are missing')
    for actual_row,row in zip(metadata,full):
        require(actual_row.get('source')==row['source'] and actual_row.get('row')==row['row'] and actual_row.get('newStage')==row['stage'] and actual_row.get('recordWithoutStagePythonSha256')==hashlib.sha256(canonical({key:value for key,value in row.items() if key!='stage'})).hexdigest() and actual_row.get('estimatePythonSha256')==hashlib.sha256(canonical(row['estimate'])).hexdigest() and actual_row.get('oldMetricsPythonSha256')==hashlib.sha256(canonical(row['oldMetrics'])).hexdigest(),'Independent full-record canonical digests differ')
    paths += [selected_path,old_path]
    return selection,old,full,paths


def verify_output_rows(directory,rows,d,stage,require_pass):
    records=[r for r in d['records']if r['stage']==stage['id']]
    if len(rows)!=len(stage['rows']) or [r['row']for r in rows]!=stage['rows'] or len(records)!=len(rows):
        raise RuntimeError('A stage receipt does not contain every declared row in order')
    for row,rec in zip(rows,records):
        if (row['stage']!=stage['id'] or row['recipe']!=rec['recipe'] or row.get('candidate')!=d['policy']['candidate']
            or row['inputHashes']!={x['kind']:x['sha256']for x in rec['inputs']}
            or row['diagnostics'].get('estimator')!=rec['estimate']):
            raise RuntimeError('Result source/candidate/estimate association changed')
        metrics=row['metrics'];gates=metrics.get('gates',{})
        if (metrics.get('required')is not True or metrics.get('cohort')!=rec['oldMetrics']['cohort']
            or not set(rec['oldMetrics']['gates'])<=set(gates)
            or 'sourceAlphaWordsExact'not in gates or any(type(v)is not bool for v in gates.values())):
            raise RuntimeError('Required gates or source classification changed')
        failed=sorted(k for k,v in gates.items()if not v)
        if row['requiredFailedGates']!=failed or (require_pass and failed):raise RuntimeError('A previous stage has failed mandatory gates')
        output=pathlib.Path(row['outputPath']).resolve()
        if output.parent!=directory.resolve() or output.name!=f'case-{rec["row"]}-{stage["id"]}.f32':
            raise RuntimeError('Result output is outside its owned stage directory')
        if output.is_symlink() or output.stat().st_size!=rec['width']*rec['height']*16 or sha(output)!=row['outputSha256']:
            raise RuntimeError('Stage output bytes/hash/dimensions changed')
        data=output.read_bytes();source=artifact_path(next(x['path']for x in rec['inputs']if x['kind']=='entering')).read_bytes()
        actual_alpha=all(data[i:i+4]==source[i:i+4]for i in range(12,len(data),16))
        if gates['sourceAlphaWordsExact']is not actual_alpha or (require_pass and not actual_alpha):
            raise RuntimeError('Stage alpha words differ from the recorded gate')
        actual_finite=all(math.isfinite(v)for pixel in struct.iter_unpack('<4f',data)for v in pixel)
        if gates.get('finite')is not actual_finite:raise RuntimeError('Stage finite gate differs from output words')


def prior_receipts(args,d,declaration_sha,stage):
    previous={};summaries={}
    for path,expected in args:
        path=pathlib.Path(path).resolve()
        if sha(path)!=expected:raise RuntimeError('Earlier-stage summary hash changed')
        q=json.loads(path.read_text());name=q.get('stage')
        if name in previous:raise RuntimeError('Repeated prior-stage receipt')
        spec=next((x for x in d['policy']['stages']if x['id']==name),None)
        if (spec is None or q.get('version')!=VERSION or q.get('driverId')!=DRIVER_ID
            or q.get('driverSha256')!=d['driver']['sha256'] or q.get('declarationSha256')!=declaration_sha
            or type(q.get('completed'))is not int or type(q.get('planned'))is not int
            or q['completed']!=len(spec['rows']) or q['planned']!=len(spec['rows'])
            or q.get('stagePassed')is not True or q.get('requiredFailures')!=[]
            or q.get('pinsUnchanged')is not True or q.get('copiesUnchanged')is not True
            or q.get('outputsVerified')!=len(spec['rows']) or q.get('fullScreenComplete')is not (name==STAGES[-1])
            or q.get('state')!='complete-selected-regression-stage-no-adoption' or q.get('adoption')is not False
            or q.get('helperProofs')!=d['helperProofs'] or set(q.get('priorReceipts',{}))!=set(spec['requiredEarlierStages'])):
            raise RuntimeError('Earlier receipt is incomplete or belongs to another driver/declaration')
        result_path=path.parent/'results.json';cleanup_path=path.parent/'cleanup.json'
        if sha(result_path)!=q.get('resultsSha256')or sha(cleanup_path)!=q.get('cleanupSha256'):
            raise RuntimeError('Prior result/cleanup bytes changed')
        cleanup=json.loads(cleanup_path.read_text())
        if (cleanup.get('version')!=VERSION or cleanup.get('driverId')!=DRIVER_ID
            or cleanup.get('driverSha256')!=d['driver']['sha256']
            or cleanup.get('stage')!=name or cleanup.get('declarationSha256')!=declaration_sha
            or cleanup.get('ownedLockReleased')is not True or cleanup.get('childrenStarted')!=0
            or cleanup.get('bytecodeWritesDisabled')is not True or cleanup.get('errorRecorded')is not False
            or cleanup.get('completed')!=len(spec['rows'])or cleanup.get('planned')!=len(spec['rows'])):
            raise RuntimeError('Earlier stage did not retire cleanly')
        verify_output_rows(path.parent,json.loads(result_path.read_text()),d,spec,True)
        previous[name]={'path':str(path),'sha256':expected};summaries[name]=q
    if set(previous)!=set(stage['requiredEarlierStages']):raise RuntimeError('Exactly the complete passing prior stages are required')
    for name,q in summaries.items():
        spec=next(item for item in d['policy']['stages'] if item['id']==name)
        if q.get('priorReceipts')!={key:previous[key] for key in spec['requiredEarlierStages']}:raise RuntimeError('Prior receipt mixes a different predecessor path/hash lineage')
    check(d['pins']);check(d['sourceCopies'])
    return previous


def plan():
    policy=read_json(POLICY,'C15 prospective policy');validate_stages(policy)
    return {'version':VERSION,'candidate':policy['candidate']['id'],'stages':[{'id':stage['id'],'source':stage['source'],'rows':stage['rows'],'cases':len(stage['rows']),'requiredEarlierStages':stage['requiredEarlierStages']} for stage in policy['stages']],'total':44,'requiredMathGroups':GROUP_COUNTS,'requiredPolicyEvidencePins':14,'candidateImported':False,'filteringPerformed':False,'adoption':False,'readiness':'Full five-group proofs and independent selection required; --plan creates no artifacts.'}


def freeze_unlocked(proofs,math_approval,selection_audit,selection_sha,verification_receipt,freeze_directory):
    policy=read_json(POLICY,'C15 policy');validate_stages(policy)
    receipts,paths,outcomes,proof_runtime,word_oracle=verify_numeric_proofs(proofs,math_approval,verification_receipt)
    selection,old_declaration,selected_records,selection_paths=verify_selection(selection_audit,selection_sha,policy)
    paths += selection_paths + [HERE/'gpu-study.py',HERE/'study-audit.py',ROOT/'tests/strong-noise-chroma-pilot.spec.ts',ROOT/'AGENTS.md',ROOT/'assets/README.md',pathlib.Path(__file__).resolve()]
    records=[]
    rowsets={}
    for name,source in policy['retainedInputs'].items():
        source_directory=artifact_path(source['directory']);result=source_directory/'results.jsonl'
        if sha(result)!=source['resultsSha256']:raise RuntimeError('Retained result stream differs from prospective protocol')
        rowsets[name]=[json.loads(s)for s in result.read_text().splitlines()]
        for n in ['results.jsonl','declaration.json','source-pins.json','summary.json','failure.json','cleanup.json','requests.jsonl']:
            p=source_directory/n
            if p.exists():paths.append(p)
    high=artifact_path(policy['retainedInputs']['edges']['directory']);old=high/'sources/scripts/research';paths += [old/'detail-candidates.py',old/'color-reference.py',old/'strong-noise/cases.py']
    archived_pins=json.loads((high/'source-pins.json').read_text())
    for relative in ['scripts/research/detail-candidates.py','scripts/research/color-reference.py','scripts/research/strong-noise/cases.py']:
        original=ROOT/relative;expected_pins=[p for p in archived_pins if artifact_path(p['path'])==original]
        archived=high/'sources'/relative
        if len(expected_pins)!=1 or sha(archived)!=expected_pins[0]['sha256']:raise RuntimeError('Retained archived metric helper differs from its source declaration')
    for stage in policy['stages']:
        for i in stage['rows']:
            row=rowsets[stage['source']][i];recipe=row['recipe'];w=h=136 if recipe['high'] or recipe.get('population') else None
            if w is None:w,h=32,24
            files={x['kind']:x for x in row['inputs']}
            if set(files)!={'clean','entering'}:raise RuntimeError('Unexpected input association')
            for x in files.values():
                p=artifact_path(x['path'])
                if sha(p)!=x['sha256'] or p.stat().st_size!=w*h*16:raise RuntimeError('Input bytes/hash/dimensions mismatch')
                paths.append(p)
            if sha(artifact_path(row['float32OutputPath']))!=row['float32OutputSha256']:raise RuntimeError('Retained rejected comparator changed')
            paths.append(artifact_path(row['float32OutputPath']))
            estimate=row['diagnostics'][policy['retainedInputs'][stage['source']]['estimator'].split('.')[-1]]
            if estimate['version']!='frozen-global-directional-mad-v1' or len(estimate['variance'])!=3 or any(not math.isfinite(v)or v<0 for v in estimate['variance']):raise RuntimeError('Invalid frozen full-source estimator')
            if 'source'in estimate and any(estimate['source'].get(k)!=v for k,v in {'width':w,'height':h,'sha256':files['entering']['sha256'],'primaries':recipe['primaries']}.items()):raise RuntimeError('Frozen estimator source mismatch')
            if estimate.get('available')is not True or len(estimate.get('directions',[]))!=4:raise RuntimeError('Missing full-source directional estimate descriptor')
            for direction,actual in zip(((1,0),(0,1),(1,1),(1,-1)),estimate['directions']):
                possible=(w-abs(direction[0]))*(h-abs(direction[1]))
                if actual.get('direction')!=list(direction)or actual.get('availablePairs')!=possible or actual.get('stratifiedPairs')!=min(65536,possible)or not 16<=actual.get('validPairs',0)<=min(65536,possible):raise RuntimeError('Invalid full-source estimator direction coverage')
            if row['metrics']['required']is not True:raise RuntimeError('Diagnostic stage contains nonmandatory source')
            records.append({'stage':stage['id'],'row':i,'source':stage['source'],'recipe':recipe,'width':w,'height':h,'inputs':row['inputs'],'estimate':estimate,'oldMetrics':row['metrics'],'oldOutput':{'path':row['float32OutputPath'],'sha256':row['float32OutputSha256']}})
    edges={('isoluminant',seed,primary,.1,strength)for seed in (1,0xdeadbeef)for primary in ('srgb','rec2020')for strength in (75,100)}
    context_edges={r for r in edges if r[1]==1 and r[4]==75}
    expected_recipes={
        STAGES[0]:context_edges,STAGES[1]:edges-context_edges,
        STAGES[2]:{(name,seed,primary,.1,strength)for name in ('flat-luminance','flat-chroma','mixed-flat')for seed in (1,0xdeadbeef)for primary in ('srgb','rec2020')for strength in (75,100)},
        STAGES[3]:{(name,0x85ebca6b,primary,.012,50)for name in ('period-2','period-4','color-a-period-2','color-a-period-4','color-b-period-2','color-b-period-4')for primary in ('srgb','rec2020')},
    }
    for name,expected_set in expected_recipes.items():
        actual=[(r['recipe']['name'],r['recipe']['seed'],r['recipe']['primaries'],r['recipe']['sigma'],r['recipe']['strength'])for r in records if r['stage']==name]
        if len(actual)!=len(expected_set)or set(actual)!=expected_set:raise RuntimeError('Stage source population changed for '+name)
    stripped=lambda rows:{(r['source'],r['row']):{k:v for k,v in r.items()if k!='stage'}for r in rows}
    if len(records)!=44 or stripped(records)!=stripped(old_declaration['records']):raise RuntimeError('C15 inputs/estimators/metrics are not exactly the retained C12 population')
    if records!=selected_records:raise RuntimeError('Independent selected full records differ from frozen source streams')
    d={'version':VERSION,'driver':{'id':DRIVER_ID,'path':str(pathlib.Path(__file__).resolve()),'sha256':sha(__file__)},'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'policy':policy,'plan':plan(),'helperProofs':receipts,'mathApproval':{'path':str(pathlib.Path(math_approval).resolve()),'sha256':sha(math_approval)},'selectionAudit':{'path':str(selection_audit.resolve()),'sha256':selection_sha},'verificationReceipt':{'path':str(verification_receipt.resolve()),'sha256':sha(verification_receipt),'outcomes':outcomes},'records':records,'python':sys.version,'pythonExecutable':str(pathlib.Path(sys.executable).resolve()),'originalModel':str(old/'detail-candidates.py'),'originalCases':str(old/'strong-noise/cases.py'),'candidateModule':str(HERE/'chroma-pilot-pointwise.py'),'computationModel':str(ROOT/'scripts/research/detail-candidates.py'),'proofRuntime':proof_runtime,'wordOracle':word_oracle,'sourceRootMappings':[[str(a),str(b)]for a,b in SOURCE_ROOTS],'scope':'Examined regressions only. No new source/estimator/threshold or production adoption.'}
    return assemble_freeze(freeze_directory,paths,d)

def freeze(proofs,math_approval,selection_audit,selection_sha,verification_receipt):
    # Preflight before lock/output/archive creation: publication-only proof is incomplete.
    policy=read_json(POLICY,'C15 policy');validate_stages(policy)
    _,proof_paths,_,_,_=verify_numeric_proofs(proofs,math_approval,verification_receipt)
    _,_,selected_records,selection_paths=verify_selection(selection_audit,selection_sha,policy)
    protected=[artifact_path(item['directory']) for item in policy['retainedInputs'].values()]
    protected += [pathlib.Path(path).resolve().parent for path in proof_paths+selection_paths
                  if pathlib.Path(path).resolve().is_relative_to((ROOT/'artifacts').resolve())]
    protected += [artifact_path(item['path']).parent for row in selected_records for item in row['inputs']]
    protected += [artifact_path(row['oldOutput']['path']).parent for row in selected_records]
    runtime=load('c15_freeze_invocation',HERE/'gpu-study.py')
    runtime.LOCK=ROOT/'artifacts/verification/.invocation-lock'
    invocation=guarded_invocation(runtime,'c15-candidate-free-freeze',None)
    freeze_directory=FreezeDestination.create(OUT,invocation.token,protected)
    invocation.audit_path=freeze_directory.target('acquisition.json')
    invocation.freeze_destination=freeze_directory
    try:
        with invocation:
            owner=runtime.LOCK/'owner.json';identity=json.loads(owner.read_text())
            identity['artifacts']=str(freeze_directory.root);save(owner,identity)
            result=freeze_unlocked(proofs,math_approval,selection_audit,selection_sha,verification_receipt,freeze_directory)
            expected=freeze_directory.target('declaration.json')
            if pathlib.Path(result['declaration']).resolve()!=expected or sha(expected)!=result['sha256']:
                raise RuntimeError('Freeze returned a declaration outside its captured fresh destination.')
        freeze_directory.validate()
        if pathlib.Path(result['declaration']).resolve()!=freeze_directory.target('declaration.json'):
            raise RuntimeError('Freeze declaration destination changed before reporting.')
    except BaseException as error:
        freeze_directory.write_json('failure.json',{'version':VERSION,'driverId':DRIVER_ID,
            'error':repr(error),'ownedLockAcquired':invocation.acquired,
            'ownedLockReleased':invocation.retired,'candidateImported':False,'filteringPerformed':False})
        raise
    print(json.dumps(result),flush=True)

def execute(path,expected,stage_id,receipt_args):
    path=pathlib.Path(path).resolve()
    if sha(path)!=expected:raise RuntimeError('Reviewed C15 declaration SHA mismatch')
    d=json.loads(path.read_text());validate_stages(d['policy'])
    driver=d.get('driver',{})
    if (d.get('version')!=VERSION or driver.get('id')!=DRIVER_ID
        or driver.get('path')!=str(pathlib.Path(__file__).resolve())or driver.get('sha256')!=sha(__file__)
        or d['python']!=sys.version or d['pythonExecutable']!=str(pathlib.Path(sys.executable).resolve())):
        raise RuntimeError('Driver/declaration/runtime identity differs from the reviewed freeze')
    if d.get('sourceRootMappings')!=[[str(a),str(b)]for a,b in SOURCE_ROOTS] or d.get('proofRuntime')!=runtime_fingerprint():raise RuntimeError('Frozen source-root/runtime identity changed')
    check(d['pins']);check(d['sourceCopies'])
    stage=next((s for s in d['policy']['stages']if s['id']==stage_id),None)
    if stage is None:raise RuntimeError('Undeclared stage')
    previous=prior_receipts(receipt_args,d,expected,stage)
    copies={x['original']:x['path']for x in d['sourceCopies']}
    runtime=load('c15_invocation',copies[str(HERE/'gpu-study.py')])
    runtime.LOCK=ROOT/'artifacts/verification/.invocation-lock'
    OUT.mkdir(parents=True,exist_ok=True)
    output=pathlib.Path(tempfile.mkdtemp(prefix='run-'+stage_id+'-',dir=OUT))
    results=[];problem=None;cleanup_problem=None;cleanup=None
    invocation=guarded_invocation(runtime,'c15-retained-regression-screen',output/'acquisition.json')
    started=time.monotonic();token=invocation.token
    try:
        with invocation:
            owner=runtime.LOCK/'owner.json';identity=json.loads(owner.read_text())
            identity['artifacts']=str(output);save(owner,identity)
            save(output/'owner.json',identity);save(output/'declaration.json',d)
            model=load('c15_frozen_computation_model',copies[d['computationModel']])
            metric_model=load('c15_frozen_original_metric_model',copies[d['originalModel']])
            cases=load('c15_frozen_cases',copies[d['originalCases']])
            method=load('c15_frozen_method',copies[d['candidateModule']])
            for rec in [x for x in d['records']if x['stage']==stage_id]:
                check(d['pins']);check(d['sourceCopies'])
                inputs={x['kind']:x for x in rec['inputs']}
                entering=artifact_path(inputs['entering']['path']).read_bytes()
                clean=artifact_path(inputs['clean']['path']).read_bytes()
                w,h=rec['width'],rec['height'];recipe=rec['recipe']
                if len(entering)!=w*h*16 or len(clean)!=w*h*16:raise RuntimeError('Frozen input dimensions changed')
                source=[list(p)for p in struct.iter_unpack('<4f',entering)]
                truth=[list(p)for p in struct.iter_unpack('<4f',clean)]
                only_l=recipe['name'].startswith('period-')or recipe['name']=='flat-luminance'
                only_c=recipe['name']=='flat-chroma'or recipe['name'].startswith('color-')
                amount=recipe['strength'];l,c=(0 if only_c else amount,0 if only_l else amount)
                case={**recipe,'width':w,'height':h,'luminance':l,'chroma':c,'clean':truth,'entering':source,
                      'cohort':recipe.get('cohort','high-required'if recipe['high']else'fresh-nominal-required')}
                at=time.monotonic()
                filtered,diagnostics=method.denoise(model,source,w,h,model.LUMINANCE[recipe['primaries']],
                    l,c,d['policy']['candidate'],estimate_snapshot=rec['estimate'])
                if len(filtered)!=w*h:raise RuntimeError('Candidate returned incomplete output')
                data=b''.join(struct.pack('<4f',*p)for p in filtered)
                target=output/f'case-{rec["row"]}-{stage_id}.f32'
                with target.open('xb')as stream:
                    stream.write(data);stream.flush();os.fsync(stream.fileno())
                if target.stat().st_size!=w*h*16:raise RuntimeError('Output file is incomplete')
                metrics=cases.evaluate(metric_model,case,filtered)
                metrics['gates']['sourceAlphaWordsExact']=all(data[i:i+4]==entering[i:i+4]for i in range(12,len(data),16))
                if metrics['required']is not True:raise RuntimeError('A required source changed classification')
                failed=sorted(k for k,v in metrics['gates'].items()if not v)
                row={'stage':stage_id,'row':rec['row'],'recipe':recipe,'candidate':d['policy']['candidate'],
                     'inputHashes':{k:v['sha256']for k,v in inputs.items()},'outputPath':str(target),
                     'outputSha256':sha(target),'seconds':time.monotonic()-at,'metrics':metrics,
                     'requiredFailedGates':failed,'oldMetrics':rec['oldMetrics'],'diagnostics':diagnostics}
                # Only advertise a completed row after its entire result is published.
                next_results=results+[row];save(output/'results.json',next_results);results=next_results
                save(output/'progress.json',{'completed':len(results),'planned':len(stage['rows']),
                    'requiredFailures':[{'row':r['row'],'gates':r['requiredFailedGates']}for r in results if r['requiredFailedGates']]})
                print(json.dumps({'row':rec['row'],'seconds':row['seconds'],'edgeLeakage':metrics.get('edgeLeakage'),
                                  'requiredFailures':failed}),flush=True)
            verify_output_rows(output,results,d,stage,False)
            check(d['pins']);check(d['sourceCopies'])
    except BaseException as error:
        problem=error
    finally:
        if output is not None:
            # The context manager has already attempted token-checked lock retirement.
            try:
                owner_path=runtime.LOCK/'owner.json'
                foreign_owner=json.loads(owner_path.read_text())if owner_path.exists()else None
                released=invocation.retired or not invocation.acquired
                cleanup={'version':VERSION,'driverId':DRIVER_ID,'driverSha256':driver['sha256'],
                    'declarationSha256':expected,'stage':stage_id,'completed':len(results),'planned':len(stage['rows']),
                    'ownedLockReleased':released,'ownedLockAcquired':invocation.acquired,
                    'ownerPublished':invocation.owner_published,'directoryIdentity':invocation.identity,
                    'foreignLockPresent':runtime.LOCK.exists()and released,
                    'childrenStarted':0,'bytecodeWritesDisabled':sys.dont_write_bytecode,'errorRecorded':problem is not None}
                save(output/'cleanup.json',cleanup)
                if not released:raise RuntimeError('The owned invocation lock did not retire')
            except BaseException as error:
                cleanup_problem=error
            if problem is not None or cleanup_problem is not None:
                save(output/'failure.json',{'version':VERSION,'driverId':DRIVER_ID,'declarationSha256':expected,
                    'stage':stage_id,'completed':len(results),'planned':len(stage['rows']),
                    'error':None if problem is None else repr(problem),
                    'cleanupError':None if cleanup_problem is None else repr(cleanup_problem),'adoption':False})
    if problem is not None and cleanup_problem is not None:
        raise BaseExceptionGroup('C15 execution and cleanup failed',[problem,cleanup_problem])
    if problem is not None:raise problem
    if cleanup_problem is not None:raise cleanup_problem
    failures=[{'row':r['row'],'gates':r['requiredFailedGates']}for r in results if r['requiredFailedGates']]
    summary={'version':VERSION,'driverId':DRIVER_ID,'driverSha256':driver['sha256'],
        'state':'complete-selected-regression-stage-no-adoption','stage':stage_id,'declarationSha256':expected,
        'completed':len(results),'planned':len(stage['rows']),'stagePassed':not failures,'requiredFailures':failures,
        'pinsUnchanged':True,'copiesUnchanged':True,'outputsVerified':len(results),
        'resultsSha256':sha(output/'results.json'),'cleanupSha256':sha(output/'cleanup.json'),
        'helperProofs':d['helperProofs'],'priorReceipts':previous,'elapsedSeconds':time.monotonic()-started,
        'fullScreenComplete':stage_id==STAGES[-1]and not failures,'adoption':False}
    save(output/'summary.json',summary)
    (output/'summary.md').write_text(f'C15 {stage_id}: {len(results)}/{len(stage["rows"])} completed in {summary["elapsedSeconds"]:.3f}s. Required failures: {len(failures)}.\n\nAll44 examined inputs remain mandatory for a full screen pass. No adoption or photographic acceptance.\n')
    print(json.dumps({'output':str(output),'summary':summary}),flush=True)
    return 1 if failures else 0

def cancelled(_signal,_frame):
    raise KeyboardInterrupt('Owned C15 screen interrupted; preserve partial evidence.')

if __name__=='__main__':
    signal.signal(signal.SIGTERM,cancelled)
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--plan',action='store_true');mode.add_argument('--freeze',action='store_true');mode.add_argument('--execute',action='store_true')
    parser.add_argument('--repository-root',type=pathlib.Path,default=ROOT)
    parser.add_argument('--output-root',type=pathlib.Path)
    parser.add_argument('--source-root',nargs=2,action='append',default=[],metavar=('RECORDED_ROOT','CURRENT_ROOT'))
    parser.add_argument('--proof-root',type=pathlib.Path);parser.add_argument('--math-approval',type=pathlib.Path)
    parser.add_argument('--selection-audit',type=pathlib.Path);parser.add_argument('--selection-sha256')
    parser.add_argument('--verification-receipt',type=pathlib.Path)
    parser.add_argument('--declaration',type=pathlib.Path);parser.add_argument('--sha256');parser.add_argument('--stage',choices=STAGES)
    parser.add_argument('--receipt',nargs=2,action='append',default=[])
    args=parser.parse_args()
    ROOT=args.repository_root.resolve();HERE=ROOT/'scripts/research/strong-noise';POLICY=HERE/'comparison15.json'
    OUT=(args.output_root or ROOT/'artifacts/detail-research/strong-noise/comparison15-retained').resolve()
    SOURCE_ROOTS=[(pathlib.Path(a).resolve(),pathlib.Path(b).resolve())for a,b in args.source_root]
    if not OUT.is_relative_to(ROOT/'artifacts'):parser.error('--output-root must stay under repository artifacts/')
    if len({a for a,_ in SOURCE_ROOTS})!=len(SOURCE_ROOTS) or any(a!=b and (a.is_relative_to(b) or b.is_relative_to(a)) for a,_ in SOURCE_ROOTS for b,_ in SOURCE_ROOTS):parser.error('Source-root mappings must have unique nonoverlapping recorded roots')
    try:
        if args.plan:print(json.dumps(plan(),indent=2))
        elif args.freeze:
            if not(args.proof_root and args.math_approval and args.selection_audit and args.selection_sha256 and args.verification_receipt):raise IncompleteVerification('--freeze requires --proof-root --math-approval --selection-audit --selection-sha256 --verification-receipt')
            freeze(args.proof_root,args.math_approval,args.selection_audit,args.selection_sha256,args.verification_receipt)
        else:
            if not(args.declaration and args.sha256 and args.stage):parser.error('--execute requires --declaration --sha256 --stage')
            raise SystemExit(execute(args.declaration,args.sha256,args.stage,args.receipt))
    except IncompleteVerification as error:
        print(json.dumps({'status':'incomplete','error':str(error),'candidateImported':False,'filteringPerformed':False,'adoption':False}),file=sys.stderr)
        raise SystemExit(2)
    except (OSError,ValueError,KeyError,TypeError) as error:
        if args.execute:raise
        print(json.dumps({'status':'incomplete','error':str(error),'candidateImported':False,'filteringPerformed':False,'adoption':False}),file=sys.stderr)
        raise SystemExit(2)

