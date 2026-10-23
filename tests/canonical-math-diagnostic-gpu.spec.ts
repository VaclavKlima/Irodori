import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hdrRenderingWgsl } from '../src/renderer/src/preview/hdr-shader'
import { acesWgsl } from '../src/shared/aces-wgsl'
import { ACES_DATA_BYTES, packAces } from '../src/shared/aces-data'
import {
  DISPLAY_RENDERING_VERSION,
  prepareDisplayRendering,
  REC2020_TO_ACES,
} from '../src/shared/display-rendering'
import { referenceAces } from './aces-reference'
import {
  buildCanonicalStageReference,
  canonicalReferenceStages,
  canonicalStageNames,
  type StageRequest,
} from './canonical-math-diagnostic.helpers'

const cases = [
  {
    name: 'hdr-4-display-p3',
    originalIndex: 5548,
    source: [-0.10300952941179276, 10.300952911376953, 0.010300952941179276],
    alpha: 0,
    peak: 4,
    colorSpace: 'display-p3' as const,
    originalCanonicalRed: 0.07339680194854736,
  },
  {
    name: 'hdr-10-rec2020',
    originalIndex: 5602,
    source: [-0.1523599475622177, 15.235994338989258, 0.015235994011163712],
    alpha: 0.5,
    peak: 10,
    colorSpace: 'rec2020' as const,
    originalCanonicalRed: 0.14890825748443604,
  },
]
const extraStageNames = [
  'degree-conversion-hi-lo-value-wrapped',
  'input-J-power-hi-lo-J-czLo',
  'gamut-interval-weight-hueLow-hueHigh',
  'actual-multiply-operands-hi-lo',
  'actual-multiply-rounded-residual-result-hi-lo',
  'actual-sum-operands-hi-lo',
  'actual-sum-result-hi-lo-rounded',
  'synthetic-multiply-operands-hi-lo',
  'synthetic-multiply-rounded-residual-result-hi-lo',
  'synthetic-sum-result-hi-lo',
  'output-cone-and-inverse-hi-lo',
  'portable-actual-and-synthetic-product-residuals',
  'native-atan2-radians-degrees-and-compensated-radians-degrees',
] as const
const stageNames = [...canonicalStageNames, ...extraStageNames]
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const matrix =
  'mat3x3f(' + REC2020_TO_ACES.map((row) => 'vec3f(' + row.join(',') + ')').join(',') + ')'
const resultBinding = '@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;'
const directShader = `${hdrRenderingWgsl}
${resultBinding}
@compute @workgroup_size(1) fn check() {
 let pixel=textureLoad(pixels,vec2i(0),0);
 result[0]=vec4f(outputRgb(pixel.rgb),pixel.a);
}`
const traceShader = `${hdrRenderingWgsl}
${resultBinding}
fn saveStage(stage:u32,value:vec3f,alpha:f32) {result[stage]=vec4f(value,alpha);}
@compute @workgroup_size(1) fn check() {
 let pixel=textureLoad(pixels,vec2i(0),0);
 let ip=aces_input_params(); let lp=aces_limit_params();
 let ap0=${matrix}*pixel.rgb;
 let bounded=clamp_AP0_to_AP1(ap0,0.,aces_ts().forward_limit);
 let aab=RGB_to_Aab(bounded,ip); let jmh=Aab_to_JMh(aab,ip);
 let linear=J_to_Y(jmh.x,ip)/ref_luminance;
 let toneY=tonescale_fwd(linear,aces_ts()); let jt=Y_to_J(toneY,ip);
 let toned=chroma_compress_fwd(jmh,jt); let gamut=gamut_compress_fwd(toned);
 let outAab=JMh_to_Aab(gamut,lp); let rgb=Aab_to_RGB(outAab,lp);
 let hdp=init_HueDependentGamutParams(toned.z);
 saveStage(0u,pixel.rgb,pixel.a); saveStage(1u,ap0,pixel.a);
 saveStage(2u,bounded,pixel.a); saveStage(3u,aab,pixel.a);
 saveStage(4u,jmh,pixel.a); saveStage(5u,vec3f(linear,toneY,jt),pixel.a);
 saveStage(6u,toned,pixel.a); saveStage(7u,gamut,pixel.a);
 saveStage(8u,outAab,pixel.a); saveStage(9u,rgb,pixel.a);
 saveStage(10u,clamp(rgb,vec3f(0.),vec3f(u.values[3].z)),pixel.a);
 saveStage(11u,outputRgb(pixel.rgb),pixel.a);
 saveStage(12u,vec3f(hdp.JMcusp,hdp.gamma_top_inv),pixel.a);
 saveStage(13u,vec3f(hdp.gamma_bottom_inv,hdp.focus_J,hdp.analytical_threshold),pixel.a);
 let anglePair=acesAtan2(aab.z,aab.y);let angle=dsValue(anglePair);
 let degrees=dsMul(anglePair,vec2f(57.29577951308232,-6.688024427603523e-7));
 let power=dsPow(ds(aab.x),vec2f(ip.cz,ip.cz_lo));
 saveStage(14u,vec3f(angle,dsValue(degrees),length(aab.yz)),pixel.a);
 saveStage(15u,vec3f(aab.x,dsValue(vec2f(ip.cz,ip.cz_lo)),dsValue(power)),pixel.a);
 result[16]=vec4f(degrees,dsValue(degrees),wrap_to_360(dsValue(degrees)));
 result[17]=vec4f(power,jmh.x,ip.cz_lo);
 let interval=lookup_hue_interval(toned.z);
 let low=acesData.values[434+interval-1].x; let high=acesData.values[434+interval].x;
 result[18]=vec4f(f32(interval),interpolation_weight(toned.z,low,high),low,high);
 let a=bounded.x; let b=ip.MATRIX_RGB_to_CAM16_c[0][0];
 let bLo=ip.MATRIX_RGB_to_CAM16_c_lo[0][0];
 let product=acesRound(a*b); let multiplied=dsMul(ds(a),vec2f(b,bLo));
 result[19]=vec4f(a,0.,b,bLo);
 result[20]=vec4f(product,fma(a,b,-product),multiplied);
 let term0=dsMul(ds(bounded.x),vec2f(ip.MATRIX_RGB_to_CAM16_c[0][0],ip.MATRIX_RGB_to_CAM16_c_lo[0][0]));
 let term1=dsMul(ds(bounded.y),vec2f(ip.MATRIX_RGB_to_CAM16_c[1][0],ip.MATRIX_RGB_to_CAM16_c_lo[1][0]));
 let sum=dsAdd(ds(term0.x),ds(term1.x));
 result[21]=vec4f(term0.x,0.,term1.x,0.);
 result[22]=vec4f(sum,acesRound(term0.x+term1.x),0.);
 let ma=u.values[0].x; let mb=u.values[0].y;
 let mp=acesRound(ma*mb); let mm=dsMul(ds(ma),ds(mb));
 result[23]=vec4f(ma,0.,mb,0.);
 result[24]=vec4f(mp,fma(ma,mb,-mp),mm);
 result[25]=vec4f(dsAdd(ds(ma),ds(mb)),0.,0.);
 let outputCone=dsMatrix(array<vec2f,3>(ds(outAab.x),ds(outAab.y),ds(outAab.z)),lp.MATRIX_Aab_to_cone_response,lp.MATRIX_Aab_to_cone_response_lo);
 result[26]=vec4f(outputCone[0],dsConeInverse(outputCone[0]));
 result[27]=vec4f(acesProductError(a,b,product),acesProductError(ma,mb,mp),0.,0.);
 let nativeAngle=atan2(aab.z,aab.y);
 result[28]=vec4f(nativeAngle,radians_to_degrees(nativeAngle),angle,dsValue(degrees));
}`

