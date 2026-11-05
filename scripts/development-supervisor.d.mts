import type { ChildProcess } from 'node:child_process'
export function processExists(pid: number): Promise<boolean>
export function createDevelopmentSupervisor(options?: {
  log?: (message: string) => void
}): Promise<{
  env: { IRODORI_DEV_SUPERVISOR_PORT: string; IRODORI_DEV_SUPERVISOR_TOKEN: string }
  done: Promise<number>
  attach(child: ChildProcess): void
  requestStop(): void
}>
