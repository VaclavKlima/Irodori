import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { CameraError } from './model.ts'

export interface NativeCamera {
  connection: string
  model: string
  serial: string
  vendor: number
  product: number
  location: number
}
export interface PtpTransport {
  list(): Promise<NativeCamera[]>
  open(camera: string): Promise<void>
  close(camera: string): Promise<void>
  command(
    camera: string,
    code: number,
    parameters?: number[],
    data?: Buffer,
    file?: string,
  ): Promise<Buffer>
  shutdown(): Promise<void>
}
export class ImageCaptureTransport implements PtpTransport {
  private child?: ChildProcessWithoutNullStreams
  private pending = new Map<
    string,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private removed = new Set<string>()
  private connections = new Set<string>()
  private args: string[]
  executable: string
  constructor(executable: string, args: string[] = []) {
    this.executable = executable
    this.args = args
  }
  private start() {
    if (this.child) return
    const child = (this.child = spawn(this.executable, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    }))
    child.stderr.resume()
    let buffered = 0
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.length
      if (buffered > 4 * 1024 * 1024) child.kill()
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      buffered = 0
      try {
        const message = JSON.parse(line)
        if (message.event === 'disconnected') {
          this.removed.add(message.camera)
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error)
          pending.reject(
            new CameraError(
              /disconnect/i.test(message.error) ? 'disconnected' : 'backend-error',
              message.error,
            ),
          )
        else pending.resolve(message.result)
      } catch {
        child.kill()
      }
    })
    const fail = () => {
      if (this.child !== child) return
      for (const connection of this.connections) this.removed.add(connection)
      this.connections.clear()
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(
          new CameraError(
            'native-transport-ended',
            'ImageCaptureCore helper ended. Run npm run camera:setup if missing. Reopen the session.',
            true,
          ),
        )
      }
      this.pending.clear()
      this.child = undefined
    }
    child.on('error', fail)
    child.on('exit', fail)
  }
  private async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (typeof args.camera === 'string' && this.removed.has(args.camera))
      throw new CameraError('disconnected', 'Camera disconnected. Discover and open a new session.')
    this.start()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(
            new CameraError(
              'timeout',
              'PTP request timed out. Its outcome is uncertain; do not repeat the shutter release.',
              true,
            ),
          )
          // Never send more requests through a helper with an unresolved PTP transaction.
          this.child?.kill('SIGTERM')
        },
        op === 'ptp' ? 65_000 : 15_000,
      )
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }
  async list(): Promise<NativeCamera[]> {
    return (await this.call('list')) as NativeCamera[]
  }
  async open(camera: string) {
    await this.call('open', { camera })
    this.connections.add(camera)
  }
  async close(camera: string) {
    await this.call('close', { camera })
    this.connections.delete(camera)
  }
  async command(
    camera: string,
    code: number,
    parameters: number[] = [],
    data?: Buffer,
    file?: string,
  ) {
    const result = (await this.call('ptp', {
      camera,
      code,
      parameters,
      data: data?.toString('base64'),
      file,
    })) as { data?: string; response: string; bytes?: number }
    const response = Buffer.from(result.response, 'base64')
    if (response.length < 12 || response.readUInt16LE(6) !== 0x2001)
      throw new CameraError(
        'ptp-rejected',
        `Camera rejected PTP command ${code.toString(16)}: ${response.toString('hex')}`,
      )
    return Buffer.from(result.data ?? '', 'base64')
  }
  async shutdown() {
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
  }
}