function error(actual: readonly number[], reference: readonly number[]) {
  return actual.map((value, channel) => ({
    channel,
    actual: value,
    reference: reference[channel],
    difference: value - reference[channel],
    denominator: 2e-6 + 2e-5 * Math.abs(reference[channel]),
    ratio: Math.abs(value - reference[channel]) / (2e-6 + 2e-5 * Math.abs(reference[channel])),
  }))
}
function productCheck(operands: number[], actual: number[], portableResidual: number) {
  // Products of the captured binary32 operands fit exactly in binary64 here.
  const product = operands[0] * operands[2]
  const rounded = Math.fround(product)
  const residual = Math.fround(product - rounded)
  return {
    operands,
    actual,
    expectedRounded: rounded,
    expectedFusedResidual: residual,
    portableResidual,
    rawFmaResidualSupported: actual[1] === residual,
    reconstructedPair: actual[2] + actual[3],
    referencePairApproximation: (operands[0] + operands[1]) * (operands[2] + operands[3]),
  }
}
function sumCheck(operands: number[], actual: number[]) {
  const sum = operands[0] + operands[2]
  const high = Math.fround(sum)
  return { operands, actual, expectedHigh: high, expectedLow: Math.fround(sum - high) }
}

let retainedGpu: GPU | undefined

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('portable product residuals reconstruct signed and scaled binary32 products without fused fma', async ({}, info) => {
  const directory = info.outputPath('portable-products')
  await mkdir(directory, { recursive: true })
  const bases = [
    [1 + 2 ** -23, 1 + 2 ** -23],
    [1 - 2 ** -24, 1 + 2 ** -23],
    [1.5561984777450562, 0.4451810121536255],
    [2.3017513751983643, 0.4451810121536255],
    [Math.fround(0.0031308), Math.fround(57.29577951308232)],
  ]
  const scales = [
    [-60, 0],
    [-40, -40],
    [-30, -30],
    [0, 0],
    [30, 30],
    [-100, 100],
    [100, -100],
  ]
  const operands = bases.flatMap(([a, b]) =>
    scales.flatMap(([ea, eb]) =>
      [-1, 1].map((sign) => [Math.fround(sign * a * 2 ** ea), Math.fround(b * 2 ** eb), 0, 0]),
    ),
  )
  operands.push([0, 1, 0, 0], [1, 0, 0, 0])
  const input = new Float32Array(operands.flat())
  const code = `${acesWgsl}
@group(0) @binding(5) var<storage,read> operands:array<vec4f>;
${resultBinding}
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=${operands.length}u) {return;}
 let v=operands[id.x];let product=acesRound(v.x*v.y);
 let pair=dsMul(ds(v.x),ds(v.y));
 result[id.x*2u]=vec4f(product,acesProductError(v.x,v.y,product),pair);
 result[id.x*2u+1u]=vec4f(fma(v.x,v.y,-product),0.,0.,0.);
}`
  await writeFile(join(directory, 'portable-products.wgsl'), code)
  await writeFile(join(directory, 'input.f32'), new Uint8Array(input.buffer))
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const resources: GPUBuffer[] = []
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    resources.push(value)
    return value
  }
  const source = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const output = buffer(operands.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  const staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  let actual = new Float32Array(0)
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'check' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: { buffer: output } },
        { binding: 5, resource: { buffer: source } },
      ],
    })
    device.queue.writeBuffer(source, 0, input)
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(operands.length / 64))
    pass.end()
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    try {
      actual = new Float32Array(staging.getMappedRange().slice(0))
    } finally {
      staging.unmap()
    }
    await writeFile(join(directory, 'output.f32'), new Uint8Array(actual.buffer))
    const measurements = operands.map(([a, b], index) => {
      const observed = Array.from(actual.slice(index * 8, index * 8 + 8))
      const exactProduct = a * b
      const expectedResidual = Math.fround(exactProduct - observed[0])
      return {
        index,
        a,
        b,
        exactProduct,
        observed,
        expectedResidual,
        residualIsNormalOrZero: expectedResidual === 0 || Math.abs(expectedResidual) >= 2 ** -126,
        reconstructedProduct: observed[2] + observed[3],
        rawFmaResidualSupported: observed[4] === expectedResidual,
      }
    })
    await writeFile(
      join(directory, 'portable-products.json'),
      JSON.stringify(
        {
          scope:
            '72 signed/scaled binary32 products; no ACES target, reference or tolerance changes.',
          sampleCount: operands.length,
          canonicalShaderSha256: sha(acesWgsl),
          shaderSha256: sha(code),
          inputSha256: sha(new Uint8Array(input.buffer)),
          outputSha256: sha(new Uint8Array(actual.buffer)),
          adapter: {
            vendor: adapter!.info.vendor,
            architecture: adapter!.info.architecture,
            device: adapter!.info.device,
            description: adapter!.info.description,
          },
          oracle:
            'Each binary32 multiplication has at most 48 significand bits, exactly representable in binary64 for this finite bounded corpus. Expected residual uses the actual measured rounded product.',
          subnormalLimit:
            'Assertions cover normal residuals and zero; WGSL permits subnormal flushing. This is not a universal IEEE subnormal conformance claim.',
          errors,
          measurements,
        },
        null,
        2,
      ) + '\n',
    )
    expect(errors).toEqual([])
    for (const value of measurements) {
      expect
        .soft(value.residualIsNormalOrZero, `sample${value.index}: declared normal domain`)
        .toBe(true)
      expect
        .soft(
          Math.abs(value.observed[1] - value.expectedResidual),
          `sample${value.index}: portable residual`,
        )
        .toBe(0)
      expect
        .soft(
          Math.abs(value.reconstructedProduct - value.exactProduct),
          `sample${value.index}: compensated product`,
        )
        .toBe(0)
    }
  } finally {
    for (const resource of resources) resource.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('compensated canonical hue covers quadrants axes and extreme finite ratios', async ({}, info) => {
  const directory = info.outputPath('canonical-angles')
  await mkdir(directory, { recursive: true })
  const samples = new Map<string, { x: number; y: number; scope: string }>()
  const add = (x: number, y: number, scope: string) => {
    const values = new Float32Array([x, y])
    const bits = new Uint32Array(values.buffer)
    const key = Array.from(bits).join('-')
    if (!samples.has(key)) samples.set(key, { x: values[0], y: values[1], scope })
  }
  const transition = Math.fround(Math.SQRT2 - 1)
  const ratios = [
    ...Array.from({ length: 33 }, (_, index) => index / 32),
    transition - 2 ** -25,
    transition,
    transition + 2 ** -25,
    1 - 2 ** -23,
    2 ** -12,
    2 ** -16 - 2 ** -40,
    2 ** -16,
    2 ** -16 + 2 ** -39,
    2 ** -32,
    2 ** -80,
    2 ** -126,
  ]
  for (const scale of [2 ** -100, 1, 2 ** 100])
    for (const ratio of ratios)
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          add(sx * scale, sy * scale * ratio, 'ratio grid and analytic reduction boundaries')
          add(sx * scale * ratio, sy * scale, 'ratio grid and analytic reduction boundaries')
        }
  for (const x of [0, -0, 1, -1])
    for (const y of [0, -0, 1, -1]) add(x, y, 'axes and signed-zero inputs')
  const maximum = (2 - 2 ** -23) * 2 ** 127
  for (const [x, y] of [
    [2 ** -126, 2 ** 127],
    [2 ** 127, 2 ** -126],
    [maximum, maximum],
    [maximum, 2 ** -126],
    [2 ** -126, maximum],
    [1, 2 ** -149],
    [2 ** -149, 1],
    [2 ** -149, 2 ** -149],
    [2 ** -126 - 2 ** -149, 2 ** -149],
  ])
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        add(sx * x, sy * y, 'finite exponent extremes and subnormal observations')
  const turnUlp = 2 ** -15
  const wrapBoundaries = [
    { input: 0, expected: 0, exact: true, scope: 'positive zero' },
    { input: -0, expected: 0, exact: true, scope: 'negative zero' },
    { input: 2 ** -126, expected: 2 ** -126, exact: true, scope: 'smallest normal positive hue' },
    { input: -(2 ** -126), expected: 0, exact: false, scope: 'smallest normal negative hue' },
    { input: 2 ** -32, expected: 2 ** -32, exact: true, scope: 'tiny positive hue' },
    { input: -(2 ** -32), expected: 0, exact: false, scope: 'tiny negative hue rounds to a turn' },
    { input: 2 ** -17, expected: 2 ** -17, exact: true, scope: 'positive quarter turn ULP' },
    { input: -(2 ** -17), expected: 0, exact: false, scope: 'negative quarter turn ULP' },
    { input: -(2 ** -16), expected: 0, exact: false, scope: 'negative half turn ULP' },
    { input: -turnUlp, expected: 360 - turnUlp, exact: true, scope: 'negative full turn ULP' },
    { input: 360 - turnUlp, expected: 360 - turnUlp, exact: true, scope: 'one ULP below a turn' },
    { input: 360, expected: 0, exact: true, scope: 'exact positive turn' },
    { input: 360 + turnUlp, expected: turnUlp, exact: true, scope: 'one ULP above a turn' },
    {
      input: -360 + turnUlp,
      expected: turnUlp,
      exact: true,
      scope: 'one ULP above a negative turn',
    },
    { input: -360, expected: 0, exact: true, scope: 'exact negative turn' },
    {
      input: -360 - turnUlp,
      expected: 360 - turnUlp,
      exact: true,
      scope: 'one ULP below a negative turn',
    },
    {
      input: 720 - 2 * turnUlp,
      expected: 360 - 2 * turnUlp,
      exact: true,
      scope: 'below two turns',
    },
    { input: 720, expected: 0, exact: true, scope: 'two turns' },
    { input: 720 + 2 * turnUlp, expected: 2 * turnUlp, exact: true, scope: 'above two turns' },
    {
      input: -720 - 2 * turnUlp,
      expected: 360 - 2 * turnUlp,
      exact: true,
      scope: 'below negative two turns',
    },
    { input: -720, expected: 0, exact: true, scope: 'negative two turns' },
    {
      input: -720 + 2 * turnUlp,
      expected: 2 * turnUlp,
      exact: true,
      scope: 'above negative two turns',
    },
    {
      input: 1080 - 4 * turnUlp,
      expected: 360 - 4 * turnUlp,
      exact: true,
      scope: 'below three turns',
    },
    { input: 1080, expected: 0, exact: true, scope: 'three turns' },
    { input: 1080 + 4 * turnUlp, expected: 4 * turnUlp, exact: true, scope: 'above three turns' },
    {
      input: -1080 - 4 * turnUlp,
      expected: 360 - 4 * turnUlp,
      exact: true,
      scope: 'below negative three turns',
    },
    { input: -1080, expected: 0, exact: true, scope: 'negative three turns' },
    {
      input: -1080 + 4 * turnUlp,
      expected: 4 * turnUlp,
      exact: true,
      scope: 'above negative three turns',
    },
  ]
  const cases = Array.from(samples.values())
  if (cases.length < wrapBoundaries.length)
    throw new Error('Insufficient angular rows for wrap boundaries.')
  const input = new Float32Array(
    cases.flatMap(({ x, y }, index) => [x, y, wrapBoundaries[index]?.input ?? 0, 0]),
  )
  const code = `${acesWgsl}
@group(0) @binding(5) var<storage,read> operands:array<vec4f>;
${resultBinding}
@compute @workgroup_size(64) fn check(@builtin(global_invocation_id) id:vec3u) {
 if(id.x>=${cases.length}u) {return;}
 let v=operands[id.x];let angle=acesAtan2(v.y,v.x);
 let degrees=acesAtan2Degrees(v.y,v.x);
 result[id.x*2u]=vec4f(angle,dsValue(angle),degrees);
 result[id.x*2u+1u]=vec4f(degrees,wrap_to_360(degrees),atan2(v.y,v.x),wrap_to_360(v.z));
}`
  await writeFile(join(directory, 'canonical-angles.wgsl'), code)
  await writeFile(join(directory, 'input.f32'), new Uint8Array(input.buffer))
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const resources: GPUBuffer[] = []
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    resources.push(value)
    return value
  }
  const source = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const output = buffer(cases.length * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  const staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'check' },
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: { buffer: output } },
        { binding: 5, resource: { buffer: source } },
      ],
    })
    device.queue.writeBuffer(source, 0, input)
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(cases.length / 64))
    pass.end()
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    let actual: Float32Array
    try {
      actual = new Float32Array(staging.getMappedRange().slice(0))
    } finally {
      staging.unmap()
    }
    await writeFile(join(directory, 'output.f32'), new Uint8Array(actual.buffer))
    const ulp = (value: number) =>
      Math.max(2 ** -149, 2 ** (Math.floor(Math.log2(Math.abs(Math.fround(value)))) - 23))
    const wrapped = (value: number) => ((value % 360) + 360) % 360
    const measurements = cases.map((sample, index) => {
      const observed = Array.from(actual.slice(index * 8, index * 8 + 8))
      const radians = Math.atan2(sample.y, sample.x)
      const degrees = (radians * 180) / Math.PI
      const subnormalInput = [sample.x, sample.y].some(
        (value) => value !== 0 && Math.abs(value) < 2 ** -126,
      )
      const subnormalAngle = radians !== 0 && Math.abs(radians) < 2 ** -126
      const axis = sample.x === 0 || sample.y === 0
      const wrapDifference = Math.abs(wrapped(observed[5]) - wrapped(degrees))
      return {
        index,
        ...sample,
        inputBits: Array.from(new Uint32Array(input.buffer, index * 16, 2)),
        observed,
        reference: { radians, degrees, wrappedDegrees: wrapped(degrees) },
        reconstructedRadians: observed[0] + observed[1],
        radiansErrorUlps: Math.abs(observed[2] - radians) / ulp(radians),
        degreesErrorUlps: Math.abs(observed[3] - degrees) / ulp(degrees),
        wrappedError: Math.min(wrapDifference, 360 - wrapDifference),
        subnormalInput,
        subnormalAngle,
        axis,
        bothZero: sample.x === 0 && sample.y === 0,
        observationalOnly: subnormalInput || subnormalAngle || axis,
      }
    })
    const wrapMeasurements = wrapBoundaries.map((sample, index) => {
      const observed = actual[index * 8 + 7]
      const difference = Math.abs(observed - sample.expected)
      return {
        ...sample,
        inputBits: new Uint32Array(input.buffer, index * 16 + 8, 1)[0],
        observed,
        observedBits: new Uint32Array(actual.buffer, (index * 8 + 7) * 4, 1)[0],
        circularError: Math.min(difference, 360 - difference),
      }
    })
    await writeFile(
      join(directory, 'canonical-angles.json'),
      JSON.stringify(
        {
          scope:
            'Compensated canonical angle primitive only; original final-output CTL gates, tolerances and rendering versions are unchanged.',
          sampleCount: cases.length,
          assertedAngularSamples: measurements.filter((value) => !value.observationalOnly).length,
          reference: 'Host binary64 Math.atan2 of the exact retained binary32 input operands.',
          analyticSources: ['https://dlmf.nist.gov/4.24.E3', 'https://dlmf.nist.gov/4.24.E15'],
          coefficientRecipe:
            'High/low binary32 split of (-1)^i/(2*i+1), i=0..15; no fitted coefficients.',
          analyticRemainder: {
            maximumReducedArgument: 0.415,
            terms: 16,
            realSeriesTailRadians: 0.415 ** 33 / 33,
            smallRatioLinearTailRadians: 2 ** -48 / 3,
            discardedExtremeRatioRadians: 2 ** -126,
            limit:
              'Analytic truncation bounds exclude WGSL arithmetic and final binary32 rounding.',
          },
          numericalCheck:
            'At most one binary32 ULP from the binary64 angle and degree reference on normal nonaxis samples; the existing final-output CTL bound remains authoritative.',
          platformLimits:
            'Subnormal input/angle and raw signed-zero axis behavior are observations: WGSL permits flushing and ignoring zero signs. Nonzero axes retain their circular hue check; both-zero quadrants are observations only.',
          canonicalShaderSha256: sha(acesWgsl),
          shaderSha256: sha(code),
          inputSha256: sha(new Uint8Array(input.buffer)),
          outputSha256: sha(new Uint8Array(actual.buffer)),
          adapter: {
            vendor: adapter!.info.vendor,
            architecture: adapter!.info.architecture,
            device: adapter!.info.device,
            description: adapter!.info.description,
          },
          errors,
          measurements,
          wrapBoundaries: wrapMeasurements,
          wrapContract:
            'Finite hues remain in [0, 360), including rounded negative near-zero inputs. Exact-turn and signed-zero inputs normalize to positive zero. Tiny negative additions may round to either adjacent binary32 endpoint under WGSL; circular error remains bounded by one turn ULP.',
        },
        null,
        2,
      ) + '\n',
    )
    expect(errors).toEqual([])
    for (const value of wrapMeasurements) {
      expect.soft(value.observed, `wrap ${value.scope}: finite`).toBeGreaterThanOrEqual(0)
      expect.soft(value.observed, `wrap ${value.scope}: half-open interval`).toBeLessThan(360)
      expect
        .soft(value.circularError, `wrap ${value.scope}: circular hue`)
        .toBeLessThanOrEqual(turnUlp)
      if (value.exact)
        expect.soft(value.observed, `wrap ${value.scope}: exact boundary`).toBe(value.expected)
      if (value.exact && value.expected === 0)
        expect.soft(value.observedBits, `wrap ${value.scope}: positive zero`).toBe(0)
    }
    for (const value of measurements) {
      expect
        .soft(value.observed.slice(0, 6).every(Number.isFinite), `angle ${value.index}: finite`)
        .toBe(true)
      expect
        .soft(value.observed[5], `angle ${value.index}: wrapped lower bound`)
        .toBeGreaterThanOrEqual(0)
      expect.soft(value.observed[5], `angle ${value.index}: wrapped upper bound`).toBeLessThan(360)
      if (!value.observationalOnly) {
        expect.soft(value.radiansErrorUlps, `angle ${value.index}: radians`).toBeLessThanOrEqual(1)
        expect.soft(value.degreesErrorUlps, `angle ${value.index}: degrees`).toBeLessThanOrEqual(1)
      }
      if (!value.bothZero && !value.subnormalInput && !value.subnormalAngle)
        expect
          .soft(value.wrappedError, `angle ${value.index}: circular hue`)
          .toBeLessThanOrEqual(ulp(360))
    }
  } finally {
    for (const resource of resources) resource.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('two original canonical HDR offenders retain independent stages and compensation premises', async ({}, info) => {
  test.setTimeout(120000)
  const directory = info.outputPath('canonical-diagnostic')
  await mkdir(directory, { recursive: true })
  if (canonicalStageNames.length !== 16)
    throw new Error('Expected exactly sixteen independent stages.')
  if (hdrRenderingWgsl.split(acesWgsl).length !== 2)
    throw new Error(
      'The unchanged canonical shader must occur exactly once in the renderer prefix.',
    )
  if (hdrRenderingWgsl.split(`outputTransform_fwd(${matrix}*rgb)`).length !== 2)
    throw new Error('The production input-matrix expression must occur exactly once.')
  const reference = await buildCanonicalStageReference(directory)
  const files: Record<string, { path: string; sha256: string; byteLength: number }> = {}
  const retain = async (name: string, filename: string, bytes: string | Uint8Array) => {
    await writeFile(join(directory, filename), bytes)
    files[name] = { path: filename, sha256: sha(bytes), byteLength: Buffer.byteLength(bytes) }
  }
  await retain('directShader', 'canonical-direct.wgsl', directShader)
  await retain('traceShader', 'canonical-trace.wgsl', traceShader)
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        'scripts/aces-precision.wgsl',
        'scripts/generate-aces.py',
        'src/shared/aces-wgsl.ts',
        'src/shared/aces-data.ts',
        'src/shared/aces-precision-wgsl.ts',
        'src/shared/display-rendering.ts',
        'src/renderer/src/preview/hdr-shader.ts',
        'tests/canonical-math-diagnostic-gpu.spec.ts',
        'tests/canonical-math-diagnostic.helpers.ts',
      ].map(async (path) => [path, sha(await readFile(path))]),
    ),
  )
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter, 'A hardware GPU is required.').toBe(false)
  const device = await adapter!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  const resources: Array<GPUBuffer | GPUTexture> = []
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage })
    resources.push(value)
    return value
  }
  const uniform = buffer(176, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
  const tables = buffer(ACES_DATA_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)
  const texture = device.createTexture({
    size: [1, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  resources.push(texture)
  const output = buffer(stageNames.length * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
  const staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
  const measurements: unknown[] = []
  const nearAxisMeasurements: unknown[] = []
  const nearAxisChecks: Array<{
    name: string
    ratio: number
    hue: number
    traceMatchesDirect: boolean
    decompositionMatchesDirect: boolean
    finite: boolean
  }> = []
  const checks: Array<{
    name: string
    ratio: number
    alpha: number
    expectedAlpha: number
    directMatchesTrace: boolean
    decompositionMatchesDirect: boolean
    nonfiniteValues: number
    products: ReturnType<typeof productCheck>[]
    sums: ReturnType<typeof sumCheck>[]
  }> = []
  const dispatch = async (pipeline: GPUComputePipeline, group: GPUBindGroup) => {
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(1)
    pass.end()
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    try {
      return new Float32Array(staging.getMappedRange().slice(0))
    } finally {
      staging.unmap()
    }
  }
  const pipeline = async (code: string) => {
    const value = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'check' },
    })
    const group = device.createBindGroup({
      layout: value.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: output } },
        { binding: 4, resource: { buffer: tables } },
      ],
    })
    return { pipeline: value, group }
  }
  try {
    const direct = await pipeline(directShader),
      trace = await pipeline(traceShader)
    for (const sample of cases) {
      const source = new Float32Array([...sample.source, sample.alpha])
      const params = new Float32Array(44)
      params[0] = params[1] = 1 + 2 ** -23
      params[14] = sample.peak
      const target = { mode: 'hdr' as const, peak: sample.peak, colorSpace: sample.colorSpace }
      const packed = packAces(prepareDisplayRendering(target))
      device.queue.writeTexture({ texture }, source, { bytesPerRow: 16 }, [1, 1])
      device.queue.writeBuffer(uniform, 0, params)
      device.queue.writeBuffer(tables, 0, packed)
      const baseline = await dispatch(direct.pipeline, direct.group)
      const observed = await dispatch(trace.pipeline, trace.group)
      await retain(
        `${sample.name}-source`,
        `${sample.name}-input.f32`,
        new Uint8Array(source.buffer),
      )
      await retain(
        `${sample.name}-uniforms`,
        `${sample.name}-uniforms.f32`,
        new Uint8Array(params.buffer),
      )
      await retain(
        `${sample.name}-tables`,
        `${sample.name}-tables.f32`,
        new Uint8Array(packed.buffer),
      )
      await retain(
        `${sample.name}-direct`,
        `${sample.name}-direct.f32`,
        new Uint8Array(baseline.buffer, 0, 16),
      )
      await retain(
        `${sample.name}-trace`,
        `${sample.name}-trace.f32`,
        new Uint8Array(observed.buffer),
      )
      const rows = stageNames.map((_, index) =>
        Array.from(observed.slice(index * 4, index * 4 + 4)),
      )
      const independent = referenceAces(
        reference.originalBinary,
        [sample.source],
        sample.peak,
        sample.colorSpace,
      )[0]
      const baseRequest: StageRequest = {
        source: sample.source,
        peak: sample.peak,
        colorSpace: sample.colorSpace,
      }
      const requests: StageRequest[] = [
        baseRequest,
        ...Array.from({ length: 9 }, (_, index) => ({
          ...baseRequest,
          seedStage: index + 1,
          injected: rows[index + 1].slice(0, 3),
          jmh: rows[4].slice(0, 3),
        })),
      ]
      const cpuStages = await canonicalReferenceStages(
        reference.binary,
        requests,
        directory,
        sample.name,
      )
      const sameWords = (row: number) => {
        const a = new Uint32Array(baseline.buffer, 0, 4)
        const b = new Uint32Array(observed.buffer, row * 16, 4)
        return a.every((value, index) => value === b[index])
      }
      const products = [
        productCheck(rows[19], rows[20], rows[27][0]),
        productCheck(rows[23], rows[24], rows[27][1]),
      ]
      const sums = [sumCheck(rows[21], rows[22]), sumCheck(rows[23], rows[25])]
      const channelErrors = error(Array.from(baseline.slice(0, 3)), independent)
      const check = {
        name: sample.name,
        ratio: Math.max(...channelErrors.map((value) => value.ratio)),
        alpha: baseline[3],
        expectedAlpha: sample.alpha,
        directMatchesTrace: sameWords(11),
        decompositionMatchesDirect: sameWords(10),
        nonfiniteValues: Array.from(observed).filter((value) => !Number.isFinite(value)).length,
        products,
        sums,
      }
      checks.push(check)
      measurements.push({
        ...sample,
        target,
        direct: Array.from(baseline.slice(0, 4)),
        independent,
        channelErrors,
        originalCanonicalRedReproduced: baseline[0] === sample.originalCanonicalRed,
        ...check,
        sameInputHueAndMagnitude: {
          gpuAab: rows[3].slice(0, 3),
          gpu: rows[14].slice(0, 3),
          independent: cpuStages[3][14],
          difference: rows[14].slice(0, 3).map((value, c) => value - cpuStages[3][14][c]),
          degreeHiLo: rows[16].slice(0, 2),
        },
        sameInputPower: {
          gpu: rows[15].slice(0, 3),
          independent: cpuStages[3][15],
          difference: rows[15].slice(0, 3).map((value, c) => value - cpuStages[3][15][c]),
          powerHiLo: rows[17].slice(0, 2),
        },
        stages: rows.map((actual, index) => ({
          stage: stageNames[index],
          actual,
          independent: cpuStages[0][index] ?? null,
          difference: cpuStages[0][index]
            ? actual.slice(0, 3).map((value, c) => value - cpuStages[0][index][c])
            : null,
        })),
        independentDirectAgreement: error(cpuStages[0][11], independent),
        boundaryReplays: requests.slice(1).map((request, index) => ({
          seedStage: canonicalStageNames[request.seedStage!],
          inputs: request.injected,
          jmh: request.jmh,
          nextStage: canonicalStageNames[request.seedStage! + 1],
          nextStageGpuMinusSameInputIndependent: rows[request.seedStage! + 1]
            .slice(0, 3)
            .map((value, c) => value - cpuStages[index + 1][request.seedStage! + 1][c]),
          finalErrorWithGpuBoundary: error(cpuStages[index + 1][10], independent),
          independentStages: cpuStages[index + 1],
        })),
      })
    }
    // This exact source-mip texel independently exposed the rounded 360-degree seam.
    // It supplements the original vectors; it does not replace their assertions.
    const nearAxisSource = [0.09276142716407776, 0.08111721277236938, 0.08499575406312943]
    for (const target of [
      { mode: 'sdr' as const, peak: 1, colorSpace: 'srgb' as const },
      { mode: 'hdr' as const, peak: 4, colorSpace: 'display-p3' as const },
      { mode: 'hdr' as const, peak: 10, colorSpace: 'rec2020' as const },
    ]) {
      const name = `near-axis-${target.peak}-${target.colorSpace}`
      const source = new Float32Array([...nearAxisSource, 1])
      const params = new Float32Array(44)
      params[14] = target.peak
      const packed = packAces(prepareDisplayRendering(target))
      device.queue.writeTexture({ texture }, source, { bytesPerRow: 16 }, [1, 1])
      device.queue.writeBuffer(uniform, 0, params)
      device.queue.writeBuffer(tables, 0, packed)
      const baseline = await dispatch(direct.pipeline, direct.group)
      const observed = await dispatch(trace.pipeline, trace.group)
      const rows = stageNames.map((_, index) =>
        Array.from(observed.slice(index * 4, index * 4 + 4)),
      )
      const independent = referenceAces(
        reference.originalBinary,
        [nearAxisSource],
        target.peak,
        target.colorSpace,
      )[0]
      const channelErrors = error(Array.from(baseline.slice(0, 3)), independent)
      const sameWords = (row: number) => {
        const a = new Uint32Array(baseline.buffer, 0, 4)
        const b = new Uint32Array(observed.buffer, row * 16, 4)
        return a.every((value, index) => value === b[index])
      }
      const check = {
        name,
        ratio: Math.max(...channelErrors.map((value) => value.ratio)),
        hue: rows[4][2],
        traceMatchesDirect: sameWords(11),
        decompositionMatchesDirect: sameWords(10),
        finite: Array.from(observed).every(Number.isFinite),
      }
      nearAxisChecks.push(check)
      nearAxisMeasurements.push({
        ...check,
        source: nearAxisSource,
        sourceOrigin:
          'Exact contributor 2 of the retained deer Fit source mip; numerical regression vector, not a photographic acceptance substitute.',
        target,
        direct: Array.from(baseline.slice(0, 4)),
        independent,
        channelErrors,
        stages: rows.map((actual, index) => ({ stage: stageNames[index], actual })),
      })
      for (const [label, bytes] of [
        ['input', source],
        ['uniforms', params],
        ['tables', packed],
        ['direct', baseline],
        ['trace', observed],
      ] as const)
        await retain(`${name}-${label}`, `${name}-${label}.f32`, new Uint8Array(bytes.buffer))
    }
  } finally {
    try {
      await writeFile(
        join(directory, 'diagnostic.json'),
        JSON.stringify(
          {
            scope:
              'The two original Linux canonical HDR misses plus one exact near-axis source texel across three SDR/HDR targets; numerical diagnostic, no physical-display claim. Candidate versions and existing final-output limits are unchanged.',
            renderingVersion: DISPLAY_RENDERING_VERSION,
            canonicalShaderSha256: sha(acesWgsl),
            sourceHashes,
            adapter: {
              vendor: adapter!.info.vendor,
              architecture: adapter!.info.architecture,
              device: adapter!.info.device,
              description: adapter!.info.description,
              isFallbackAdapter: adapter!.info.isFallbackAdapter,
            },
            node: process.versions.node,
            platform: process.platform,
            reference: reference.provenance,
            stages: stageNames,
            selectedVectorCount: cases.length,
            measuredVectorCount: measurements.length,
            selectedTargetCount: cases.length,
            fullMatrixVerified: false,
            files,
            measurements,
            nearAxisMeasurements,
            nearAxisSelectedTargetCount: 3,
            nearAxisMeasuredTargetCount: nearAxisMeasurements.length,
            errors,
            numericalLimit:
              'Existing final-output bound: 2e-6 + 2e-5 * abs(independent Float64 CTL). Intermediate deltas are diagnostic, not newly approved tolerances.',
            compensationPremise:
              'Portable integer product residuals must reconstruct the expected residual. Raw WGSL fma results remain capability evidence and are not required to be fused.',
            traceFidelity:
              'Both traced direct output and explicit decomposition must match the separate unchanged full-output kernel bit-for-bit before attributing intermediate error.',
          },
          null,
          2,
        ) + '\n',
      )
    } finally {
      for (const resource of resources) resource.destroy()
      device.destroy()
      retainedGpu = undefined
    }
  }
  expect(errors).toEqual([])
  for (const check of nearAxisChecks) {
    expect.soft(check.traceMatchesDirect, `${check.name}: trace fidelity`).toBe(true)
    expect
      .soft(check.decompositionMatchesDirect, `${check.name}: decomposition fidelity`)
      .toBe(true)
    expect.soft(check.finite, `${check.name}: finite stages`).toBe(true)
    expect.soft(check.hue, `${check.name}: hue lower bound`).toBeGreaterThanOrEqual(0)
    expect.soft(check.hue, `${check.name}: hue upper bound`).toBeLessThan(360)
    expect
      .soft(check.ratio, `${check.name}: unchanged independent canonical bound`)
      .toBeLessThanOrEqual(1)
  }
  for (const check of checks) {
    expect.soft(check.directMatchesTrace, `${check.name}: trace fidelity`).toBe(true)
    expect
      .soft(check.decompositionMatchesDirect, `${check.name}: decomposition fidelity`)
      .toBe(true)
    expect.soft(check.alpha, `${check.name}: unchanged alpha`).toBe(check.expectedAlpha)
    expect.soft(check.nonfiniteValues, `${check.name}: finite stages`).toBe(0)
    expect.soft(check.ratio, `${check.name}: independent canonical bound`).toBeLessThanOrEqual(1)
    for (const [index, product] of check.products.entries()) {
      expect
        .soft(product.actual[0], `${check.name}: product ${index} rounding`)
        .toBe(product.expectedRounded)
      expect
        .soft(product.portableResidual, `${check.name}: product ${index} portable residual`)
        .toBe(product.expectedFusedResidual)
    }
    expect
      .soft(check.products[1].actual[2], `${check.name}: synthetic dsMul high`)
      .toBe(check.products[1].expectedRounded)
    expect
      .soft(check.products[1].actual[3], `${check.name}: synthetic dsMul low`)
      .toBe(check.products[1].expectedFusedResidual)
    for (const [index, sum] of check.sums.entries()) {
      expect.soft(sum.actual[0], `${check.name}: sum ${index} high`).toBe(sum.expectedHigh)
      expect.soft(sum.actual[1], `${check.name}: sum ${index} low`).toBe(sum.expectedLow)
    }
  }
})
