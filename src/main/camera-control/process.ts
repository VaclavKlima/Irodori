import { spawn } from 'node:child_process'
import { CameraError } from './model.ts'

export interface ProcessRequest {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeout?: number
  limit?: number
  signal?: AbortSignal
}
export type ProcessRunner = (request: ProcessRequest) => Promise<{ stdout: string; stderr: string }>
export const runProcess: ProcessRunner = async (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = '',
      failure: CameraError | undefined
    const stop = (error: CameraError) => {
      failure ??= error
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(
      () =>
        stop(
          new CameraError(
            'timeout',
            'Camera command timed out; do not repeat an uncertain shutter release.',
            true,
          ),
        ),
      request.timeout ?? 20_000,
    )
    const aborted = () => stop(new CameraError('cancelled', 'Camera command cancelled.', true))
    request.signal?.addEventListener('abort', aborted, { once: true })
    if (request.signal?.aborted) aborted()
    const chunk = (name: 'stdout' | 'stderr', data: Buffer) => {
      if (stdout.length + stderr.length + data.length > (request.limit ?? 2 * 1024 * 1024)) {
        stop(
          new CameraError(
            'output-limit',
            'Camera command exceeded its bounded output limit.',
            true,
          ),
        )
        return
      }
      if (name === 'stdout') stdout += data.toString()
      else stderr += data.toString()
    }
    child.stdout.on('data', (data) => chunk('stdout', data))
    child.stderr.on('data', (data) => chunk('stderr', data))
    child.on('error', (error) => {
      failure = new CameraError(
        'missing-backend',
        `Cannot start camera backend: ${error.message}. Install gphoto2 on the host.`,
      )
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', aborted)
      // Some gphoto2 multi-command failures still exit zero.
      if (failure) reject(failure)
      else if (code !== 0 || /\*\*\* Error/.test(stderr + stdout)) {
        const detail = (stderr || stdout).slice(0, 3000)
        const errorCode = /claim|busy|locked/i.test(detail)
          ? 'camera-busy'
          : /access|permission/i.test(detail)
            ? 'usb-access'
            : /disconnected|No camera|not found|I\/O/i.test(detail)
              ? 'disconnected'
              : 'backend-error'
        reject(
          new CameraError(
            errorCode,
            `${detail}\nClose camera applications; on macOS use the ImageCaptureCore provider. On Linux check host USB/udev access.`,
          ),
        )
      } else resolve({ stdout, stderr })
    })
  })
