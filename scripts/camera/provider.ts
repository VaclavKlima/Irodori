import { join } from 'node:path'
import { CameraError, type CameraProvider } from '../../src/main/camera-control/model.ts'
import { GphotoProvider } from '../../src/main/camera-control/gphoto.ts'
import { ImageCaptureTransport } from '../../src/main/camera-control/image-capture.ts'
import { SonyImageCaptureProvider } from '../../src/main/camera-control/sony.ts'
import { checkoutRoot, resolveRuntime } from './runtime.ts'

export async function createCameraProvider(root = checkoutRoot): Promise<CameraProvider> {
  const cameraRoot = join(root, 'artifacts/camera')
  // Explicit diagnostic escape hatch; never used by the normal Linux runtime.
  if (process.platform === 'darwin' && process.env.IRODORI_CAMERA_BACKEND === 'gphoto2')
    return new GphotoProvider(cameraRoot)
  try {
    const runtime = await resolveRuntime(root)
    return process.platform === 'darwin'
      ? new SonyImageCaptureProvider(new ImageCaptureTransport(runtime.executable))
      : new GphotoProvider(cameraRoot, undefined, runtime.executable, undefined, runtime.env)
  } catch (error) {
    const id = process.platform === 'darwin' ? 'image-capture-sony' : 'gphoto2'
    const message = `Camera runtime unavailable: ${error}. Run npm run camera:setup in this checkout. See docs/camera-control.md for supported platforms and USB access.`
    const unavailable = async (): Promise<never> => {
      throw new CameraError('missing-backend', message)
    }
    return {
      id,
      discover: async () => ({
        cameras: [],
        diagnostics: [{ provider: id, available: false, message }],
      }),
      open: unavailable,
      inspect: unavailable,
      write: unavailable,
      capture: unavailable,
      close: async () => {},
      shutdown: async () => {},
    }
  }
}
