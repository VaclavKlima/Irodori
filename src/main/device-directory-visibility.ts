import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { win32 } from 'node:path'

export type VisibilityChildFactory = (
  command: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams

interface VisibilityOptions {
  platform?: NodeJS.Platform
  childFactory?: VisibilityChildFactory
  timeoutMs?: number
}

interface VisibilityWorker {
  child: ChildProcessWithoutNullStreams
  exited: Promise<void>
  buffer: string
  stderr: string
  failure?: Error
  dead: boolean
  stopping?: Promise<void>
  pending?: { respond: (line: string) => void; fail: (error: Error) => void }
}

// Directory names are JSON data on stdin. They are never included in PowerShell code.
const visibilityScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    $hidden = @(Get-ChildItem -Force -LiteralPath ([string]$request.directory) -ErrorAction Stop | Where-Object {
      ($_.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0
    } | ForEach-Object { $_.Name })
    $response = @{ hidden = $hidden }
  } catch {
    $response = @{ error = $_.Exception.Message }
  }
  [Console]::WriteLine(($response | ConvertTo-Json -Depth 3 -Compress))
}
`

/** Supplements dot-name filtering with Windows filesystem Hidden attributes. */
export class DeviceDirectoryVisibility {
  private readonly platform: NodeJS.Platform
  private readonly childFactory: VisibilityChildFactory
  private readonly timeoutMs: number
  private worker?: VisibilityWorker
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>

  constructor(options: VisibilityOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.childFactory =
      options.childFactory ??
      ((command, args) => spawn(command, args, { stdio: 'pipe', windowsHide: true }))
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  hiddenEntries(directory: string, signal: AbortSignal): Promise<Set<string>> {
    const result = this.tail.then(async () => {
      signal.throwIfAborted()
      if (this.closed) throw new Error('Device directory visibility is closed.')
      if (this.platform !== 'win32') return new Set<string>()
      if (!win32.isAbsolute(directory) || directory.length > 32_768)
        throw new Error('Invalid device directory.')
      return this.query(directory, signal)
    })
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private launch(): VisibilityWorker {
    const child = this.childFactory('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      visibilityScript,
    ])
    let finished!: () => void
    const worker: VisibilityWorker = {
      child,
      exited: new Promise<void>((resolve) => (finished = resolve)),
      buffer: '',
      stderr: '',
      dead: false,
    }
    const fail = (error: Error) => {
      worker.failure = error
      worker.pending?.fail(error)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      worker.buffer += chunk
      if (worker.buffer.length > 2 * 1024 * 1024) {
        fail(new Error('Device directory listing returned too much data.'))
        child.kill('SIGKILL')
        return
      }
      let newline: number
      while ((newline = worker.buffer.indexOf('\n')) >= 0) {
        const line = worker.buffer.slice(0, newline).replace(/\r$/, '')
        worker.buffer = worker.buffer.slice(newline + 1)
        if (!worker.pending) {
          fail(new Error('Device directory listing returned an unexpected response.'))
          child.kill('SIGKILL')
          return
        }
        worker.pending.respond(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      worker.stderr = (worker.stderr + chunk).slice(-2_000)
    })
    child.stdin.on('error', fail)
    child.on('error', fail)
    child.once('close', () => {
      worker.dead = true
      if (this.worker === worker) this.worker = undefined
      fail(new Error(worker.stderr.trim() || 'Device directory listing stopped. Try again.'))
      finished()
    })
    this.worker = worker
    return worker
  }

  private async query(directory: string, signal: AbortSignal): Promise<Set<string>> {
    if (this.worker?.failure) await this.stop(this.worker)
    signal.throwIfAborted()
    if (this.closed) throw new Error('Device directory visibility is closed.')
    const worker = this.worker ?? this.launch()
    try {
      return await new Promise<Set<string>>((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', aborted)
          worker.pending = undefined
        }
        const fail = (error: Error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        const respond = (line: string) => {
          try {
            const value: unknown = JSON.parse(line.replace(/^\uFEFF/, ''))
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Device directory listing returned invalid data.')
            const response = value as { hidden?: unknown; error?: unknown }
            if (typeof response.error === 'string') throw new Error(response.error)
            if (
              !Array.isArray(response.hidden) ||
              response.hidden.some(
                (name) => typeof name !== 'string' || !name || /[\\/]/.test(name),
              )
            )
              throw new Error('Device directory listing returned invalid data.')
            if (settled) return
            settled = true
            cleanup()
            resolve(new Set(response.hidden as string[]))
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        }
        const aborted = () => fail(new Error('Device directory listing cancelled.'))
        const timer = setTimeout(
          () => fail(new Error('Device directory listing timed out. Try again.')),
          this.timeoutMs,
        )
        worker.pending = { respond, fail }
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) {
          aborted()
          return
        }
        worker.child.stdin.write(`${JSON.stringify({ directory })}\n`, 'utf8', (error) => {
          if (error) fail(error)
        })
      })
    } catch (error) {
      await this.stop(worker)
      throw error
    }
  }

  private stop(worker: VisibilityWorker): Promise<void> {
    if (worker.stopping) return worker.stopping
    if (this.worker === worker) this.worker = undefined
    worker.stopping = (async () => {
      if (!worker.dead) worker.child.kill('SIGKILL')
      await worker.exited
    })()
    return worker.stopping
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const worker = this.worker
    worker?.pending?.fail(new Error('Device directory visibility is closed.'))
    this.closing = (async () => {
      if (worker) await this.stop(worker)
      await this.tail
    })()
    return this.closing
  }
}
