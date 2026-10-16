import { test, expect } from '@playwright/test'
import {
  ResourceAccounting,
  ownedProcesses,
  parseProcIo,
  parseProcStat,
  type ProcRecord,
} from '../scripts/research/linux-resources.mjs'

const record = (pid: number, parentPid: number, cpuTicks: number, start = 1): ProcRecord => ({
  pid,
  parentPid,
  processGroup: 10,
  sessionId: 10,
  identity: `${pid}:${start}`,
  state: 'S',
  cpuTicks,
  threads: 2,
  rssBytes: 8192,
})
const io = (count: number) => ({
  rchar: count,
  wchar: count * 2,
  read_bytes: count * 3,
  write_bytes: count * 4,
  cancelled_write_bytes: count,
})
const ioThread = (identity: string, count: number) => ({ identity, io: io(count) })

test('proc stat parser handles spaces and parentheses without counting child CPU twice', () => {
  const fields = Array.from({ length: 22 }, () => '0')
  fields[0] = 'S'
  fields[1] = '7'
  fields[2] = '42'
  fields[3] = '42'
  fields[11] = '11'
  fields[12] = '3'
  fields[13] = '9999' // Accumulated children must not enter own-process CPU accounting.
  fields[14] = '9999'
  fields[17] = '5'
  fields[19] = '12345'
  fields[21] = '17'
  expect(parseProcStat(`42 (worker (photo) name) ${fields.join(' ')}`, 4096)).toEqual({
    pid: 42,
    parentPid: 7,
    processGroup: 42,
    sessionId: 42,
    identity: '42:12345',
    state: 'S',
    cpuTicks: 14,
    threads: 5,
    rssBytes: 69632,
  })
  expect(() => parseProcStat('42 (broken) S 7', 4096)).toThrow('Invalid')
  expect(
    parseProcIo(
      'rchar: 100\nwchar: 200\nread_bytes: 300\nwrite_bytes: 400\ncancelled_write_bytes: 5',
    ),
  ).toEqual({
    rchar: 100,
    wchar: 200,
    read_bytes: 300,
    write_bytes: 400,
    cancelled_write_bytes: 5,
  })
  expect(() => parseProcIo('rchar: 100')).toThrow('Invalid')
})

test('process discovery follows descendants, retains known reparented children and rejects reused identities', () => {
  const records = [record(30, 20, 2), record(10, 1, 4), record(20, 10, 3), record(90, 1, 1)]
  expect(
    ownedProcesses(records, '10:1')
      .map((entry) => entry.pid)
      .sort(),
  ).toEqual([10, 20, 30])
  const reparented = [record(20, 1, 5), record(21, 20, 2), record(10, 1, 2, 99)]
  expect(ownedProcesses(reparented, '10:1', new Set(['20:1'])).map((entry) => entry.pid)).toEqual([
    20, 21,
  ])
})

test('aggregate accounting retains exited own counters, separate PID lifetimes, partial IO and sampled peaks', () => {
  const accounting = new ResourceAccounting(100, 2)
  accounting.observe(
    [
      { ...record(10, 1, 4), ioThreads: [ioThread('10:1', 100)] },
      { ...record(20, 10, 8), ioThreads: [] },
    ],
    0,
    2,
  )
  accounting.observe(
    [
      { ...record(10, 1, 6), ioThreads: [ioThread('10:1', 110)], threads: 3 },
      { ...record(20, 10, 10), state: 'Z', rssBytes: 0, ioThreads: [ioThread('20:1', 5)] },
    ],
    1000,
    3,
  )
  accounting.observe(
    [
      { ...record(10, 1, 7), ioThreads: [ioThread('11:2', 3)] },
      { ...record(20, 10, 2, 99), ioThreads: [], ioThreadReadFailures: 1 },
    ],
    2000,
    1,
  )
  const report = accounting.report()
  expect(report.observedOwnCpuMs).toBe(190)
  expect(report.observedProcesses).toBe(3)
  expect(report.observedIoBytes).toEqual(io(118))
  expect(report.observedIoThreads).toBe(3)
  expect(report.processesWithoutIo).toBe(1)
  expect(report.ioThreadReadFailures).toBe(1)
  expect(report.sampledPeakAggregateRssBytes).toBe(16384)
  expect(report.sampledPeakAggregateThreads).toBe(4)
  expect(report.sampledPeakAggregateProcesses).toBe(2)
  expect(report.samplerWallMs).toBe(6)
  expect(report.maxSamplerWallMs).toBe(3)
  expect(report.maxSampleGapMs).toBe(1000)
  expect(report.contextSeries).toHaveLength(2)
  expect(report.contextSeriesOmitted).toBe(1)
  const unavailable = new ResourceAccounting(100)
  unavailable.observe([record(10, 1, 1)], 0)
  expect(unavailable.report().observedIoBytes).toBeNull()
})
