import type { Page } from '@playwright/test'
import type { HdrRecoverySnapshot } from '../src/renderer/src/preview/hdr-recovery'

/** Observe the actual normal blit and its production recovery map without submitting work. */
export async function observeAdjustmentHalfReadback(page: Page) {
  return page.evaluateHandle(() => {
    const original = {
      current: GPUCanvasContext.prototype.getCurrentTexture,
      view: GPUTexture.prototype.createView,
      group: GPUDevice.prototype.createBindGroup,
      pass: GPUCommandEncoder.prototype.beginRenderPass,
      bind: GPURenderPassEncoder.prototype.setBindGroup,
      draw: GPURenderPassEncoder.prototype.draw,
      copy: GPUCommandEncoder.prototype.copyTextureToBuffer,
      finish: GPUCommandEncoder.prototype.finish,
      submit: GPUQueue.prototype.submit,
      fence: GPUQueue.prototype.onSubmittedWorkDone,
      range: GPUBuffer.prototype.getMappedRange,
    }
    type Blit = {
      canvas: HTMLCanvasElement
      context: GPUCanvasContext
      device: GPUDevice
      colorSpace: PredefinedColorSpace
      source: GPUTexture
      sourceIdentity: string
      presentationBefore: number
      draws: number
    }
    type Copy = Blit & {
      width: number
      height: number
      rowBytes: number
      serial?: number
      epoch?: number
      submitted: boolean
      fenceLinked: boolean
      fenced: boolean
      pixels?: ArrayLike<number>
    }
    const views = new WeakMap<GPUTextureView, GPUTexture>(),
      groups = new WeakMap<GPUBindGroup, GPUTexture>(),
      canvases = new WeakMap<GPUTexture, GPUCanvasContext>(),
      passes = new WeakMap<
        GPURenderPassEncoder,
        { encoder: GPUCommandEncoder; context: GPUCanvasContext; source?: GPUTexture }
      >(),
      blits = new WeakMap<GPUCommandEncoder, Blit>(),
      encoders = new WeakMap<GPUCommandEncoder, Copy>(),
      commands = new WeakMap<GPUCommandBuffer, Copy>(),
      queues = new WeakMap<GPUQueue, Copy[]>(),
      copies = new WeakMap<GPUBuffer, Copy>(),
      records: Copy[] = [],
      errors: string[] = []
    let maps = 0
    const main = () => document.querySelector<HTMLCanvasElement>('[data-testid="main-preview"]'),
      note = (error: unknown) => {
        if (errors.length < 16) errors.push(String(error))
      }
    GPUCanvasContext.prototype.getCurrentTexture = function () {
      const texture = original.current.call(this)
      if (this.canvas === main()) canvases.set(texture, this)
      return texture
    }
    GPUTexture.prototype.createView = function (...args) {
      const view = original.view.apply(this, args)
      views.set(view, this)
      return view
    }
    GPUDevice.prototype.createBindGroup = function (descriptor) {
      const group = original.group.call(this, descriptor)
      for (const entry of descriptor.entries)
        if (entry.binding === 0) {
          const texture = views.get(entry.resource as GPUTextureView)
          if (texture) groups.set(group, texture)
        }
      return group
    }
    GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
      const pass = original.pass.call(this, descriptor)
      for (const attachment of descriptor.colorAttachments) {
        const texture = attachment ? views.get(attachment.view as GPUTextureView) : undefined,
          context = texture && canvases.get(texture)
        if (context) passes.set(pass, { encoder: this, context })
      }
      return pass
    }
    GPURenderPassEncoder.prototype.setBindGroup = function (...args: unknown[]) {
      const pass = passes.get(this)
      if (pass && args[0] === 0) pass.source = groups.get(args[1] as GPUBindGroup)
      return Reflect.apply(original.bind, this, args)
    }
    GPURenderPassEncoder.prototype.draw = function (...args) {
      const pass = passes.get(this),
        configuration = pass?.context.getConfiguration()
      if (pass?.source && configuration) {
        const existing = blits.get(pass.encoder)
        if (existing) existing.draws++
        else {
          const canvas = pass.context.canvas as HTMLCanvasElement
          if (configuration.format !== 'rgba16float' || configuration.alphaMode !== 'opaque')
            note('The observed actual output is not opaque rgba16float.')
          blits.set(pass.encoder, {
            canvas,
            context: pass.context,
            device: configuration.device,
            colorSpace: configuration.colorSpace ?? 'srgb',
            source: pass.source,
            sourceIdentity: canvas.dataset.requestedSourceIdentity ?? '',
            presentationBefore: Number(canvas.dataset.presentationSerial ?? 0),
            draws: 1,
          })
        }
      }
      return original.draw.apply(this, args)
    }
    GPUCommandEncoder.prototype.copyTextureToBuffer = function (...args) {
      original.copy.apply(this, args)
      const [source, destination, extent] = args,
        blit = blits.get(this)
      if (destination.buffer.label !== 'irodori-hdr-recovery-readback' || !blit) return
      try {
        const width = source.texture.width,
          height = source.texture.height,
          rowBytes = Math.ceil((width * 8) / 256) * 256,
          size = Array.isArray(extent)
            ? extent
            : [
                (extent as GPUExtent3DDict).width,
                (extent as GPUExtent3DDict).height ?? 1,
                (extent as GPUExtent3DDict).depthOrArrayLayers ?? 1,
              ]
        if (
          source.texture !== blit.source ||
          source.texture.format !== 'rgba16float' ||
          (source.mipLevel ?? 0) !== 0 ||
          source.origin !== undefined ||
          (destination.offset ?? 0) !== 0 ||
          destination.bytesPerRow !== rowBytes ||
          destination.rowsPerImage !== height ||
          destination.buffer.size !== rowBytes * height ||
          size[0] !== width ||
          size[1] !== height ||
          (size[2] ?? 1) !== 1 ||
          width * height * 8 > 64 * 1024 ** 2
        )
          throw new Error('The actual blit and bounded half-plane copy do not match.')
        const copy: Copy = {
          ...blit,
          width,
          height,
          rowBytes,
          submitted: false,
          fenceLinked: false,
          fenced: false,
        }
        copies.set(destination.buffer, copy)
        encoders.set(this, copy)
        records.push(copy)
        if (records.length > 8) records.shift()!.pixels = undefined
      } catch (error) {
        note(error)
      }
    }
    GPUCommandEncoder.prototype.finish = function (...args) {
      const command = original.finish.apply(this, args),
        copy = encoders.get(this)
      if (copy) commands.set(command, copy)
      return command
    }
    GPUQueue.prototype.submit = function (input) {
      const buffers = Array.from(input)
      original.submit.call(this, buffers)
      const submitted = buffers.flatMap((buffer) => {
        const copy = commands.get(buffer)
        if (!copy) return []
        copy.submitted = true
        return [copy]
      })
      if (submitted.length) queues.set(this, submitted)
    }
    GPUQueue.prototype.onSubmittedWorkDone = function () {
      const work = original.fence.call(this),
        submitted = queues.get(this)
      queues.delete(this)
      for (const copy of submitted ?? []) {
        copy.fenceLinked = true
        copy.serial = Number(copy.canvas.dataset.normalCanvasSubmittedSerial)
        copy.epoch = Number(copy.canvas.dataset.normalCanvasSubmittedEpoch)
      }
      void work
        .then(() => {
          for (const copy of submitted ?? []) copy.fenced = true
        })
        .catch(() => undefined)
      return work
    }
    GPUBuffer.prototype.getMappedRange = function (...args) {
      const range = original.range.apply(this, args),
        copy = copies.get(this)
      if (copy)
        try {
          if (
            ++maps > 512 ||
            !copy.submitted ||
            !copy.fenceLinked ||
            !copy.fenced ||
            (args[0] ?? 0) !== 0 ||
            range.byteLength !== copy.rowBytes * copy.height
          )
            throw new Error('The actual recovery map does not bind its copy and completed fence.')
          const pixels = new ArrayBuffer(copy.width * copy.height * 8)
          for (let row = 0; row < copy.height; row++)
            new Uint8Array(pixels, row * copy.width * 8, copy.width * 8).set(
              new Uint8Array(range, row * copy.rowBytes, copy.width * 8),
            )
          const Half = (
            globalThis as unknown as {
              Float16Array: new (buffer: ArrayBuffer) => ArrayLike<number>
            }
          ).Float16Array
          copy.pixels = new Half(pixels)
          let retained = pixels.byteLength
          for (const previous of [...records].reverse()) {
            if (previous === copy || !previous.pixels) continue
            retained += previous.width * previous.height * 8
            if (retained > 64 * 1024 ** 2) previous.pixels = undefined
          }
        } catch (error) {
          note(error)
        }
      return range
    }
    return {
      state: () => ({
        maps,
        errors: [...errors],
        retainedPlanes: records.filter((r) => r.pixels).length,
      }),
      readback: () => {
        const canvas = main()
        if (!canvas?.dataset.recoverySnapshot || errors.length) return null
        const snapshot = JSON.parse(canvas.dataset.recoverySnapshot) as HdrRecoverySnapshot,
          matches = records.filter(
            (copy) =>
              copy.canvas === canvas &&
              copy.serial === snapshot.serial &&
              copy.presentationBefore + 1 === snapshot.presentationSerial,
          )
        if (matches.length !== 1) return null
        const copy = matches[0],
          configuration = copy.context.getConfiguration()
        if (
          !copy.pixels ||
          !copy.submitted ||
          !copy.fenced ||
          copy.draws !== 1 ||
          !canvas.isConnected ||
          canvas.dataset.editing !== 'ready' ||
          canvas.dataset.retentionMethod !== 'raw-half-cpu' ||
          canvas.dataset.quality !== 'normal' ||
          canvas.dataset.presentedArithmeticPolicy !== 'reference' ||
          snapshot.quality !== 'normal' ||
          snapshot.arithmeticPolicy !== 'reference' ||
          snapshot.sourceIdentity !== copy.sourceIdentity ||
          snapshot.sourceIdentity !== canvas.dataset.presentedSourceIdentity ||
          String(snapshot.serial) !== canvas.dataset.completedEditSerial ||
          String(snapshot.serial) !== canvas.dataset.requestedSerial ||
          String(snapshot.presentationSerial) !== canvas.dataset.presentationSerial ||
          snapshot.epoch !== copy.epoch ||
          String(snapshot.epoch) !== canvas.dataset.presentedEpoch ||
          String(snapshot.settingsRevision) !== canvas.dataset.presentedSettingsRevision ||
          snapshot.width !== copy.width ||
          snapshot.height !== copy.height ||
          canvas.width !== copy.width ||
          canvas.height !== copy.height ||
          configuration?.device !== copy.device ||
          configuration?.colorSpace !== copy.colorSpace ||
          snapshot.target.colorSpace !== copy.colorSpace ||
          String(snapshot.target.generation) !== canvas.dataset.targetGeneration
        )
          return null
        return {
          data: copy.pixels,
          format: 'rgba16float' as const,
          width: copy.width,
          height: copy.height,
          serial: String(snapshot.presentationSerial),
          sourceIdentity: snapshot.sourceIdentity,
          snapshot,
        }
      },
    }
  })
}
