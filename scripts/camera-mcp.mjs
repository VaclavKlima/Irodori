import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CameraService } from '../src/main/camera-control/service.ts'
import { CameraStore } from '../src/main/camera-control/store.ts'
import { GphotoProvider } from '../src/main/camera-control/gphoto.ts'
import { ImageCaptureTransport } from '../src/main/camera-control/image-capture.ts'
import { SonyImageCaptureProvider } from '../src/main/camera-control/sony.ts'
import { createCameraMcpServer } from '../src/main/camera-control/mcp.ts'

const root = fileURLToPath(new URL('../artifacts/camera/', import.meta.url))
const provider =
  process.platform === 'darwin' && process.env.IRODORI_CAMERA_BACKEND !== 'gphoto2'
    ? new SonyImageCaptureProvider(new ImageCaptureTransport(resolve(root, 'bin/image-capture')))
    : new GphotoProvider(root)
const service = new CameraService([provider], new CameraStore(root))
const server = createCameraMcpServer(service)
let closing
async function close() {
  closing ??= (async () => {
    await service.shutdown()
    await server.close()
  })()
  try {
    await closing
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
process.once('SIGINT', () => void close())
process.once('SIGTERM', () => void close())
const transport = new StdioServerTransport()
await server.connect(transport)
const onClose = transport.onclose
transport.onclose = () => {
  onClose?.()
  void close()
}
process.stdin.once('end', () => void close())
