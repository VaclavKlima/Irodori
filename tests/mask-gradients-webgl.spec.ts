import { expect, test } from './electron.fixture'
import { localMasksGlsl, MASK_GPU_TEXTURE_WIDTH, packLocalMasks } from '../src/shared/masks-gpu'
import { identityMaskGeometry } from '../src/shared/mask-geometry'
import { gradientCases } from './helpers/mask-gradients'
import { referenceCoverage } from './helpers/mask-reference'

test('actual raster GLSL gradients preserve analytic coverage, aspect, rotation and ordered corrections', async ({
  irodori: { page },
}) => {
  const masks = gradientCases(),
    points = Array.from({ length: 143 }, (_, i) => ({
      x: ((i % 13) - 0.5) / 11,
      y: (Math.floor(i / 13) - 0.5) / 9,
    })),
    cases = masks.map((mask) => [
      ...packLocalMasks(
        { localMasks: [mask], maskGeometry: identityMaskGeometry(200, 100) },
        { width: 200, height: 100 },
      ),
    ]),
    results = await page.evaluate(
      ({ cases, points, shader, textureWidth }) => {
        const canvas = new OffscreenCanvas(points.length, 1),
          gl = canvas.getContext('webgl2', { antialias: false })
        if (!gl || !gl.getExtension('EXT_color_buffer_float'))
          throw new Error('Float WebGL is unavailable.')
        const program = gl.createProgram()!,
          framebuffer = gl.createFramebuffer()!,
          textures: WebGLTexture[] = [],
          shaders: WebGLShader[] = []
        try {
          for (const [kind, code] of [
            [
              gl.VERTEX_SHADER,
              '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}',
            ],
            [
              gl.FRAGMENT_SHADER,
              `#version 300 es\nprecision highp float;precision highp int;\n${shader}
uniform highp sampler2D queries;out vec4 result;
void main(){vec2 point=texelFetch(queries,ivec2(int(gl_FragCoord.x),0),0).xy;
result=vec4(applyLocalMasks(vec3(.2,.1,.05),point,1.),maskCoverage(0,maskCanonical(point)));}`,
            ],
          ] as const) {
            const item = gl.createShader(kind)!
            shaders.push(item)
            gl.shaderSource(item, code)
            gl.compileShader(item)
            if (!gl.getShaderParameter(item, gl.COMPILE_STATUS))
              throw new Error(gl.getShaderInfoLog(item) || 'Gradient shader compile failed.')
            gl.attachShader(program, item)
          }
          gl.linkProgram(program)
          if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(program) || 'Gradient shader link failed.')
          gl.useProgram(program)
          gl.disable(gl.DITHER)
          gl.disable(gl.BLEND)
          const texture = (unit: number) => {
              gl.activeTexture(gl.TEXTURE0 + unit)
              const item = gl.createTexture()!
              textures.push(item)
              gl.bindTexture(gl.TEXTURE_2D, item)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
              return item
            },
            output = texture(2)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, points.length, 1, 0, gl.RGBA, gl.FLOAT, null)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0)
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Gradient float framebuffer is incomplete.')
          texture(1)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA32F,
            points.length,
            1,
            0,
            gl.RGBA,
            gl.FLOAT,
            new Float32Array(points.flatMap((p) => [p.x * 200, p.y * 100, 0, 0])),
          )
          texture(0)
          gl.uniform1i(gl.getUniformLocation(program, 'localMaskData'), 0)
          gl.uniform1i(gl.getUniformLocation(program, 'queries'), 1)
          const values = cases.map((entry) => {
              const height = Math.ceil(entry.length / 4 / textureWidth),
                packed = new Float32Array(height * textureWidth * 4)
              packed.set(entry)
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA32F,
                textureWidth,
                height,
                0,
                gl.RGBA,
                gl.FLOAT,
                packed,
              )
              gl.viewport(0, 0, points.length, 1)
              gl.drawArrays(gl.TRIANGLES, 0, 3)
              const output = new Float32Array(points.length * 4)
              gl.readPixels(0, 0, points.length, 1, gl.RGBA, gl.FLOAT, output)
              if (gl.getError() !== gl.NO_ERROR) throw new Error('Gradient GLSL readback failed.')
              return [...output]
            }),
            debug = gl.getExtension('WEBGL_debug_renderer_info')
          return {
            values,
            renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
          }
        } finally {
          textures.forEach((item) => gl.deleteTexture(item))
          shaders.forEach((item) => gl.deleteShader(item))
          gl.deleteFramebuffer(framebuffer)
          gl.deleteProgram(program)
          gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
      },
      { cases, points, shader: localMasksGlsl, textureWidth: MASK_GPU_TEXTURE_WIDTH },
    )
  test.info().annotations.push({ type: 'webgl-renderer', description: results.renderer })
  for (const [ordinal, mask] of masks.entries())
    points.forEach((point, i) => {
      const coverage = referenceCoverage(mask, point.x, point.y, 200, 100),
        expected = [
          ...[0.2, 0.1, 0.05].map(
            (input) => input * (1 - coverage) + input * 2 ** mask.light.exposureEv * coverage,
          ),
          coverage,
        ]
      expected.forEach((value, channel) =>
        expect(
          Math.abs(results.values[ordinal][i * 4 + channel] - value),
          JSON.stringify({ ordinal, point, channel, value }),
        ).toBeLessThanOrEqual(2e-6 + 2e-5 * Math.abs(value)),
      )
    })
})
