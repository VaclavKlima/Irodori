import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { nativeEncoderPath } from './src/main/export/encoder'
import { nativeCpuExecutable } from './src/main/native-cpu-executable'
import { prepareNativeRawExecutable } from './src/main/native-raw-executable'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('base64') : undefined

  return {
    main: {
      plugins: [
        {
          name: 'luma-opencv-runtime',
          async closeBundle() {
            if (process.platform === 'linux' && process.arch === 'x64') {
              const encoder = await nativeEncoderPath(resolve('vendor/ultrahdr'))
              if (!encoder)
                throw new Error(
                  'The Linux native HDR codec is missing. Supply the pinned source archives and run npm run build:export-native before building Luma.',
                )
              try {
                await nativeCpuExecutable(resolve('vendor'))
              } catch (cause) {
                throw new Error(
                  'The Linux native CPU renderer is missing or invalid. Run npm run build:cpu-native before building Luma.',
                  { cause },
                )
              }
              await cp(
                'vendor/native-cpu-render/linux-x64',
                'out/main/native-cpu-render/linux-x64',
                {
                  recursive: true,
                },
              )
              const raw = await prepareNativeRawExecutable(resolve('vendor'))
              if (raw.status !== 'ready')
                throw new Error(
                  'The Linux native RAW decoder is missing or invalid. Run npm run build:raw-native before building Luma.',
                )
              await cp('vendor/native-raw/linux-x64', 'out/main/native-raw/linux-x64', {
                recursive: true,
              })
            }
            await mkdir('out/main/opencv', { recursive: true })
            await cp('vendor/opencv', 'out/main/opencv', { recursive: true })
            await cp('vendor/ultrahdr', 'out/main/ultrahdr', { recursive: true })
            await cp('vendor/merge-kernels', 'out/main/merge-kernels', { recursive: true })
          },
        },
      ],
      build: {
        rollupOptions: {
          external: ['webgpu'],
          input: {
            index: 'src/main/index.ts',
            'preview-worker': 'src/main/preview-worker.ts',
            'catalog-worker': 'src/main/catalog-worker.ts',
            'export-worker': 'src/main/export/worker.ts',
            'merge-worker': 'src/main/merge/worker.ts',
            'alignment-worker': 'src/main/merge/alignment-worker.ts',
            'hdr-diagnostic': 'src/main/hdr-diagnostic.ts',
          },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: {
            index: 'src/preload/index.ts',
            'hdr-diagnostic': 'src/preload/hdr-diagnostic.ts',
          },
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      build: {
        rollupOptions: {
          input: {
            index: 'src/renderer/index.html',
            'hdr-diagnostic': 'src/renderer/hdr-diagnostic.html',
          },
        },
      },
      html: { cspNonce: nonce },
      plugins: [
        react(),
        {
          name: 'luma-development-csp',
          apply: 'serve',
          transformIndexHtml: {
            order: 'pre',
            handler: (html) =>
              html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
          },
        },
      ],
      server: {
        host: '127.0.0.1',
        port: Number(process.env.LUMA_DEV_PORT ?? 5173),
        strictPort: false,
      },
    },
  }
})
