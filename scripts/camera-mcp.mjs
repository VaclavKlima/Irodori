import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'node:url'
import { CameraService } from '../src/main/camera-control/service.ts'
import { CameraStore } from '../src/main/camera-control/store.ts'
import { createCameraProvider } from './camera/provider.ts'
import { createCameraMcpServer } from '../src/main/camera-control/mcp.ts'

const root = fileURLToPath(new URL('../artifacts/camera/', import.meta.url))
const provider = await createCameraProvider()
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
