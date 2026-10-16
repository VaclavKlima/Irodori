export interface ProcRecord {
  pid: number
  parentPid: number
  processGroup: number
  sessionId: number
  identity: string
  state: string
  cpuTicks: number
  threads: number
  rssBytes: number
  ioThreads?: { identity: string; io: Record<string, number> }[]
  ioThreadReadFailures?: number
}
export function parseProcStat(text: string, pageSize: number): ProcRecord
export function parseProcIo(text: string): Record<string, number>
export function ownedProcesses(
  records: ProcRecord[],
  rootIdentity: string,
  known?: Set<string>,
): ProcRecord[]
export class ResourceAccounting {
  constructor(clockTicks: number, maxSeries?: number)
  observe(records: ProcRecord[], atMs: number, samplerWallMs?: number): void
  report(): {
    samples: number
    observedProcesses: number
    sampledPeakAggregateRssBytes: number
    sampledPeakAggregateThreads: number
    sampledPeakAggregateProcesses: number
    observedOwnCpuMs: number
    observedIoBytes: Record<string, number> | null
    observedIoThreads: number
    processesWithoutIo: number
    ioThreadReadFailures: number
    samplerWallMs: number
    maxSamplerWallMs: number
    maxSampleGapMs: number
    contextSeries: { atMs: number; rssBytes: number; threads: number; processes: number }[]
    contextSeriesOmitted: number
  }
}
export function measureCommand(
  command: string,
  args: string[],
  output: string,
  intervalMs?: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
