import { maskBaseAtlasPlan } from '../../../shared/masks-gpu'

type Plan = ReturnType<typeof maskBaseAtlasPlan>

/** Browser PNG decoding owns pixel conversion; application JavaScript only orchestrates. */
async function bitmap(base: Plan['bases'][number]): Promise<ImageBitmap> {
  const image = new Image()
  image.src = `data:image/png;base64,${base.pngBase64}`
  await image.decode()
  const result = await createImageBitmap(image, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  if (result.width !== base.width || result.height !== base.height) {
    result.close()
    throw new Error('Decoded generated mask dimensions changed.')
  }
  return result
}

export class WebGlMaskBaseAtlas {
  texture?: WebGLTexture
  bytes = 0
  private key: string | undefined
  private pending: string | undefined
  private generation = 0
  private failure?: { key: string; error: Error }
  private disposed = false
  private work?: Promise<void>
  whenDisposed: Promise<void> = Promise.resolve()
  constructor(private readonly gl: WebGL2RenderingContext) {}

  ready(plan: Plan, completed: () => void, failed: (reason: string) => void): boolean {
    if (this.disposed) return false
    if (this.failure?.key === plan.key) throw this.failure.error
    if (this.key === plan.key) return true
    if (
      plan.width > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) ||
      plan.height > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) ||
      plan.layers > this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS)
    )
      throw new Error('Generated masks exceed this GPU texture size or layer limit.')
    if (!plan.bases.length && !this.texture && !this.pending) {
      this.generation++
      this.replace(this.allocate(plan), plan)
      return true
    }
    if (this.pending !== plan.key) {
      const generation = ++this.generation
      this.pending = plan.key
      this.bytes = Math.max(this.bytes, plan.bytes)
      const previous = this.work
      const work = (async () => {
        let texture: WebGLTexture | undefined
        try {
          await previous
          if (this.texture) await this.drain()
          if (this.disposed || generation !== this.generation) return
          if (this.texture) this.gl.deleteTexture(this.texture)
          this.texture = undefined
          texture = this.allocate(plan)
          for (let layer = 0; layer < plan.bases.length; layer++) {
            const decoded = await bitmap(plan.bases[layer])
            try {
              if (this.disposed || generation !== this.generation) return
              await this.uploadLayer(plan, texture, decoded, layer, generation)
            } finally {
              decoded.close()
            }
          }
          if (this.disposed || generation !== this.generation) return
          this.replace(texture, plan)
          texture = undefined
          completed()
        } catch (error) {
          if (!this.disposed && generation === this.generation) {
            this.failure = {
              key: plan.key,
              error: error instanceof Error ? error : new Error(String(error)),
            }
            failed(this.failure.error.message)
          }
        } finally {
          if (texture) this.gl.deleteTexture(texture)
          if (generation === this.generation) this.pending = undefined
        }
      })()
      this.work = work
      void work
    }
    return false
  }
  retry() {
    this.failure = undefined
  }
  private async uploadLayer(
    plan: Plan,
    texture: WebGLTexture,
    decoded: ImageBitmap,
    layer: number,
    generation: number,
  ) {
    const gl = this.gl,
      program = gl.createProgram(),
      upload = gl.createTexture(),
      framebuffer = gl.createFramebuffer()
    if (!program || !upload || !framebuffer)
      throw new Error('Generated mask strip allocation failed.')
    const shaders: WebGLShader[] = []
    try {
      for (const [kind, code] of [
        [
          gl.VERTEX_SHADER,
          '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}',
        ],
        [
          gl.FRAGMENT_SHADER,
          '#version 300 es\nprecision highp float;precision highp int;uniform sampler2D source;uniform int row;out vec4 result;void main(){result=vec4(texelFetch(source,ivec2(gl_FragCoord.xy)-ivec2(0,row),0).r,0.,0.,1.);}',
        ],
      ] as const) {
        const shader = gl.createShader(kind)
        if (!shader) throw new Error('Generated mask strip shader allocation failed.')
        shaders.push(shader)
        gl.shaderSource(shader, code)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || 'Generated mask strip shader failed.')
        gl.attachShader(program, shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error('Generated mask strip program failed.')
      gl.bindTexture(gl.TEXTURE_2D, upload)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, plan.width, plan.transferRows)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      for (let row = 0; row < plan.height; row += plan.transferRows) {
        const rows = Math.min(plan.transferRows, plan.height - row),
          strip = await createImageBitmap(decoded, 0, row, plan.width, rows, {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none',
          })
        try {
          if (this.disposed || generation !== this.generation) return
          gl.activeTexture(gl.TEXTURE0)
          gl.bindTexture(gl.TEXTURE_2D, upload)
          gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, strip)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer)
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Generated mask R8 framebuffer is unavailable.')
          gl.disable(gl.BLEND)
          gl.disable(gl.SCISSOR_TEST)
          gl.viewport(0, row, plan.width, rows)
          gl.useProgram(program)
          gl.uniform1i(gl.getUniformLocation(program, 'source'), 0)
          gl.uniform1i(gl.getUniformLocation(program, 'row'), row)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          if (gl.getError() !== gl.NO_ERROR)
            throw new Error('Generated mask R8 strip upload failed.')
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          await this.drain()
        } finally {
          strip.close()
        }
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      for (const shader of shaders) gl.deleteShader(shader)
      gl.deleteProgram(program)
      gl.deleteTexture(upload)
      gl.deleteFramebuffer(framebuffer)
    }
  }
  private drain(): Promise<void> {
    const gl = this.gl
    return new Promise((resolve) => {
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (!fence || gl.isContextLost()) return resolve()
      gl.flush()
      const poll = () => {
        if (gl.isContextLost() || gl.clientWaitSync(fence, 0, 0) !== gl.TIMEOUT_EXPIRED) {
          gl.deleteSync(fence)
          resolve()
        } else setTimeout(poll, 1)
      }
      poll()
    })
  }
  private allocate(plan: Plan) {
    const gl = this.gl,
      texture = gl.createTexture()
    if (!texture) throw new Error('Generated mask GPU allocation failed.')
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, plan.width, plan.height, plan.layers)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture)
      throw new Error('Generated mask atlas allocation failed.')
    }
    return texture
  }
  private replace(texture: WebGLTexture, plan: Plan) {
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = texture
    this.key = plan.key
    this.bytes = plan.bytes
  }
  dispose() {
    this.disposed = true
    this.generation++
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = undefined
    this.bytes = 0
    this.whenDisposed = Promise.resolve(this.work).then(() => this.drain())
  }
}

