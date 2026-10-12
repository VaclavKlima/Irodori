import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  DeviceDirectoryVisibility,
  type VisibilityChildFactory,
} from '../src/main/device-directory-visibility'

const attributesWorker = String.raw`
const readline = require('node:readline')
const expectedLiteralPath = process.argv[1]
let request = 0
const entries = [
  { name: 'Camera cache', attributes: 2 },
  { name: 'hidden-photo.jpg', attributes: 2 },
  { name: 'System metadata', attributes: 6 },
  { name: 'normal-photo.jpg', attributes: 0 },
  { name: '.dot-only', attributes: 0 },
  { name: '.dot-hidden', attributes: 2 },
]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { directory } = JSON.parse(line)
  request++
  if (directory.endsWith('stall')) return
  if (directory.endsWith('error')) {
    process.stdout.write(JSON.stringify({ error: 'Permission denied' }) + '\n')
    return
  }
  if (directory.endsWith('invalid')) {
    process.stdout.write(JSON.stringify({ hidden: ['outside/path'] }) + '\n')
    return
  }
  if (directory.endsWith('overflow')) {
    process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1) + '\n')
    return
  }
  if (directory.endsWith('exit')) {
    process.stderr.write('Storage query stopped', () => process.exit(1))
    return
  }
  if (directory.includes('literal')) {
    process.stdout.write(JSON.stringify({ hidden: directory === expectedLiteralPath ? ['Exact literal match'] : [] }) + '\n')
    return
  }
  if (directory.endsWith('sequence')) {
    const number = request
    setTimeout(() => process.stdout.write(JSON.stringify({ hidden: ['request-' + number] }) + '\n'), 25)
    return
  }
  process.stdout.write(JSON.stringify({ hidden: entries.filter(entry => (entry.attributes & 2) !== 0).map(entry => entry.name) }) + '\n')
})
`

function windowsVisibility(options: { timeoutMs?: number; literalPath?: string } = {}) {
  const children: ChildProcessWithoutNullStreams[] = []
  const commands: { command: string; args: readonly string[] }[] = []
  const childFactory: VisibilityChildFactory = (command, args) => {
    commands.push({ command, args })
    const child = spawn(process.execPath, ['-e', attributesWorker, options.literalPath ?? ''], {
      stdio: 'pipe',
    })
    children.push(child)
    return child
  }
  const visibility = new DeviceDirectoryVisibility({
    platform: 'win32',
    childFactory,
    timeoutMs: options.timeoutMs,
  })
  return { visibility, children, commands }
}

const signal = () => new AbortController().signal
const exited = (child: ChildProcessWithoutNullStreams) =>
  child.exitCode !== null || child.signalCode !== null

test('non-Windows device traversal does not launch an attribute worker', async () => {
  let launched = false
  const visibility = new DeviceDirectoryVisibility({
    platform: 'linux',
    childFactory: () => {
      launched = true
      throw new Error('Unix dot filtering needs no attribute worker.')
    },
  })
  try {
    expect(await visibility.hiddenEntries('/media/card/DCIM', signal())).toEqual(new Set())
    expect(launched).toBe(false)
  } finally {
    await visibility.close()
  }
})

test('Windows Hidden attributes cover plain names independently of dot-name filtering', async () => {
  const t = windowsVisibility()
  try {
    expect(await t.visibility.hiddenEntries('E:\\DCIM', signal())).toEqual(
      new Set(['Camera cache', 'hidden-photo.jpg', 'System metadata', '.dot-hidden']),
    )
    expect(t.commands[0].command).toBe('powershell.exe')
    expect(t.commands[0].args).toContain('-NoProfile')
    expect(t.commands[0].args.at(-1)).toContain('Get-ChildItem -Force -LiteralPath')
    expect(t.commands[0].args.at(-1)).toContain('[System.IO.FileAttributes]::Hidden')
  } finally {
    await t.visibility.close()
  }
  expect(t.children.every(exited)).toBe(true)
})

