import type { Page } from '@playwright/test'

/** Hold a genuinely completed normal offscreen fence without changing any canvas work. */
export async function holdNormalOffscreenFence(page: Page) {
  return page.evaluateHandle(() => {
    const original = {
      current: GPUCanvasContext.prototype.getCurrentTexture,
      view: GPUTexture.prototype.createView,
      pass: GPUCommandEncoder.prototype.beginRenderPass,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
    }
    const canvasTextures = new WeakSet<GPUTexture>(),
      views = new WeakMap<GPUTextureView, GPUTexture>(),
      encoders = new WeakSet<GPUCommandEncoder>(),
      commands = new WeakSet<GPUCommandBuffer>(),
      queues = new WeakSet<GPUQueue>(),
      pending = new Set<Promise<void>>()
    let armed = true,
      held = false,
      delivered = false,
      actualCompleted = false,
      offscreenSubmissions = 0,
      releaseHeld: (() => void) | undefined
    let sourceIdentity: string | undefined, serial: number | undefined
    const release = () => {
      const resolve = releaseHeld
      releaseHeld = undefined
      resolve?.()
    }
    const current: typeof original.current = function (this: GPUCanvasContext) {
      const texture = original.current.call(this)
      canvasTextures.add(texture)
      return texture
    }
    const view: typeof original.view = function (this: GPUTexture, ...args) {
      const result = original.view.apply(this, args)
      views.set(result, this)
      return result
    }
    const pass: typeof original.pass = function (this: GPUCommandEncoder, descriptor) {
      const result = original.pass.call(this, descriptor)
      for (const attachment of Array.from(descriptor.colorAttachments)) {
        const texture = attachment ? views.get(attachment.view as GPUTextureView) : undefined
        if (
          texture &&
          !canvasTextures.has(texture) &&
          texture.format === 'rgba16float' &&
          !!(texture.usage & GPUTextureUsage.COPY_SRC)
        )
          encoders.add(this)
      }
      return result
    }
    const finish: typeof original.finish = function (this: GPUCommandEncoder, ...args) {
      const command = original.finish.apply(this, args)
      if (encoders.has(this)) commands.add(command)
      return command
    }
    const submit: typeof original.submit = function (this: GPUQueue, commandsToSubmit) {
      const values = Array.from(commandsToSubmit)
      original.submit.call(this, values)
      if (values.some((command) => commands.has(command))) {
        offscreenSubmissions++
        queues.add(this)
      }
    }
    const fence: typeof original.fence = function (this: GPUQueue) {
      const actual = original.fence.call(this)
      if (!armed || !queues.has(this)) return actual
      armed = false
      const work = actual.then(async () => {
        actualCompleted = true
        held = true
        const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]')!
        sourceIdentity = canvas.dataset.requestedSourceIdentity
        serial = Number(canvas.dataset.requestedSerial)
        await new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
        held = false
        delivered = true
        return undefined
      })
      pending.add(work)
      void work.finally(() => pending.delete(work)).catch(() => undefined)
      return work
    }
    GPUCanvasContext.prototype.getCurrentTexture = current
    GPUTexture.prototype.createView = view
    GPUCommandEncoder.prototype.beginRenderPass = pass
    GPUCommandEncoder.prototype.finish = finish
    GPUQueue.prototype.submit = submit
    GPUQueue.prototype.onSubmittedWorkDone = fence
    const state = () => ({
      held,
      delivered,
      actualCompleted,
      offscreenSubmissions,
      sourceIdentity,
      serial,
    })
    return {
      state,
      release,
      close: async () => {
        armed = false
        release()
        try {
          await Promise.allSettled([...pending])
        } finally {
          GPUCanvasContext.prototype.getCurrentTexture = original.current
          GPUTexture.prototype.createView = original.view
          GPUCommandEncoder.prototype.beginRenderPass = original.pass
          GPUCommandEncoder.prototype.finish = original.finish
          GPUQueue.prototype.submit = original.submit
          GPUQueue.prototype.onSubmittedWorkDone = original.fence
        }
        return state()
      },
    }
  })
}
