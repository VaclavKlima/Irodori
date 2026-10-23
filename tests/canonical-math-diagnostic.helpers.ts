import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const canonicalStageNames = [
  'source-rec2020',
  'input-aces',
  'clamped-ap0',
  'input-aab',
  'input-jmh',
  'tone-scalars-linearY-toneY-J',
  'toned-jmh',
  'gamut-jmh',
  'output-aab',
  'output-rgb',
  'clipped-rgb',
  'direct-clipped-rgb',
  'gamut-cusp-J-M-gammaTop',
  'gamut-gammaBottom-focusJ-threshold',
  'input-hue-radians-degrees-magnitude',
  'input-J-power-base-exponent-result',
] as const

export interface StageRequest {
  source: readonly number[]
  peak: number
  colorSpace: 'display-p3' | 'rec2020'
  seedStage?: number
  injected?: readonly number[]
  jmh?: readonly number[]
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const timeout = 120_000
const maxBuffer = 4 * 1024 ** 2
const pinnedRevision = '069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80'
const mainAnchor = Buffer.from('\nint main() {')
const compilerFlags = ['-std=c++17', '-Wno-c++11-narrowing', '-O2']

// Only the CLI changes. Every translated Float64 CTL declaration is retained
// byte for byte from the unchanged independent reference generator.
const stageMain = String.raw`
int main() {
 double peak,r,g,b,sx,sy,sz,jx,jy,jz; int gamut,seed;
 double previous=-1; int previousGamut=-1; ODTParams p{};
 const Chromaticities rec2020{{.708,.292},{.17,.797},{.131,.046},{.3127,.329}};
 const M input_matrix=mult_f33_f33(RGBtoXYZ_f33(rec2020,1.),mult_f33_f33(calculate_cat_matrix(rec2020.white,AP0.white),AP0_XYZ_TO_RGB));
 while(std::cin>>peak>>gamut>>r>>g>>b>>seed>>sx>>sy>>sz>>jx>>jy>>jz) {
  if(peak!=previous||gamut!=previousGamut) {
   Chromaticities pri=gamut==2?rec2020:gamut==1?Chromaticities{{.68,.32},{.265,.69},{.15,.06},{.3127,.329}}:Chromaticities{{.64,.33},{.3,.6},{.15,.06},{.3127,.329}};
   p=init_ODTParams(peak,pri); previous=peak; previousGamut=gamut;
  }
  const V injected{sx,sy,sz}; std::array<V,16> s{};
  s[0]={r,g,b}; s[1]=mult_f3_f33(s[0],input_matrix); if(seed==1)s[1]=injected;
  s[2]=clamp_AP0_to_AP1(s[1],0.,p.ts.forward_limit); if(seed==2)s[2]=injected;
  s[3]=RGB_to_Aab(s[2],p.input_params); if(seed==3)s[3]=injected;
  s[4]=Aab_to_JMh(s[3],p.input_params); if(seed==4)s[4]=injected;
  // Chroma compression also consumes the original JMh at the tone boundary.
  if(seed==5)s[4]={jx,jy,jz};
  const double linear=J_to_Y(s[4][0],p.input_params)/ref_luminance;
  const double toneY=tonescale_fwd(linear,p.ts);
  s[5]={linear,toneY,Y_to_J(toneY,p.input_params)}; if(seed==5)s[5]=injected;
  s[6]=chroma_compress_fwd(s[4],s[5][2],p,false); if(seed==6)s[6]=injected;
  s[7]=gamut_compress_fwd(s[6],p); if(seed==7)s[7]=injected;
  s[8]=JMh_to_Aab(s[7],p.limit_params); if(seed==8)s[8]=injected;
  s[9]=Aab_to_RGB(s[8],p.limit_params); if(seed==9)s[9]=injected;
  const auto direct=outputTransform_fwd(mult_f3_f33(s[0],input_matrix),p);
  for(int c=0;c<3;c++){s[10][c]=ctl_max(0.,ctl_min(peak/100.,s[9][c]));s[11][c]=ctl_max(0.,ctl_min(peak/100.,direct[c]));}
  const auto hdp=init_HueDependentGamutParams(s[6][2],p);
  s[12]={hdp.JMcusp[0],hdp.JMcusp[1],hdp.gamma_top_inv};
  s[13]={hdp.gamma_bottom_inv,hdp.focus_J,hdp.analytical_threshold};
  const double input_hue=atan2(s[3][2],s[3][1]);
  s[14]={input_hue,radians_to_degrees(input_hue),sqrt(s[3][1]*s[3][1]+s[3][2]*s[3][2])};
  s[15]={s[3][0],p.input_params.cz,pow(s[3][0],p.input_params.cz)};
  bool first=true;for(const auto &v:s)for(double x:v){if(!first)std::cout<<' ';std::cout<<std::setprecision(17)<<x;first=false;}std::cout<<'\n';
 }
}
`

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

async function retainedFile(path: string) {
  const bytes = await readFile(path)
  return { path, byteLength: bytes.byteLength, sha256: sha256(bytes) }
}

async function command(
  executable: string,
  args: readonly string[],
  directory: string,
  label: string,
  input?: string,
) {
  const started = performance.now()
  const result = spawnSync(executable, [...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer,
    input,
    windowsHide: true,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const paths = {
    command: join(directory, `${label}.command.json`),
    stdout: join(directory, `${label}.stdout.txt`),
    stderr: join(directory, `${label}.stderr.txt`),
  }
  await Promise.all([
    writeFile(paths.stdout, stdout),
    writeFile(paths.stderr, stderr),
    writeFile(
      paths.command,
      JSON.stringify(
        {
          executable,
          args,
          cwd: root,
          timeout,
          maxBuffer,
          status: result.status,
          signal: result.signal,
          error: result.error ? String(result.error) : null,
          durationMs: performance.now() - started,
          inputBytes: input === undefined ? 0 : Buffer.byteLength(input),
          stdout: { path: paths.stdout, sha256: sha256(stdout) },
          stderr: { path: paths.stderr, sha256: sha256(stderr) },
        },
        null,
        2,
      ) + '\n',
    ),
  ])
  if (result.error || result.status !== 0)
    throw new Error(
      `Canonical reference command failed (${label}): ${result.error ?? result.signal ?? result.status}; evidence: ${paths.command}`,
    )
  return { stdout, stderr, paths }
}

export async function buildCanonicalStageReference(directory: string): Promise<{
  binary: string
  originalBinary: string
  provenance: Record<string, unknown>
}> {
  directory = resolve(directory)
  await mkdir(directory, { recursive: true })
  const originalCpp = join(directory, 'aces-reference.cpp')
  const originalBinary = join(directory, 'aces-reference')
  const stageCpp = join(directory, 'canonical-stage-reference.cpp')
  const binary = join(directory, 'canonical-stage-reference')
  const declarationsPath = join(directory, 'canonical-reference-declarations.cpp')
  const recipePath = join(root, 'tests/aces-reference.ts')
  const compiler = process.env.CXX ?? 'clang++'
  const originalArgs = [...compilerFlags, originalCpp, '-o', originalBinary]
  const stageArgs = [...compilerFlags, stageCpp, '-o', binary]
  // The original builder has no timeout. Bound its unchanged invocation in a
  // separate Node process rather than copying or editing the reference recipe.
  const originalBuildScript = [
    `import { buildAcesReference } from ${JSON.stringify(pathToFileURL(recipePath).href)};`,
    'const binary = buildAcesReference(process.argv[1]);',
    'process.stdout.write(binary + "\\n");',
  ].join('\n')
  const originalBuild = await command(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', originalBuildScript, directory],
    directory,
    'canonical-original-build',
  )
  if (originalBuild.stdout.trim() !== originalBinary)
    throw new Error(`Unexpected original reference binary path: ${originalBuild.stdout.trim()}`)
  const original = await readFile(originalCpp)
  const mainOffset = original.indexOf(mainAnchor)
  if (mainOffset < 0 || original.indexOf(mainAnchor, mainOffset + mainAnchor.length) !== -1)
    throw new Error('Independent reference adapter must contain exactly one CLI main anchor.')
  const declarations = original.subarray(0, mainOffset)
  const stageSource = Buffer.concat([declarations, Buffer.from(stageMain)])
  if (!stageSource.subarray(0, declarations.length).equals(declarations))
    throw new Error('Independent CTL declarations changed while adding stage CLI.')
  await Promise.all([writeFile(declarationsPath, declarations), writeFile(stageCpp, stageSource)])
  const stageBuild = await command(compiler, stageArgs, directory, 'canonical-stage-build')
  const compilerVersion = await command(
    compiler,
    ['--version'],
    directory,
    'canonical-compiler-version',
  )
  const sourcePaths = [
    'scripts/aces-reference.py',
    'tests/aces-reference.ts',
    'tests/canonical-math-diagnostic.helpers.ts',
    'third_party/aces-core/README.md',
    'third_party/aces-core/LICENSE',
    'third_party/aces-core/lib/Lib.Academy.Utilities.ctl',
    'third_party/aces-core/lib/Lib.Academy.Tonescale.ctl',
    'third_party/aces-core/lib/Lib.Academy.OutputTransform.ctl',
    'third_party/aces-core/lib/Lib.Academy.ColorSpaces.ctl',
  ]
  const sources = await Promise.all(
    sourcePaths.map(async (path) => ({
      ...(await retainedFile(join(root, path))),
      sourcePath: path,
    })),
  )
  const provenance: Record<string, unknown> = {
    pinnedRevision,
    independence:
      'Unchanged pinned CTL and original Float64 adapter recipe; CLI main only replaced.',
    stageNames: canonicalStageNames,
    mainAnchor: mainAnchor.toString(),
    mainAnchorCount: 1,
    declarationsRetainedByteIdentically: true,
    originalAdapter: await retainedFile(originalCpp),
    declarations: await retainedFile(declarationsPath),
    stageCpp: await retainedFile(stageCpp),
    originalBinary: await retainedFile(originalBinary),
    stageBinary: await retainedFile(binary),
    compiler: {
      executable: compiler,
      version: compilerVersion.stdout.trim(),
      flags: compilerFlags,
      originalArgs,
      stageArgs,
      originalBuild: originalBuild.paths,
      stageBuild: stageBuild.paths,
      versionEvidence: compilerVersion.paths,
    },
    sources,
  }
  await writeFile(
    join(directory, 'canonical-reference-provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n',
  )
  return { binary, originalBinary, provenance }
}

function triple(value: readonly number[] | undefined, label: string): readonly number[] {
  if (!value || value.length !== 3 || value.some((component) => !Number.isFinite(component)))
    throw new Error(`Canonical stage ${label} must contain exactly three finite numbers.`)
  return value
}

function requestLine(request: StageRequest, index: number) {
  const source = triple(request.source, `request ${index} source`)
  if (!Number.isFinite(request.peak) || request.peak <= 0 || !Number.isFinite(100 * request.peak))
    throw new Error(`Canonical stage request ${index} peak must be finite and positive.`)
  if (request.colorSpace !== 'display-p3' && request.colorSpace !== 'rec2020')
    throw new Error(`Canonical stage request ${index} has an unsupported color space.`)
  const seed = request.seedStage ?? -1
  if (seed !== -1 && (!Number.isInteger(seed) || seed < 1 || seed > 9))
    throw new Error(`Canonical stage request ${index} seed must be -1 or an integer from 1 to 9.`)
  const injected =
    request.injected !== undefined || seed !== -1
      ? triple(request.injected, `request ${index} injected boundary`)
      : [0, 0, 0]
  const jmh =
    request.jmh !== undefined || seed === 5
      ? triple(request.jmh, `request ${index} original JMh`)
      : [0, 0, 0]
  return [
    100 * request.peak,
    request.colorSpace === 'rec2020' ? 2 : 1,
    ...source,
    seed,
    ...injected,
    ...jmh,
  ]
    .map((value) => (Object.is(value, -0) ? '-0' : String(value)))
    .join(' ')
}

export async function canonicalReferenceStages(
  binary: string,
  requests: readonly StageRequest[],
  directory: string,
  label: string,
): Promise<number[][][]> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(label))
    throw new Error(
      'Canonical stage artifact label must be a safe filename of at most 128 characters.',
    )
  directory = resolve(directory)
  await mkdir(directory, { recursive: true })
  const input = requests.map(requestLine).join('\n') + (requests.length ? '\n' : '')
  if (Buffer.byteLength(input) > maxBuffer)
    throw new Error('Canonical stage requests exceed the 4 MiB diagnostic input limit.')
  await Promise.all([
    writeFile(join(directory, `${label}.requests.json`), JSON.stringify(requests, null, 2) + '\n'),
    writeFile(join(directory, `${label}.stdin.txt`), input),
  ])
  const result = await command(resolve(binary), [], directory, label, input)
  const output = result.stdout.trim()
  const lines = output ? output.split(/\r?\n/) : []
  if (lines.length !== requests.length)
    throw new Error(
      `Canonical stage output count mismatch (${label}): expected ${requests.length}, received ${lines.length}; evidence: ${result.paths.stdout}`,
    )
  return lines.map((line, index) => {
    const values = line.trim().split(/\s+/).map(Number)
    if (
      values.length !== canonicalStageNames.length * 3 ||
      values.some((value) => !Number.isFinite(value))
    )
      throw new Error(
        `Invalid canonical stage output (${label}, request ${index}): expected ${canonicalStageNames.length * 3} finite values; evidence: ${result.paths.stdout}`,
      )
    return canonicalStageNames.map((_, stage) => values.slice(stage * 3, stage * 3 + 3))
  })
}