test('unusual device directory names travel as literal UTF-8 JSON data', async () => {
  const literalPath = "E:\\literal [summer] $(`value`) 'quoted' 📷"
  const t = windowsVisibility({ literalPath })
  try {
    expect(await t.visibility.hiddenEntries(literalPath, signal())).toEqual(
      new Set(['Exact literal match']),
    )
    expect(t.commands[0].args.join(' ')).not.toContain(literalPath)
    await expect(t.visibility.hiddenEntries('relative\\directory', signal())).rejects.toThrow(
      'Invalid device directory',
    )
    expect(t.children).toHaveLength(1)
  } finally {
    await t.visibility.close()
  }
})

test('concurrent directory requests share one warm process and are serialized', async () => {
  const t = windowsVisibility()
  try {
    const requests = Array.from({ length: 3 }, () =>
      t.visibility.hiddenEntries('E:\\sequence', signal()),
    )
    expect(await Promise.all(requests)).toEqual([
      new Set(['request-1']),
      new Set(['request-2']),
      new Set(['request-3']),
    ])
    expect(t.children).toHaveLength(1)
  } finally {
    await t.visibility.close()
  }
})

test('cancellation waits for the active worker to exit before a fresh request', async () => {
  const t = windowsVisibility()
  const controller = new AbortController()
  try {
    const held = t.visibility.hiddenEntries('E:\\stall', controller.signal)
    const rejected = expect(held).rejects.toThrow('cancelled')
    await expect.poll(() => t.children.length).toBe(1)
    const next = t.visibility.hiddenEntries('E:\\DCIM', signal())
    controller.abort()
    await rejected
    expect(exited(t.children[0])).toBe(true)
    expect(await next).toContain('Camera cache')
    expect(t.children).toHaveLength(2)
  } finally {
    await t.visibility.close()
  }
})

test('an aborted queued query leaves another directory request intact', async () => {
  const t = windowsVisibility()
  const controller = new AbortController()
  try {
    const first = t.visibility.hiddenEntries('E:\\sequence', signal())
    const cancelled = t.visibility.hiddenEntries('E:\\DCIM', controller.signal)
    const rejected = expect(cancelled).rejects.toThrow()
    const next = t.visibility.hiddenEntries('E:\\sequence', signal())
    controller.abort()
    expect(await first).toEqual(new Set(['request-1']))
    await rejected
    expect(await next).toEqual(new Set(['request-2']))
    expect(t.children).toHaveLength(1)
  } finally {
    await t.visibility.close()
  }
})

test('timeouts reclaim workers and allow subsequent directory requests', async () => {
  const t = windowsVisibility({ timeoutMs: 250 })
  try {
    await expect(t.visibility.hiddenEntries('E:\\stall', signal())).rejects.toThrow('timed out')
    expect(exited(t.children[0])).toBe(true)
    expect(await t.visibility.hiddenEntries('E:\\DCIM', signal())).toContain('Camera cache')
    expect(t.children).toHaveLength(2)
  } finally {
    await t.visibility.close()
  }
})

test('directory errors, invalid responses, excessive output and early exits await cleanup', async () => {
  const t = windowsVisibility()
  try {
    for (const [directory, message] of [
      ['error', 'Permission denied'],
      ['invalid', 'invalid data'],
      ['overflow', 'too much data'],
      ['exit', 'Storage query stopped'],
    ]) {
      await expect(t.visibility.hiddenEntries(`E:\\${directory}`, signal())).rejects.toThrow(
        message,
      )
      expect(exited(t.children.at(-1)!)).toBe(true)
    }
    expect(await t.visibility.hiddenEntries('E:\\DCIM', signal())).toContain('Camera cache')
    expect(t.children).toHaveLength(5)
  } finally {
    await t.visibility.close()
  }
})

test('closing cancels active work, rejects queued work and fully exits the process', async () => {
  const t = windowsVisibility()
  const held = t.visibility.hiddenEntries('E:\\stall', signal())
  const heldRejected = expect(held).rejects.toThrow('closed')
  const queued = t.visibility.hiddenEntries('E:\\DCIM', signal())
  const queuedRejected = expect(queued).rejects.toThrow('closed')
  await expect.poll(() => t.children.length).toBe(1)
  await t.visibility.close()
  await Promise.all([heldRejected, queuedRejected])
  expect(t.children).toHaveLength(1)
  expect(exited(t.children[0])).toBe(true)
  await expect(t.visibility.hiddenEntries('E:\\DCIM', signal())).rejects.toThrow('closed')
  await t.visibility.close()
})
