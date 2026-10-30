import { expect, test } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCameraMcpServer } from '../src/main/camera-control/mcp'
import { cameraFixture, finished } from './camera-control.helpers'

async function unavailableBackend(directory: string) {
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'gphoto2'), '#!/usr/bin/env node\nprocess.exit(127)\n', { mode: 0o755 })
  return {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    IRODORI_CAMERA_BACKEND: 'gphoto2',
  }
}

test('MCP discovery, validation, exact sessions, capture, polling and cleanup use the shared service', async () => {
  const f = await cameraFixture(),
    server = createCameraMcpServer(f.service),
    client = new Client({ name: 'camera-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: `irodori_camera_${name}`, arguments: args })
  try {
    expect((await client.listTools()).tools).toHaveLength(7)
    const listed = await call('list')
    expect(listed.structuredContent).toMatchObject({
      cameras: [{ id: 'camera-1' }, { id: 'camera-2' }],
    })
    expect((await call('list', { path: '/private' })).isError).toBe(true)
    expect((await call('open_session', { cameraId: 'missing' })).isError).toBe(true)
    expect((await call('list_actions', { cameraId: 'camera-2' })).structuredContent).toMatchObject({
      actions: expect.arrayContaining([expect.objectContaining({ id: 'read-settings' })]),
    })
    const opened = (
      await call('open_session', { cameraId: 'camera-2', initialSettings: { iso: '200' } })
    ).structuredContent as Record<string, unknown>
    const accepted = (
      await call('execute_action', {
        sessionId: opened.sessionId,
        action: 'capture',
        parameters: { settings: {} },
        requestId: 'mcp-capture',
      })
    ).structuredContent as Record<string, unknown>
    await finished(f.service, accepted.operationId as string)
    expect(
      (await call('get_operation', { operationId: accepted.operationId })).structuredContent,
    ).toMatchObject({
      state: 'completed',
      steps: [{ files: [{ filename: 'DSC0001.ARW' }, { filename: 'DSC0001.JPG' }] }],
    })
    expect(
      (
        await call('execute_action', {
          sessionId: opened.sessionId,
          action: 'format-card',
          parameters: {},
          requestId: 'bad',
        })
      ).isError,
    ).toBe(true)
    expect(
      (await call('close_session', { sessionId: opened.sessionId })).structuredContent,
    ).toMatchObject({ closed: true, restoration: [{ outcome: 'restored' }] })
    expect(f.provider.captures).toEqual(['camera-2'])
  } finally {
    await client.close()
    await server.close()
    await f.cleanup()
  }
})

test('standalone stdio server initializes without Electron, library, or connected hardware', async () => {
  const client = new Client({ name: 'camera-stdio-test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/camera-mcp.mjs'],
    env: { PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport)
    const result = await client.listTools()
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'irodori_camera_list',
      'irodori_camera_list_actions',
      'irodori_camera_open_session',
      'irodori_camera_execute_action',
      'irodori_camera_get_operation',
      'irodori_camera_cancel_operation',
      'irodori_camera_close_session',
    ])
    const invalid = await client.callTool({
      name: 'irodori_camera_execute_action',
      arguments: {
        sessionId: 'x',
        action: 'capture',
        parameters: { settings: { iso: 100 } },
        requestId: 'x',
      },
    })
    expect(invalid.isError).toBe(true)
  } finally {
    await client.close()
    await transport.close()
  }
})

