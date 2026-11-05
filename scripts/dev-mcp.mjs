import { spawn } from 'node:child_process'
import { createDevelopmentSupervisor } from './development-supervisor.mjs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

// Fail early instead of accidentally attaching the agent to a different application.
const probe = createServer()
try {
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(9222, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => probe.close(resolve))
} catch (error) {
  console.error(
    error.code === 'EADDRINUSE'
      ? 'Port 9222 is already in use. Close the existing debugging session before starting Irodori.'
      : `Cannot open the local debugging endpoint: ${error.message}`,
  )
  process.exit(1)
}

// electron-vite reads path.txt directly, bypassing Electron's first-use installer.
try {
  await import('electron')
} catch (error) {
  console.error(
    `Could not prepare the Electron runtime: ${error.message}\nRun npm run setup:electron and try again.`,
  )
  process.exit(1)
}

const cli = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url),
)
const supervisor = await createDevelopmentSupervisor()
const child = spawn(
  process.execPath,
  [cli, 'dev', '--remote-debugging-port=9222', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, ...supervisor.env },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // Own the whole Vite/Electron process group so programmatic shutdown is reliable.
    detached: process.platform !== 'win32',
  },
)
supervisor.attach(child)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => supervisor.requestStop())
process.exitCode = await supervisor.done
