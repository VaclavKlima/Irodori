"""Isolated C15 ownership/atomic-metadata checks; no processing runtime is used.

Only the actual driver module is imported from the repository. Its guard receives
a fake runtime containing a private LOCK, the base initializer and driver.save.
These cases exercise metadata lifecycle and source-archive boundaries, not filter
cancellation, quality, GPU behavior or the repository verification lock.
"""

import argparse
import builtins
from contextlib import contextmanager
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import traceback
from types import SimpleNamespace
from unittest.mock import patch
import uuid

VERSION = 'irodori-c15-isolated-guard-proof-v1'
CASES = ('normal', 'owner-write-failure', 'post-publication-failure',
         'foreign-lock', 'cancel-owner-update', 'freeze-destination-safety')


class InjectedWriteFailure(RuntimeError):
    pass


class InjectedCancellation(KeyboardInterrupt):
    pass


class Checks:
    def __init__(self):
        self.count = 0

    def __call__(self, condition, message):
        self.count += 1
        if not condition:
            raise AssertionError(message)


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def identity(path):
    info = Path(path).lstat()
    return [info.st_dev, info.st_ino]


def read_json(path):
    return json.loads(Path(path).read_text())


def temporary_files(directory):
    return sorted(str(path.relative_to(directory)) for path in directory.rglob('*.tmp'))


@contextmanager
def processing_imports_blocked(repository, driver_path, observations):
    """Fail before any nonstdlib/project dependency can execute."""
    original_import = builtins.__import__
    original_spec = importlib.util.spec_from_file_location
    standard = sys.stdlib_module_names

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        package = globals.get('__package__', '') if globals else ''
        root_name = package.split('.')[0] if level else name.split('.')[0]
        if root_name not in standard:
            observations['blockedImports'].append({'name': name, 'package': package, 'level': level})
            raise AssertionError('Isolated guard attempted a nonstdlib import: ' + name)
        observations['stdlibRoots'].add(root_name)
        return original_import(name, globals, locals, fromlist, level)

    def guarded_spec(name, location, *args, **kwargs):
        path = Path(location).resolve()
        if path.is_relative_to(repository) and path != driver_path:
            observations['blockedProjectFiles'].append(str(path))
            raise AssertionError('Isolated guard attempted a project dependency import: ' + str(path))
        return original_spec(name, location, *args, **kwargs)

    with patch.object(builtins, '__import__', guarded_import), patch.object(
            importlib.util, 'spec_from_file_location', guarded_spec):
        yield original_spec


