import { expect, test } from '@playwright/test'
import { ImageResourceOwners } from '../src/renderer/src/preview/image-resource-owners'
import {
  queryImageResources,
  type ImageResourceQueryTransport,
} from '../src/main/image-resource-query'
import type { ManagedImageBytes } from '../src/shared/resource-policy'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function transport() {
  let listener: Parameters<ImageResourceQueryTransport['subscribe']>[0] | undefined,
    token = '',
    detached = 0
  const channel: ImageResourceQueryTransport = {
    send(value) {
      token = value
    },
    subscribe(value) {
      listener = value
      return () => {
        listener = undefined
        detached++
      }
    },
  }
  return {
    channel,
    get token() {
      return token
    },
    get detached() {
      return detached
    },
    reply(value: unknown, returned = token, error?: string) {
      listener?.(returned, value, error)
    },
  }
}

test('resource owners retain detached work until its drain and return immutable live snapshots', async () => {
  const owners = new ImageResourceOwners(),
    drain = gate()
  let first: ManagedImageBytes = { ramBytes: 300, vramBytes: 700 },
    second = { ramBytes: 50, vramBytes: 80 }
  const active = owners.register(() => first),
    other = owners.register(() => second)
  const initial = owners.snapshot()
  expect(initial).toEqual({ ramBytes: 350, vramBytes: 780 })
  expect(Object.isFrozen(initial)).toBe(true)
  active.retire(drain.promise)
  first = { ramBytes: 0, vramBytes: 0 }
  second = { ramBytes: 70, vramBytes: 90 }
  expect(owners.snapshot()).toEqual({ ramBytes: 370, vramBytes: 790 })
  expect(initial).toEqual({ ramBytes: 350, vramBytes: 780 })
  active.retire(Promise.resolve())
  await Promise.resolve()
  expect(owners.snapshot()).toEqual({ ramBytes: 370, vramBytes: 790 })
  drain.resolve()
  await drain.promise
  expect(owners.snapshot()).toEqual(second)
  other.release()
  other.release()
  expect(owners.snapshot()).toEqual({ ramBytes: 0, vramBytes: 0 })
})

test('malformed and overflowing image ownership never turns into zero available reservations', () => {
  const owners = new ImageResourceOwners()
  const bad = owners.register(() => ({ ramBytes: NaN, vramBytes: 0 }))
  expect(() => owners.snapshot()).toThrow('Invalid managed image reservation')
  bad.release()
  owners.register(() => ({ ramBytes: Number.MAX_SAFE_INTEGER, vramBytes: 0 }))
  const next = owners.register(() => ({ ramBytes: 1, vramBytes: 0 }))
  expect(() => owners.snapshot()).toThrow('Invalid managed image reservation')
  next.release()
  expect(owners.snapshot().ramBytes).toBe(Number.MAX_SAFE_INTEGER)
})

test('image queries isolate nonces, validate specific byte counts and detach after immutable replies', async () => {
  const wire = transport(),
    pending = queryImageResources(wire.channel, new AbortController().signal)
  let completed = false
  void pending.then(() => {
    completed = true
  })
  wire.reply({ ramBytes: 1, vramBytes: 1 }, 'another-request')
  await Promise.resolve()
  expect(completed).toBe(false)
  const bytes = { ramBytes: 12345, vramBytes: 67890 }
  wire.reply(bytes)
  const result = await pending
  bytes.ramBytes = 0
  expect(result).toEqual({ ramBytes: 12345, vramBytes: 67890 })
  expect(Object.isFrozen(result)).toBe(true)
  expect(wire.detached).toBe(1)
})

test('cancelled, timed-out and malformed resource replies fail without empty ownership or leaked listeners', async () => {
  for (const value of [
    undefined,
    { ramBytes: -1, vramBytes: 0 },
    { ramBytes: 0, vramBytes: 0, path: '/unaccepted' },
  ]) {
    const wire = transport(),
      pending = queryImageResources(wire.channel, new AbortController().signal)
    wire.reply(value)
    await expect(pending).rejects.toThrow('Invalid managed image reservation')
    expect(wire.detached).toBe(1)
  }
  const cancelled = transport(),
    abort = new AbortController(),
    pending = queryImageResources(cancelled.channel, abort.signal)
  abort.abort(new Error('Resource owner cancelled.'))
  await expect(pending).rejects.toThrow('Resource owner cancelled')
  expect(cancelled.detached).toBe(1)
  const timeout = transport()
  await expect(
    queryImageResources(timeout.channel, new AbortController().signal, 5),
  ).rejects.toThrow('resource inventory is unavailable')
  expect(timeout.detached).toBe(1)
  const failed = transport(),
    failure = queryImageResources(failed.channel, new AbortController().signal)
  failed.reply(undefined, failed.token, 'Renderer inventory failed.')
  await expect(failure).rejects.toThrow('Renderer inventory failed')
  expect(failed.detached).toBe(1)
})
