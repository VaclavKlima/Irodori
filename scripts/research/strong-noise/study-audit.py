#!/usr/bin/env python3
"""Audit retained research rows without importing a filter, estimator or GPU."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

VERSION = 'strong-noise-retained-row-audit-v1'
MAXIMUM_ROW_BYTES = 4 * 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def atomic_json(path, value):
    """Flush a complete replacement before publishing its directory entry."""
    path = Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.' + path.name + '-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(value, indent=2, allow_nan=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        if hasattr(os, 'O_DIRECTORY'):
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class RowAudit:
    """One accumulator for live progress and the authoritative retained-row replay."""
    def __init__(self, plan, cpu_expected=False):
        self.plan = plan
        self.cpu_expected = cpu_expected
        self.expected = [(recipe, candidate) for recipe in plan['selected']
                         for candidate in plan['candidates']]
        self.positions = {(canonical(recipe), candidate['id']): index
                          for index, (recipe, candidate) in enumerate(self.expected)}
        self.last_position = -1
        self.completed = 0
        self.required_failures = []
        self.cpu_comparisons = 0
        self.cpu_failures = 0
        self.cpu_agreements = []
        self.invalid_rows = 0
        self.problems = []
        self.tail = None
        self.last = None
        if (type(plan['plannedMeasurements']) is not int
            or plan['plannedMeasurements'] != len(self.expected)
            or len(self.positions) != len(self.expected)):
            self.problem('Declared measurement count or identities are inconsistent.')

    def problem(self, message, line=None):
        self.invalid_rows += 1
        if len(self.problems) < 16:
            self.problems.append({'line': line, 'message': message})

    def append(self, row, line=None):
        """Accept only the next complete declared measurement and Boolean gates."""
        try:
            position = self.positions.get((canonical(row['recipe']), row['candidate']['id']))
            if position is None or position <= self.last_position:
                raise ValueError('Result is undeclared, repeated or out of order.')
            recipe, candidate = self.expected[position]
            if row['recipe'] != recipe or row['candidate'] != candidate:
                raise ValueError('Result order, recipe or complete candidate differs from the plan.')
            metrics = row['metrics']
            if (type(metrics['required']) is not bool or not isinstance(metrics['cohort'], str)
                or not isinstance(metrics['gates'], dict) or not metrics['gates']
                or any(not isinstance(name, str) or type(valid) is not bool
                       for name, valid in metrics['gates'].items())):
                raise ValueError('Result requires explicit Boolean quality gates and cohort.')
            agreement = row.get('cpuAgreement')
            if self.cpu_expected != (agreement is not None):
                raise ValueError('CPU agreement presence differs from the frozen declaration.')
            if agreement is not None:
                if (type(agreement['passed']) is not bool
                    or type(agreement['rgbAndAlphaPassed']) is not bool
                    or type(agreement['estimator']['passed']) is not bool
                    or agreement['passed'] != (agreement['rgbAndAlphaPassed'] and agreement['estimator']['passed'])
                    or metrics['gates'].get('frozenCpuRgbAndAlphaAgreement') is not agreement['rgbAndAlphaPassed']
                    or metrics['gates'].get('frozenCpuEstimatorAgreement') is not agreement['estimator']['passed']):
                    raise ValueError('CPU agreement and retained Boolean gates disagree.')
            if position != self.last_position + 1:
                self.problem('A declared measurement is missing before this result.', line)
            failed = [name for name, valid in metrics['gates'].items() if not valid]
            if metrics['required'] and failed:
                self.required_failures.append({'recipe': recipe, 'candidate': candidate['id'],
                    'gates': failed, 'cohort': metrics['cohort'],
                    'adoptionCandidate': candidate['adoptionCandidate']})
            if agreement is not None:
                self.cpu_comparisons += 1
                self.cpu_failures += int(not agreement['passed'])
                self.cpu_agreements.append({'recipe': recipe, 'candidate': candidate['id'], **agreement})
            self.completed += 1
            self.last_position = position
            self.last = {'recipe': recipe, 'candidate': candidate['id']}
            return True
        except (KeyError, TypeError, ValueError) as error:
            self.problem(str(error), line)
            return False

    def snapshot(self):
        return {'version': VERSION, 'completed': self.completed,
            'planned': self.plan['plannedMeasurements'], 'last': self.last,
            'requiredFailures': self.required_failures,
            'requiredFailureCount': len(self.required_failures),
            'candidateRejectionObserved': any(row['adoptionCandidate']
                                              for row in self.required_failures),
            'cpuComparisons': self.cpu_comparisons, 'cpuAgreementFailures': self.cpu_failures,
            'invalidRowCount': self.invalid_rows, 'rowProblems': self.problems,
            'incompleteTail': self.tail,
            'selectedMeasurementsComplete': (self.completed == self.plan['plannedMeasurements']
                                             and self.invalid_rows == 0 and self.tail is None),
            'adoption': False}


def replay_rows(path, accumulator):
    """Retain failures before a malformed or interrupted tail; never accept that tail."""
    path = Path(path)
    if not path.is_file():
        accumulator.problem('The retained result stream is missing.')
        return
    with path.open('rb') as stream:
        line_number = 0
        while True:
            offset = stream.tell()
            line = stream.readline(MAXIMUM_ROW_BYTES + 1)
            if not line:
                break
            line_number += 1
            if len(line) > MAXIMUM_ROW_BYTES:
                size = len(line)
                terminated = line.endswith(b'\n')
                while not terminated:
                    remainder = stream.readline(MAXIMUM_ROW_BYTES + 1)
                    if not remainder:
                        break
                    size += len(remainder)
                    terminated = remainder.endswith(b'\n')
                accumulator.problem('Result line exceeds the audit byte limit.', line_number)
                if not terminated:
                    accumulator.tail = {'line': line_number, 'offset': offset, 'bytes': size}
                continue
            if not line.endswith(b'\n'):
                accumulator.tail = {'line': line_number, 'offset': offset, 'bytes': len(line)}
                continue
            try:
                row = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError('Nonfinite JSON constant: ' + value)))
                accumulator.append(row, line_number)
            except (ValueError, UnicodeError) as error:
                accumulator.problem('Malformed result JSON: ' + str(error), line_number)


def audit_run(directory, execution_state=None):
    """Reconstruct observed gates; neither rerun algorithms nor certify all stages."""
    directory = Path(directory).resolve()
    names = ('declaration.json', 'plan.json', 'source-pins.json', 'results.jsonl',
             'cleanup.json', 'failure.json', 'progress.json', 'provenance.json',
             'qualification-reproduction.json')
    def input_pins():
        return [{'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest(path)}
                for path in (directory / name for name in names) if path.is_file()]
    before = input_pins()
    declaration = json.loads((directory / 'declaration.json').read_text())
    plan = json.loads((directory / 'plan.json').read_text())
    accumulator = RowAudit(plan, declaration.get('cpuEvidence') is not None)
    if declaration.get('plan') != plan:
        accumulator.problem('Run plan differs from the retained declaration.')
    source_pins = directory / 'source-pins.json'
    if not source_pins.is_file() or json.loads(source_pins.read_text()) != declaration.get('sources'):
        accumulator.problem('Run source pins differ from the retained declaration.')
    replay_rows(directory / 'results.jsonl', accumulator)
    cleanup_path, failure_path = directory / 'cleanup.json', directory / 'failure.json'
    cleanup = json.loads(cleanup_path.read_text()) if cleanup_path.is_file() else {}
    failure = json.loads(failure_path.read_text()) if failure_path.is_file() else None
    if execution_state is None:
        execution_state = ('interrupted' if failure and 'KeyboardInterrupt' in failure.get('error', '')
                           else 'failed' if failure else 'unknown')
    closed = (cleanup.get('childClosed') is True and cleanup.get('readerJoined') is True
              and type(cleanup.get('pid')) is int and type(cleanup.get('returncode')) is int)
    after = input_pins()
    if before != after:
        accumulator.problem('Audit inputs changed during replay; preserve this incomplete snapshot.')
    result = accumulator.snapshot()
    complete = result['selectedMeasurementsComplete'] and execution_state == 'completed' and closed
    result.update({'state': 'research-complete-no-adoption' if complete else
                       f'research-{execution_state}-incomplete-no-adoption',
        'runDirectory': str(directory), 'plan': plan, 'executionState': execution_state,
        'childClosed': closed, 'cleanup': cleanup, 'failure': failure,
        'selectedRunComplete': complete, 'stageComplete': complete and not plan['partialStage'],
        'allC9StagesComplete': False,
        'cpuAgreementRecords': accumulator.cpu_agreements,
        'sourceContentRevalidated': False,
        'auditInputsStable': before == after,
        'scope': 'Retained Boolean gates and completion only; no filtering, source revalidation or adoption.',
        'inputPins': before})
    if before != after:
        result['inputPinsAfter'] = after
    return result


def publish_summary(directory, result):
    directory = Path(directory)
    atomic_json(directory / 'summary.json', result)
    text = (f'Research state: {result["state"]}. Completed {result["completed"]}/{result["planned"]} '
            f'measurements; mandatory failures: {result["requiredFailureCount"]}; '
            f'CPU agreement failures: {result["cpuAgreementFailures"]}/{result["cpuComparisons"]}.\n\n'
            f'Invalid rows: {result["invalidRowCount"]}; incomplete tail: {result["incompleteTail"] is not None}; '
            f'child closure recorded: {result["childClosed"]}. No algorithm rerun or adoption.\n')
    (directory / 'summary.md').write_text(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    original, output = args.run_dir.resolve(), args.output_dir.resolve()
    if output.is_relative_to(original) or original.is_relative_to(output):
        parser.error('Choose a separate fresh audit directory outside the original run.')
    if output.exists():
        parser.error('Preserve the earlier audit; the output directory already exists.')
    result = audit_run(original)
    output.mkdir(parents=True, exist_ok=False)
    publish_summary(output, result)
    print(json.dumps({'output': str(output), 'completed': result['completed'],
        'requiredFailures': result['requiredFailureCount'],
        'candidateRejectionObserved': result['candidateRejectionObserved'], 'adoption': False}))
    return 1 if (not result['selectedRunComplete'] or result['requiredFailures']
                 or result['cpuAgreementFailures']) else 0


if __name__ == '__main__':
    raise SystemExit(main())
