import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import { cp, mkdir } from 'node:fs/promises'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('base64') : undefined

  return {
    main: {
      plugins: [
        {
          name: 'luma-opencv-runtime',
          async closeBundle() {
            await mkdir('out/main/opencv', { recursive: true })
            await cp('vendor/opencv', 'out/main/opencv', { recursive: true })
            await cp('vendor/ultrahdr', 'out/main/ultrahdr', { recursive: true })
          },
        },
      ],
      build: {
        rollupOptions: {
          external: ['webgpu'],
          input: {
            index: 'src/main/index.ts',
            'preview-worker': 'src/main/preview-worker.ts',
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
