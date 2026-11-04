import { test, expect } from './electron.fixture'
import reference from './fixtures/tone-curve-reference.json' with { type: 'json' }
import {
  compileToneCurves,
  identityToneCurves,
  curveChannels,
  type ToneCurves,
} from '../src/shared/tone-curves'
import { packToneCurves } from '../src/shared/tone-curves-gpu'
import { toneCurvesGlsl } from '../src/shared/tone-curves-glsl'
import { writeFile } from 'node:fs/promises'

test('GLSL curves meet the unchanged Decimal80 limits for signed values, maximum points, narrow segments, tails and alpha', async ({
  irodori,
}, info) => {
  for (const primaries of ['srgb', 'rec2020'] as const) {
    const runs = [
      {
        packed: [...packToneCurves(compileToneCurves(identityToneCurves))],
        scalar: false,
        identity: true,
        vectors: [{ input: [-0, 0, 1], output: [-0, 0, 1] }],
      },
      ...reference.curves.map((curve) => ({
        packed: [
          ...packToneCurves(compileToneCurves({ ...identityToneCurves, master: curve.points })),
        ],
        scalar: true,
        vectors: curve.gpuVectors.map((v) => ({
          input: [v.input, 0, 0],
          output: [v.output, 0, 0],
        })),
        identity: curve.points.every((p) => p.input === p.output),
      })),
      ...reference.settings.map((names, index) => {
        const curves = {
          version: 1,
          ...Object.fromEntries(
            curveChannels.map((channel, i) => [
              channel,
              reference.curves.find((curve) => curve.name === names[i])!.points,
            ]),
          ),
        } as ToneCurves
        const compiled = compileToneCurves(curves)
        return {
          packed: [...packToneCurves(compiled)],
          scalar: false,
          identity: compiled.identity,
          vectors: reference.colorVectors.filter(
            (v) => v.primaries === primaries && v.settings === index,
          ),
        }
      }),
    ]
    const measured = await irodori.page.evaluate(
      ({ shader, runs }) => {
        const canvas = new OffscreenCanvas(4096, 1),
          gl = canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
          })
        if (!gl || !gl.getExtension('EXT_color_buffer_float'))
          throw new Error('Float WebGL unavailable.')
        const program = gl.createProgram()!,
          framebuffer = gl.createFramebuffer()!,
          textures: WebGLTexture[] = [],
          shaders: WebGLShader[] = []
        const texture = () => {
          const t = gl.createTexture()!
          textures.push(t)
          gl.bindTexture(gl.TEXTURE_2D, t)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          return t
        }
        try {
          const started = performance.now()
          for (const [kind, source] of [
            [
              gl.VERTEX_SHADER,
              '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}',
            ],
            [
              gl.FRAGMENT_SHADER,
              `#version 300 es\nprecision highp float;precision highp int;\n${shader}\nuniform highp sampler2D source;uniform bool scalar;out vec4 result;void main(){vec4 p=texelFetch(source,ivec2(int(gl_FragCoord.x),0),0);vec3 v=scalar?vec3(curveValue(curveEvaluate(vec2(p.x,0.),0)),p.yz):applyToneCurves(p.rgb);result=vec4(v,p.a);}`,
            ],
          ] as const) {
            const s = gl.createShader(kind)!
            shaders.push(s)
            gl.shaderSource(s, source)
            gl.compileShader(s)
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
              throw new Error(gl.getShaderInfoLog(s) ?? 'compile')
            gl.attachShader(program, s)
          }
          gl.linkProgram(program)
          if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(program) ?? 'link')
          const compileMs = performance.now() - started
          gl.useProgram(program)
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
          gl.disable(gl.DITHER)
          gl.disable(gl.BLEND)
          const output = texture()
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4096, 1, 0, gl.RGBA, gl.FLOAT, null)
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0)
          gl.activeTexture(gl.TEXTURE0)
          texture()
          gl.uniform1i(gl.getUniformLocation(program, 'source'), 0)
          let maximumRatio = 0,
            alphaMismatch = 0,
            identityMismatch = 0,
            count = 0,
            worst: unknown
          for (const run of runs) {
            const n = run.vectors.length
            if (n > 4096) throw new Error('Bound exceeded')
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA32F,
              n,
              1,
              0,
              gl.RGBA,
              gl.FLOAT,
              new Float32Array(run.vectors.flatMap((v, i) => [...v.input, (i % 4) / 3])),
            )
            gl.uniform4fv(
              gl.getUniformLocation(program, 'toneCurveData[0]'),
              new Float32Array(run.packed),
            )
            gl.uniform1i(gl.getUniformLocation(program, 'scalar'), Number(run.scalar))
            gl.viewport(0, 0, n, 1)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            const values = new Float32Array(n * 4)
            gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, values)
            if (gl.getError() !== gl.NO_ERROR) throw new Error('GL probe error')
            run.vectors.forEach((v, i) => {
              count++
              if (values[i * 4 + 3] !== Math.fround((i % 4) / 3)) alphaMismatch++
              v.output.forEach((expected, c) => {
                const actual = values[i * 4 + c],
                  ratio = Math.abs(actual - expected) / (2e-6 + 2e-5 * Math.abs(expected))
                if (!Number.isFinite(actual)) throw new Error('Nonfinite curve output')
                if (run.identity && !Object.is(actual, Math.fround(v.input[c]))) identityMismatch++
                if (ratio > maximumRatio) {
                  maximumRatio = ratio
                  worst = { v, c, actual, expected }
                }
              })
            })
          }
          const debug = gl.getExtension('WEBGL_debug_renderer_info')
          return {
            maximumRatio,
            alphaMismatch,
            identityMismatch,
            count,
            worst,
            compileMs,
            renderer: debug
              ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
          }
        } finally {
          textures.forEach((t) => gl.deleteTexture(t))
          shaders.forEach((s) => gl.deleteShader(s))
          gl.deleteProgram(program)
          gl.deleteFramebuffer(framebuffer)
          gl.getExtension('WEBGL_lose_context')?.loseContext()
        }
      },
      { shader: toneCurvesGlsl(primaries), runs },
    )
    await writeFile(
      info.outputPath(`curve-glsl-${primaries}.json`),
      JSON.stringify(measured, null, 2),
    )
    expect(measured.count).toBeGreaterThan(2000)
    expect(measured.alphaMismatch).toBe(0)
    expect(measured.identityMismatch).toBe(0)
    expect(measured.maximumRatio, JSON.stringify(measured.worst)).toBeLessThanOrEqual(1)
  }
})