export class WebGpuMaskBaseAtlas {
  texture?: GPUTexture
  bytes = 0
  private key: string | undefined
  private disposed = false
  private work: Promise<void> = Promise.resolve()
  whenDisposed: Promise<void> = Promise.resolve()
  constructor(private readonly device: GPUDevice) {}
  prepare(plan: Plan): Promise<GPUTexture> {
    const work = this.work.then(() => this.load(plan))
    this.work = work.then(
      () => {},
      () => {},
    )
    return work
  }
  private async load(plan: Plan): Promise<GPUTexture> {
    if (this.disposed) throw new Error('Generated mask GPU owner is closed.')
    if (this.key === plan.key && this.texture) return this.texture
    const device = this.device
    if (
      plan.width > device.limits.maxTextureDimension2D ||
      plan.height > device.limits.maxTextureDimension2D ||
      plan.layers > device.limits.maxTextureArrayLayers
    )
      throw new Error('Generated masks exceed this GPU texture size or layer limit.')
    await device.queue.onSubmittedWorkDone()
    if (this.disposed) throw new Error('Generated mask GPU owner is closed.')
    this.texture?.destroy()
    this.texture = undefined
    this.bytes = plan.bytes
    const texture = device.createTexture({
      size: [plan.width, plan.height, plan.layers],
      format: 'r8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const upload = device.createTexture({
        size: [plan.width, plan.transferRows],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      uniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
    try {
      const module = device.createShaderModule({
        code: '@group(0) @binding(0) var source:texture_2d<f32>;@group(0) @binding(1) var<uniform> row:vec4u;@vertex fn vertex(@builtin(vertex_index) id:u32)->@builtin(position) vec4f{let p=vec2f(f32((id<<1u)&2u),f32(id&2u));return vec4f(p*2.-1.,0.,1.);}@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) f32{return textureLoad(source,vec2i(p.xy)-vec2i(0,i32(row.x)),0).r;}',
      })
      const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r8unorm' }] },
        }),
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: upload.createView() },
            { binding: 1, resource: { buffer: uniform } },
          ],
        })
      for (let layer = 0; layer < plan.bases.length; layer++) {
        const decoded = await bitmap(plan.bases[layer])
        try {
          if (this.disposed) throw new Error('Generated mask GPU owner is closed.')
          for (let row = 0; row < plan.height; row += plan.transferRows) {
            const rows = Math.min(plan.transferRows, plan.height - row)
            device.queue.copyExternalImageToTexture(
              { source: decoded, origin: [0, row] },
              { texture: upload, premultipliedAlpha: false },
              [plan.width, rows],
            )
            device.queue.writeBuffer(uniform, 0, new Uint32Array([row, 0, 0, 0]))
            const encoder = device.createCommandEncoder(),
              pass = encoder.beginRenderPass({
                colorAttachments: [
                  {
                    view: texture.createView({
                      dimension: '2d',
                      baseArrayLayer: layer,
                      arrayLayerCount: 1,
                    }),
                    loadOp: row === 0 ? 'clear' : 'load',
                    storeOp: 'store',
                    clearValue: [0, 0, 0, 0],
                  },
                ],
              })
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, group)
            pass.setViewport(0, row, plan.width, rows, 0, 1)
            pass.draw(3)
            pass.end()
            device.queue.submit([encoder.finish()])
            await device.queue.onSubmittedWorkDone()
            if (this.disposed) throw new Error('Generated mask GPU owner is closed.')
          }
        } finally {
          decoded.close()
        }
      }
      this.texture = texture
      this.key = plan.key
      return texture
    } catch (error) {
      texture.destroy()
      throw error
    } finally {
      upload.destroy()
      uniform.destroy()
    }
  }
  dispose() {
    this.disposed = true
    this.texture?.destroy()
    this.texture = undefined
    this.bytes = 0
    this.whenDisposed = this.work.then(() =>
      this.device.queue.onSubmittedWorkDone().catch(() => {}),
    )
  }
}
