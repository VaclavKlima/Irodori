import { spawn, spawnSync } from 'node:child_process'
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
const child = spawn(
  process.execPath,
  [cli, 'dev', '--remote-debugging-port=9222', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    // Own the whole Vite/Electron process group so programmatic shutdown is reliable.
    detached: process.platform !== 'win32',
  },
)
let stopping = false

function stopTree(signal = 'SIGTERM') {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH')
      console.error('Could not stop the Irodori process group:', error.message)
  }
}

child.on('error', (error) => {
  console.error('Could not start the Irodori development session:', error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  stopTree()
  process.exitCode = stopping ? 0 : (code ?? 1)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    stopTree(signal)
  })
}
process.on('exit', () => stopTree())