def load_driver(driver_path, original_spec):
    spec = original_spec('_irodori_c15_isolated_guard_target', driver_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BaseInvocation:
    """Only the initializer needed by the actual GuardedInvocation subclass."""
    def __init__(self, kind):
        self.kind = kind
        self.token = str(uuid.uuid4())
        self.acquired = False


def fake_runtime(driver, directory):
    return SimpleNamespace(Invocation=BaseInvocation,
                           LOCK=directory / 'private-lock',
                           save=driver.save)


def finish_own_case(check, driver, runtime, guard, directory, expected_status):
    check(not runtime.LOCK.exists(), 'Owned private lock did not retire.')
    check(guard.acquired is True and guard.retired is True,
          'Guard did not record acquisition and retirement.')
    check(temporary_files(directory) == [], 'Atomic metadata temporary files remain.')
    audit = read_json(directory / 'acquisition.json')
    check(audit['status'] == expected_status, 'Guard audit disposition differs.')
    check(audit['token'] == guard.token and audit['pid'] == os.getpid(),
          'Guard audit owner identity differs.')
    check(audit['ownedLockReleased'] is True, 'Guard audit does not confirm owned retirement.')
    return audit


def normal(check, driver, runtime, directory):
    guard = driver.guarded_invocation(runtime, 'isolated-normal', directory / 'acquisition.json')
    with guard:
        owner = read_json(runtime.LOCK / 'owner.json')
        check(owner['token'] == guard.token and owner['pid'] == os.getpid(),
              'Actual driver did not publish its token/PID.')
        check(guard.identity == identity(runtime.LOCK), 'Captured directory identity differs.')
        check({path.name for path in runtime.LOCK.iterdir()} == {'owner.json'},
              'Normal owner publication left unknown files.')
    audit = finish_own_case(check, driver, runtime, guard, directory, 'released')
    check(audit['ownerPublished'] is True, 'Normal owner publication was not recorded.')
    return {'normalTokenLifecycle': True, 'audit': audit}


def owner_write_failure(check, driver, runtime, directory):
    observations = {}

    def fail_before_publication(path, value):
        check(Path(path) == runtime.LOCK / 'owner.json', 'Unexpected runtime metadata write.')
        observations['directoryIdentity'] = identity(runtime.LOCK)
        observations['emptyBeforeFailure'] = list(runtime.LOCK.iterdir()) == []
        raise InjectedWriteFailure('before owner publication')

    runtime.save = fail_before_publication
    guard = driver.guarded_invocation(runtime, 'isolated-owner-write-failure',
                                     directory / 'acquisition.json')
    entered, caught = False, False
    try:
        with guard:
            entered = True
    except InjectedWriteFailure:
        caught = True
    check(caught and not entered, 'Owner-write failure did not stop acquisition.')
    check(observations.get('emptyBeforeFailure') is True,
          'Failure was not injected before owner publication.')
    check(observations['directoryIdentity'] == guard.identity,
          'Retirement did not refer to the captured empty directory.')
    audit = finish_own_case(check, driver, runtime, guard, directory, 'acquisition-failed')
    check(audit['ownerPublished'] is False, 'An unpublished owner was reported as published.')
    return {'emptyCapturedInodeRetired': True, 'observations': observations, 'audit': audit}


def post_publication_failure(check, driver, runtime, directory):
    observations = {}

    def fail_after_publication(path, value):
        check(Path(path) == runtime.LOCK / 'owner.json', 'Unexpected runtime metadata write.')
        driver.save(path, value)
        observations['owner'] = read_json(path)
        observations['ownerSha256'] = digest(path)
        observations['directoryIdentity'] = identity(runtime.LOCK)
        raise InjectedWriteFailure('after owner publication')

    runtime.save = fail_after_publication
    guard = driver.guarded_invocation(runtime, 'isolated-post-publication-failure',
                                     directory / 'acquisition.json')
    entered, caught = False, False
    try:
        with guard:
            entered = True
    except InjectedWriteFailure:
        caught = True
    check(caught and not entered, 'Post-publication failure did not stop acquisition.')
    check(observations['owner']['token'] == guard.token and
          observations['owner']['pid'] == os.getpid(), 'Published failure fixture was not our owner.')
    check(observations['directoryIdentity'] == guard.identity, 'Published owner inode differs.')
    audit = finish_own_case(check, driver, runtime, guard, directory, 'acquisition-failed')
    check(audit['ownerPublished'] is True, 'Observed valid own publication was not recorded.')
    return {'publishedOwnTokenRetired': True, 'observations': observations, 'audit': audit}


def foreign_lock(check, driver, runtime, directory):
    runtime.LOCK.mkdir()
    owner = runtime.LOCK / 'owner.json'
    driver.save(owner, {'pid': -2718, 'token': 'foreign-fixture-token', 'kind': 'isolated-foreign'})
    before = owner.read_bytes()
    before_identity = identity(runtime.LOCK)
    guard = driver.guarded_invocation(runtime, 'isolated-foreign-refusal',
                                     directory / 'acquisition.json')
    entered, caught = False, False
    try:
        with guard:
            entered = True
    except FileExistsError:
        caught = True
    check(caught and not entered, 'Existing foreign fixture did not stop acquisition.')
    check(guard.acquired is False and guard.retired is False,
          'Never-acquired foreign lock was marked as owned.')
    check(owner.read_bytes() == before, 'Foreign owner bytes changed.')
    check(identity(runtime.LOCK) == before_identity, 'Foreign directory identity changed.')
    check({path.name for path in runtime.LOCK.iterdir()} == {'owner.json'},
          'Foreign lock contents changed.')
    check(temporary_files(directory) == [], 'Foreign refusal left metadata temporary files.')
    audit = read_json(directory / 'acquisition.json')
    check(audit['status'] == 'acquisition-failed' and audit['acquired'] is False,
          'Foreign refusal audit is wrong.')
    return {'foreignFixturePreserved': True,
            'ownerBeforeSha256': sha256(before).hexdigest(), 'ownerAfterSha256': digest(owner),
            'directoryBefore': before_identity, 'directoryAfter': identity(runtime.LOCK),
            'audit': audit}


def cancel_owner_update(check, driver, runtime, directory):
    guard = driver.guarded_invocation(runtime, 'isolated-cancel-owner-update',
                                     directory / 'acquisition.json')
    original_replace = driver.os.replace
    observations, caught = {}, False
    try:
        with guard:
            owner = runtime.LOCK / 'owner.json'
            before = owner.read_bytes()
            updated = {**read_json(owner), 'artifacts': str(directory / 'owned-results')}

            def cancel_replace(source, destination, *args, **kwargs):
                check(Path(destination) == owner, 'Cancellation reached an unexpected target.')
                source = Path(source)
                check(source.parent == runtime.LOCK and source.suffix == '.tmp',
                      'Atomic update did not use a private temporary beside the owner.')
                observations['replaceCalls'] = observations.get('replaceCalls', 0) + 1
                observations['temporaryPath'] = str(source)
                observations['temporaryIdentity'] = identity(source)
                observations['temporarySha256'] = digest(source)
                observations['ownerBeforeSha256'] = sha256(before).hexdigest()
                raise InjectedCancellation('during owner metadata replacement')

            try:
                # Restore os.replace before the actual guard's __exit__ runs.
                with patch.object(driver.os, 'replace', cancel_replace):
                    driver.save(owner, updated)
            except InjectedCancellation:
                check(driver.os.replace is original_replace, 'Atomic replace patch was not restored.')
                check(owner.read_bytes() == before, 'Cancelled update changed the old owner bytes.')
                check(not Path(observations['temporaryPath']).exists(),
                      'Cancelled update left its captured temporary file.')
                check(temporary_files(directory) == [], 'Cancelled update left unknown temporary files.')
                raise
    except InjectedCancellation:
        caught = True
    check(caught and observations.get('replaceCalls') == 1, 'Cancellation injection did not run once.')
    check(driver.os.replace is original_replace, 'Replace patch leaked beyond the guard.')
    audit = finish_own_case(check, driver, runtime, guard, directory, 'released')
    check('InjectedCancellation' in audit['error'], 'Cancellation was absent from the guard audit.')
    return {'cancelledAtomicUpdateRetired': True, 'observations': observations, 'audit': audit}


def tree_snapshot(root):
    result = {}
    for path in [root, *sorted(root.rglob('*'))]:
        info = path.lstat()
        result[str(path.relative_to(root))] = {
            'identity': [info.st_dev, info.st_ino], 'mode': info.st_mode,
            'bytes': info.st_size if path.is_file() else None,
            'mtimeNs': info.st_mtime_ns if path.is_file() else None,
            'sha256': digest(path) if path.is_file() else None,
        }
    return result


def freeze_destination_safety(check, driver, runtime, directory):
    """Exercise the real assembly writer with tiny source bytes, never frames."""
    repository = directory / 'mini-repository'
    artifacts = repository / 'artifacts'
    retained = [artifacts / 'retained-a', artifacts / 'retained-b']
    sources = []
    for index, old in enumerate(retained):
        old.mkdir(parents=True)
        code = old / 'helper.py'
        declaration = old / 'declaration.json'
        code.write_bytes(('unused_canary = ' + str(index) + '\n').encode('ascii'))
        declaration.write_bytes(
            ('{"retainedCanary":' + str(index) + ',"mustStayUnchanged":true}\n').encode('ascii'))
        sources.extend([code, declaration])
    before = {str(old): tree_snapshot(old) for old in retained}
    writes, refusals, factory_refusals, capability_refusals = [], [], [], []
    token = str(uuid.uuid4())
    with patch.object(driver, 'ROOT', repository):
        destination = driver.FreezeDestination.create(artifacts / 'fresh-output', token, retained)
        fresh = destination.root
        frozen_identity = identity(fresh)
        original_copy = driver.FreezeDestination.copy_source
        original_save = driver.save

        def tracked_copy(capability, source, relative, expected):
            target = capability.target(relative)
            check(target.is_relative_to(fresh), 'Actual archive copy escaped the fresh output.')
            writes.append({'operation': 'copy', 'source': str(source), 'target': str(target)})
            return original_copy(capability, source, relative, expected)

        def tracked_save(path, value):
            target = Path(path).resolve()
            check(target.is_relative_to(fresh), 'Actual metadata write escaped the fresh output.')
            writes.append({'operation': 'json', 'target': str(target)})
            return original_save(path, value)

        with patch.object(driver.FreezeDestination, 'copy_source', tracked_copy), patch.object(
                driver, 'save', tracked_save):
            # A retained Path must never substitute for the captured destination.
            for old in retained:
                count = len(writes)
                def no_directory_creation(*args, **kwargs):
                    raise AssertionError('Forbidden output parent reached directory creation.')
                try:
                    with patch.object(driver.os, 'mkdir', no_directory_creation):
                        driver.FreezeDestination.create(old, token, retained)
                except RuntimeError:
                    factory_refusals.append(str(old))
                else:
                    raise AssertionError('A retained directory was accepted as output parent.')
                try:
                    driver.assemble_freeze(old, sources, {'notAFreeze': True})
                except RuntimeError:
                    refusals.append(str(old))
                else:
                    raise AssertionError('A retained directory was accepted as freeze output.')
                # Matching an existing inode is insufficient when it contains
                # an input/source. Exercise containment after type validation.
                captured_retained = driver.FreezeDestination(old, *identity(old), token)
                try:
                    driver.assemble_freeze(captured_retained, sources, {'notAFreeze': True})
                except RuntimeError:
                    capability_refusals.append(str(old))
                else:
                    raise AssertionError('A retained-root capability accepted archive writes.')
                check(len(writes) == count, 'Forbidden destination wrote before refusal.')
                check({str(item): tree_snapshot(item) for item in retained} == before,
                      'Retained bytes or entries changed during refusal.')
            # Output self-inclusion must fail before the first archive write.
            internal = fresh / 'self-input.py'
            internal.write_bytes(b'output_must_not_be_reimported = True\n')
            internal_before = internal.read_bytes()
            count = len(writes)
            try:
                driver.assemble_freeze(destination, [*sources, internal], {'notAFreeze': True})
            except RuntimeError:
                pass
            else:
                raise AssertionError('Freeze output was accepted as an archive input.')
            check(len(writes) == count and internal.read_bytes() == internal_before,
                  'Self-inclusion refusal changed output/source bytes.')
            payload = {'version': 'isolated-freeze-assembly-regression-v1',
                       'records': [], 'canary': 'tiny metadata only'}
            result = driver.assemble_freeze(destination, sources, payload)
        expected = fresh / 'declaration.json'
        check(Path(result['declaration']) == expected and expected.is_file(),
              'Declaration was not published in the captured fresh directory.')
        check(result['sha256'] == digest(expected), 'Published declaration hash differs.')
        check(identity(fresh) == frozen_identity and destination.token == token,
              'Captured destination ownership changed.')
        manifest = read_json(expected)
        check(manifest['canary'] == payload['canary'] and manifest['records'] == [],
              'Real assembly lost the supplied metadata.')
        check(manifest['freezeDestination'] == {
            'path': str(fresh), 'device': destination.device, 'inode': destination.inode,
            'invocationToken': token}, 'Declaration recorded a different destination.')
        check(len(manifest['pins']) == len(sources) and
              len(manifest['sourceCopies']) == len(sources), 'Some source canaries were omitted.')
        expected_copies = {str(path): fresh / 'sources' / path.relative_to(repository)
                           for path in sources}
        for copied in manifest['sourceCopies']:
            source = Path(copied['original'])
            target = Path(copied['path'])
            check(target == expected_copies[str(source)] and target.is_file(),
                  'Archive path lost its original directory identity.')
            check(target.read_bytes() == source.read_bytes() and copied['sha256'] == digest(source),
                  'Actual archive bytes differ from their source canary.')
            check(identity(target) != identity(source), 'Archive is not an independent byte copy.')
        check(len({str(path) for path in expected_copies.values()}) == len(sources),
              'Same-basename source files collided in the archive.')
        check({str(old): tree_snapshot(old) for old in retained} == before,
              'Assembly mutated retained bytes or created unexpected retained files.')
        check(len(writes) == len(sources) + 1 and
              sum(row['operation'] == 'copy' for row in writes) == len(sources) and
              sum(row['operation'] == 'json' for row in writes) == 1,
              'Unexpected archive/declaration write sequence.')
        check(all(Path(row['target']).is_relative_to(fresh) for row in writes),
              'An observed actual write was outside the fresh output.')
        check(temporary_files(directory) == [], 'Assembly left metadata temporary files.')
        return {'freezeDestinationSafety': True, 'freshOutput': str(fresh),
                'declarationPath': str(expected), 'declarationSha256': digest(expected),
                'retainedDirectories': [str(old) for old in retained],
                'retainedSnapshotsBefore': before,
                'retainedSnapshotsAfter': {str(old): tree_snapshot(old) for old in retained},
                'sourceFiles': len(sources), 'observedActualWrites': writes,
                'retainedDestinationRefusals': refusals,
                'retainedFactoryRefusals': factory_refusals,
                'capturedDestinationRefusals': capability_refusals,
                'outputSelfInclusionRefused': True}


FUNCTIONS = {'normal': normal, 'owner-write-failure': owner_write_failure,
             'post-publication-failure': post_publication_failure,
             'foreign-lock': foreign_lock, 'cancel-owner-update': cancel_owner_update,
             'freeze-destination-safety': freeze_destination_safety}


def run(arguments):
    driver_path = arguments.driver.resolve(strict=True)
    repository = arguments.repository_root.resolve(strict=True)
    directory = arguments.directory.resolve()
    output = arguments.output.resolve()
    if directory.exists() or output.exists() or not driver_path.is_relative_to(repository):
        raise ValueError('Use a fresh private directory/output and the repository driver.')
    if directory.parent != output.parent:
        raise ValueError('Private fixture directory and receipt must share their owned parent.')
    directory.mkdir(mode=0o700)
    check = Checks()
    observations = {'blockedImports': [], 'blockedProjectFiles': [], 'stdlibRoots': set(),
                    'childProcessAttempts': []}
    driver_before, helper_before = digest(driver_path), digest(__file__)
    result = {'version': VERSION, 'case': arguments.case, 'status': 'failed',
              'privateDirectory': str(directory), 'python': sys.version,
              'driver': {'path': str(driver_path), 'beforeSha256': driver_before},
              'helper': {'path': str(Path(__file__).resolve()), 'beforeSha256': helper_before},
              'scope': 'Isolated guard/metadata/source-archive lifecycle only; not actual repository lock, filter cancellation, quality, app or GPU verification.'}
    try:
        check(stat.S_IMODE(directory.stat().st_mode) == 0o700, 'Fixture directory is not private.')
        with processing_imports_blocked(repository, driver_path, observations) as original_spec:
            driver = load_driver(driver_path, original_spec)
            runtime = fake_runtime(driver, directory)
            check(runtime.LOCK.parent == directory and runtime.LOCK.name == 'private-lock',
                  'The actual shared verification lock must never be used.')

            def no_process(*args, **kwargs):
                observations['childProcessAttempts'].append(repr(args[:1]))
                raise AssertionError('Isolated guard attempted to start a subprocess.')

            with patch.object(subprocess, 'run', no_process), patch.object(
                    subprocess, 'Popen', no_process):
                result['observations'] = FUNCTIONS[arguments.case](check, driver, runtime, directory)
            check(not observations['blockedImports'] and not observations['blockedProjectFiles'],
                  'The guard attempted a processing dependency import.')
            check(observations['childProcessAttempts'] == [], 'The guard attempted a child process.')
        check(driver_before == digest(driver_path), 'Driver source changed during the isolated check.')
        check(helper_before == digest(__file__), 'Helper source changed during the isolated check.')
        result['status'] = 'passed'
    except BaseException as error:
        result['error'] = repr(error)
        result['traceback'] = traceback.format_exc()
    result['driver']['afterSha256'] = digest(driver_path)
    result['helper']['afterSha256'] = digest(__file__)
    result['checks'] = check.count
    result['imports'] = {**observations, 'stdlibRoots': sorted(observations['stdlibRoots']),
                         'projectModulesExecuted': [str(driver_path)]}
    result['filterExecutions'] = 0
    result['gpuExecutions'] = 0
    result['temporaryFilesRemaining'] = temporary_files(directory)
    with output.open('x') as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write('\n')
    output.chmod(0o600)
    print(json.dumps({'status': result['status'], 'case': arguments.case,
                      'checks': check.count, 'output': str(output), 'sha256': digest(output)}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--driver', type=Path, required=True)
    parser.add_argument('--repository-root', type=Path, required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case', choices=CASES, required=True)
    raise SystemExit(run(parser.parse_args()))
