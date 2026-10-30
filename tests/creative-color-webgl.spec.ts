import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { test, expect } from './electron.fixture'
import { creativeColorGlsl } from '../src/shared/creative-color-glsl'
import { compileCreativeColor } from '../src/shared/creative-color'
import { packCreativeColor } from '../src/shared/creative-color-gpu'
import type { ColorMixerSettings } from '../src/shared/color-mixer'
import type { ColorGradingSettings } from '../src/shared/color-grading'
import type { ColorPrimaries, ColorTriple } from '../src/shared/color-model'

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/creative-color-reference.json', import.meta.url), 'utf8'),
) as {
  configurations: {
    mixer: ColorMixerSettings
    grading: ColorGradingSettings
    intensity: { saturation: number; vibrance: number }
  }[]
  gpuVectors: {
    input: ColorTriple
    output: ColorTriple
    primaries: ColorPrimaries
    configuration: number
    selection: { first: number; second: number; blend: number; protection: number }
  }[]
}

test('hidden WebGL2 color kernels retain independent HDR/SDR limits and the old neutral intensity result', async ({
  irodori,
}, info) => {
  const metrics: unknown[] = []
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const runs = reference.configurations.map((config, index) => ({
      packed: [
        ...packCreativeColor(compileCreativeColor(config.mixer, config.intensity, config.grading)),
      ],
      vectors: reference.gpuVectors.filter(
        (v) => v.primaries === primaries && v.configuration === index,
      ),
    }))
    const shader = creativeColorGlsl(primaries)
    const measured = await irodori.page.evaluate(
      ({ runs, shader }) => {
        const canvas = new OffscreenCanvas(126, 1),
          gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
          })
        if (!gl || !gl.getExtension('EXT_color_buffer_float'))
          throw new Error('Floating-point WebGL2 unavailable.')
        const shaders: WebGLShader[] = [],
          textures: WebGLTexture[] = []
        const program = gl.createProgram()!,
          framebuffer = gl.createFramebuffer()!
        const compileStart = performance.now()
        const compile = (kind: number, source: string) => {
          const value = gl.createShader(kind)!
          shaders.push(value)
          gl.shaderSource(value, source)
          gl.compileShader(value)
          if (!gl.getShaderParameter(value, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(value) ?? 'Shader compilation failed.')
          gl.attachShader(program, value)
        }
        const allocate = () => {
          const value = gl.createTexture()!
          textures.push(value)
          gl.bindTexture(gl.TEXTURE_2D, value)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          return value
        }
        try {
          compile(
            gl.VERTEX_SHADER,
            `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`,
          )
          compile(
            gl.FRAGMENT_SHADER,
            `#version 300 es
precision highp float;precision highp int;
${shader}
uniform highp sampler2D source;
layout(location=0) out vec4 result;
layout(location=1) out vec4 selection;
layout(location=2) out vec4 oldIntensity;
void main(){vec4 pixel=texelFetch(source,ivec2(int(gl_FragCoord.x),0),0);result=vec4(applyCreativeColor(pixel.rgb),pixel.a);selection=ccSelection(pixel.rgb);oldIntensity=vec4(applyColorIntensity(pixel.rgb,creativeColorData[0].xy),pixel.a);}`,
          )
          gl.linkProgram(program)
          if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed.')
          const compileMs = performance.now() - compileStart
          gl.useProgram(program)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
          gl.disable(gl.DITHER)
          gl.disable(gl.BLEND)
          for (let i = 0; i < 3; i++) {
            const texture = allocate()
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 126, 1, 0, gl.RGBA, gl.FLOAT, null)
            gl.framebufferTexture2D(
              gl.FRAMEBUFFER,
              gl.COLOR_ATTACHMENT0 + i,
              gl.TEXTURE_2D,
              texture,
              0,
            )
          }
          gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2])
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
            throw new Error('Incomplete numeric framebuffer.')
          gl.activeTexture(gl.TEXTURE0)
          allocate()
          gl.uniform1i(gl.getUniformLocation(program, 'source'), 0)
          const results: number[][][] = []
          for (const run of runs) {
            if (run.vectors.length !== 126) throw new Error('Unexpected numeric probe dimensions.')
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA32F,
              126,
              1,
              0,
              gl.RGBA,
              gl.FLOAT,
              new Float32Array(run.vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
            )
            gl.uniform4fv(
              gl.getUniformLocation(program, 'creativeColorData[0]'),
              new Float32Array(run.packed),
            )
            gl.viewport(0, 0, 126, 1)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            const planes: number[][] = []
            for (let i = 0; i < 3; i++) {
              const pixels = new Float32Array(126 * 4)
              gl.readBuffer(gl.COLOR_ATTACHMENT0 + i)
              gl.readPixels(0, 0, 126, 1, gl.RGBA, gl.FLOAT, pixels)
              planes.push([...pixels])
            }
            if (gl.getError() !== gl.NO_ERROR)
              throw new Error('WebGL numeric probe reported an error.')
            results.push(planes)
          }
          const debug = gl.getExtension('WEBGL_debug_renderer_info')
          return {
            results,
            compileMs,
            renderer: debug
              ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
              : String(gl.getParameter(gl.RENDERER)),
          }
        } finally {
          for (const texture of textures) gl.deleteTexture(texture)
          for (const value of shaders) gl.deleteShader(value)
          gl.deleteFramebuffer(framebuffer)
          gl.deleteProgram(program)
          gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
      },
      { runs, shader },
    )
    let maximumRatio = 0,
      selectionRatio = 0,
      worst: unknown,
      worstSelection: unknown
    for (const [r, run] of runs.entries())
      for (const [i, v] of run.vectors.entries()) {
        const [pixels, selected, old] = measured.results[r],
          at = i * 4
        assert.equal(pixels[at + 3], Math.fround((i % 4) / 3))
        for (let c = 0; c < 3; c++) {
          const value = pixels[at + c],
            expected = v.output[c],
            ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
          assert.ok(Number.isFinite(value))
          if (run.packed[2] === 0 && run.packed[3] === 0) assert.equal(value, old[at + c])
          if (ratio > maximumRatio) {
            maximumRatio = ratio
            worst = { v, c, value, expected }
          }
        }
        const first = selected[at],
          second = selected[at + 1],
          blend = selected[at + 2],
          protection = selected[at + 3],
          expectedSelection = v.selection
        assert.ok(Number.isInteger(first) && first >= 0 && first < 8)
        assert.equal(second, (first + 1) % 8)
        for (let j = 0; j < 9; j++) {
          const value = j === 8 ? protection : j === first ? 1 - blend : j === second ? blend : 0,
            expected =
              j === 8
                ? expectedSelection.protection
                : j === expectedSelection.first
                  ? 1 - expectedSelection.blend
                  : j === expectedSelection.second
                    ? expectedSelection.blend
                    : 0,
            ratio = Math.abs(value - expected) / (2e-6 + 2e-5 * Math.abs(expected))
          assert.ok(Number.isFinite(value))
          if (ratio > selectionRatio) {
            selectionRatio = ratio
            worstSelection = { v, j, value, expected }
          }
        }
      }
    const diagnostic = info.outputPath(`creative-color-${primaries}-diagnostic.json`)
    await writeFile(
      diagnostic,
      JSON.stringify(
        { primaries, maximumRatio, selectionRatio, worst, worstSelection, runs, measured },
        null,
        2,
      ),
    )
    await info.attach(`creative-color-${primaries}-diagnostic`, {
      path: diagnostic,
      contentType: 'application/json',
    })
    expect(
      maximumRatio,
      JSON.stringify({ primaries, worst, selectionRatio, worstSelection }),
    ).toBeLessThanOrEqual(1)
    expect(selectionRatio, JSON.stringify({ primaries, worstSelection })).toBeLessThanOrEqual(1)
    metrics.push({
      primaries,
      count: 1260,
      maximumRatio,
      selectionRatio,
      renderer: measured.renderer,
      compileMs: measured.compileMs,
    })
  }
  const path = info.outputPath('creative-color-webgl-agreement.json')
  await writeFile(path, JSON.stringify(metrics, null, 2))
  await info.attach('creative-color-webgl-agreement', { path, contentType: 'application/json' })
})