test('npm camera startup discovers the package from the root and a subdirectory without hardware', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'irodori-camera-backend-'))
  try {
    const env = await unavailableBackend(temporary)
    for (const cwd of ['.', 'scripts/camera']) {
      const client = new Client({ name: 'camera-npm-test', version: '1' })
      const transport = new StdioClientTransport({
        command: 'npm',
        args: ['run', '--silent', 'mcp:camera'],
        cwd: resolve(cwd),
        env,
        stderr: 'pipe',
      })
      transport.stderr?.on('data', () => {})
      try {
        await client.connect(transport)
        expect((await client.listTools()).tools).toHaveLength(7)
        const listed = await client.callTool({ name: 'irodori_camera_list', arguments: {} })
        expect(listed.isError).not.toBe(true)
        expect(listed.structuredContent).toMatchObject({
          cameras: [],
          diagnostics: [{ provider: 'gphoto2', available: false }],
        })
      } finally {
        await client.close()
        await transport.close()
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('relocated camera startup keeps artifacts in its own checkout with spaces and unrelated launch directories', async () => {
  const original = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'irodori camera registration '))
  const checkout = join(temporary, 'relocated checkout')
  try {
    const env = await unavailableBackend(temporary)
    await mkdir(join(checkout, 'scripts'), { recursive: true })
    await mkdir(join(checkout, 'nested directory'))
    await cp(join(original, 'package.json'), join(checkout, 'package.json'))
    await cp(join(original, 'scripts/camera-mcp.mjs'), join(checkout, 'scripts/camera-mcp.mjs'))
    await cp(join(original, 'scripts/camera'), join(checkout, 'scripts/camera'), {
      recursive: true,
    })
    await cp(
      join(original, 'assets/app/camera-runtime'),
      join(checkout, 'assets/app/camera-runtime'),
      { recursive: true },
    )
    await cp(join(original, 'src/main/camera-control'), join(checkout, 'src/main/camera-control'), {
      recursive: true,
    })
    await symlink(join(original, 'node_modules'), join(checkout, 'node_modules'), 'junction')
    for (const cwd of [checkout, join(checkout, 'nested directory'), temporary]) {
      const direct = cwd === temporary
      const client = new Client({ name: 'camera-relocation-test', version: '1' })
      const transport = new StdioClientTransport({
        command: direct ? process.execPath : 'npm',
        args: direct
          ? [join(checkout, 'scripts/camera-mcp.mjs')]
          : ['run', '--silent', 'mcp:camera'],
        cwd,
        env,
        stderr: 'pipe',
      })
      transport.stderr?.on('data', () => {})
      try {
        await client.connect(transport)
        expect((await client.listTools()).tools).toHaveLength(7)
        const listed = await client.callTool({ name: 'irodori_camera_list', arguments: {} })
        expect(listed.isError).not.toBe(true)
        expect(listed.structuredContent).toMatchObject({
          cameras: [],
          diagnostics: [{ provider: 'gphoto2', available: false }],
          recoveries: [],
        })
        for (const directory of ['sessions', 'operations', 'requests', 'backend-config/gphoto'])
          await access(join(checkout, 'artifacts/camera', directory))
        if (cwd !== checkout)
          await expect(access(join(cwd, 'artifacts/camera'))).rejects.toMatchObject({
            code: 'ENOENT',
          })
      } finally {
        await client.close()
        await transport.close()
      }
      await rm(join(checkout, 'artifacts'), { recursive: true, force: true })
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('missing runtimes leave initialization and all seven tools available in a relocated checkout', async () => {
  const original = fileURLToPath(new URL('../', import.meta.url))
  const checkout = await mkdtemp(join(tmpdir(), 'irodori missing camera runtime '))
  const client = new Client({ name: 'camera-missing-runtime', version: '1' })
  let transport: StdioClientTransport | undefined
  try {
    for (const path of [
      'package.json',
      'scripts/camera-mcp.mjs',
      'scripts/camera',
      'src/main/camera-control',
      'assets/app/camera-runtime',
    ])
      await cp(join(original, path), join(checkout, path), { recursive: true })
    await symlink(join(original, 'node_modules'), join(checkout, 'node_modules'), 'junction')
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(checkout, 'scripts/camera-mcp.mjs')],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    await client.connect(transport)
    expect((await client.listTools()).tools).toHaveLength(7)
    const listed = await client.callTool({ name: 'irodori_camera_list', arguments: {} })
    expect(listed.isError).not.toBe(true)
    expect(listed.structuredContent).toMatchObject({
      cameras: [],
      diagnostics: [{ available: false, message: expect.stringContaining('npm run camera:setup') }],
    })
    await expect(access(join(checkout, 'artifacts/camera/runtime'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    await client.close()
    await transport?.close()
    await rm(checkout, { recursive: true, force: true })
  }
})
