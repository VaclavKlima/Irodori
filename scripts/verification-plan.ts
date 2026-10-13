export const scopes = ['ui', 'adjustments', 'preview', 'library', 'mcp'] as const
export type Scope = (typeof scopes)[number]
export type Group = 'node' | 'service' | 'electron' | 'raw-gpu' | 'benchmark'
export type Phase = 'functional' | 'benchmark'
export type BenchmarkFamily = 'preview' | 'adjustments' | 'hdr' | 'merge'

// Every spec belongs to exactly one execution group. Scope membership is explicit;
// selecting several scopes runs their union, independent of the working tree.
interface Suite {
  file: string
  group: Group
  scopes: Scope[]
  exclusive?: boolean
  family?: BenchmarkFamily
}
const definitions: Suite[] = [
  { file: 'work-scheduler', group: 'node', scopes: ['library', 'preview'] },
  { file: 'import-pipeline', group: 'service', scopes: ['library'] },
  { file: 'import-preparation-raw', group: 'raw-gpu', scopes: ['library'] },
  {
    file: 'import-foreground-ui',
    group: 'electron',
    scopes: ['library', 'ui', 'preview'],
    exclusive: true,
  },
  { file: 'import-performance', group: 'service', scopes: [], exclusive: true },
  { file: 'device-discovery', group: 'node', scopes: ['library'] },
  { file: 'device-directory-visibility', group: 'node', scopes: ['library'] },
  { file: 'device-service', group: 'service', scopes: ['library'] },
  { file: 'device-ui', group: 'electron', scopes: ['library', 'ui'] },
  { file: 'import-source-records', group: 'node', scopes: ['library'] },
  { file: 'camera-recognition', group: 'node', scopes: ['library'] },
  { file: 'camera-import', group: 'service', scopes: ['library'] },
  { file: 'camera-review-ui', group: 'electron', scopes: ['library', 'ui'], exclusive: true },
  { file: 'camera-import-performance', group: 'service', scopes: [], exclusive: true },
  { file: 'import-missing', group: 'service', scopes: ['library'] },
  { file: 'import-missing-ui', group: 'electron', scopes: ['library', 'ui'] },
  { file: 'progressive-review', group: 'service', scopes: ['library'] },
  { file: 'progressive-review-ui', group: 'electron', scopes: ['library', 'ui'] },
  { file: 'raw-thumbnail', group: 'raw-gpu', scopes: ['library'] },
  { file: 'review-performance', group: 'service', scopes: [], exclusive: true },
  { file: 'stack-model', group: 'node', scopes: ['library'] },
  { file: 'photo-menu-model', group: 'node', scopes: ['library', 'ui'] },
  { file: 'photo-menu-context', group: 'service', scopes: ['library', 'mcp'] },
  { file: 'photo-menu-ui', group: 'electron', scopes: ['library', 'ui', 'mcp'] },
  { file: 'all-photos-model', group: 'node', scopes: ['library'] },
  { file: 'all-photos', group: 'service', scopes: ['library'] },
  { file: 'catalog-migration', group: 'service', scopes: ['library'] },
  { file: 'capture-sequence', group: 'node', scopes: ['library'] },
  { file: 'brk-capture', group: 'node', scopes: ['library'] },
  { file: 'brk-library', group: 'service', scopes: ['library'] },
  { file: 'brk-merge', group: 'service', scopes: ['library', 'preview'] },
  { file: 'brk-raw', group: 'raw-gpu', scopes: ['library', 'preview'] },
  { file: 'brk-ui', group: 'raw-gpu', scopes: ['library', 'ui', 'mcp'] },
  { file: 'stack-library', group: 'service', scopes: ['library'] },
  { file: 'stack-range-selection', group: 'service', scopes: ['library'] },
  { file: 'stack-group-actions', group: 'service', scopes: ['library'] },
  { file: 'capture-metadata', group: 'service', scopes: ['library'] },
  { file: 'stack-ui', group: 'electron', scopes: ['library', 'ui', 'mcp'] },
  { file: 'stack-range-selection-ui', group: 'electron', scopes: ['library', 'ui', 'mcp'] },
  { file: 'stack-group-actions-ui', group: 'electron', scopes: ['library', 'ui', 'mcp'] },
  { file: 'merge-raw-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'library', 'mcp'] },
  { file: 'merge-ui', group: 'electron', scopes: ['ui', 'library', 'mcp'] },
  // Pointer-lock interaction owns the desktop cursor and must run in one window at a time.
  {
    file: 'merge-preview-ui',
    group: 'electron',
    scopes: ['ui', 'preview', 'library'],
    exclusive: true,
  },
  { file: 'merge-preview-benchmark', group: 'benchmark', scopes: [], family: 'merge' },
  { file: 'merge-library', group: 'service', scopes: ['library', 'adjustments', 'preview'] },
  { file: 'merge-raw', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-gpu', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-photographs', group: 'service', scopes: ['preview', 'library'] },
  { file: 'merge', group: 'node', scopes: ['preview', 'library'] },
  { file: 'merge-engine', group: 'service', scopes: ['preview', 'library'] },
  { file: 'hdr', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-content', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-content-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-content-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'adjustments'] },
  { file: 'hdr-slider-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'hdr-render-cache', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-render-cache-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-interaction-ui', group: 'raw-gpu', scopes: ['ui', 'preview'] },
  { file: 'display-rendering', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'display-rendering-reference', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-assets', group: 'service', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-pixel', group: 'service', scopes: ['preview', 'mcp'] },
  { file: 'hdr-migration', group: 'service', scopes: ['library', 'adjustments'] },
  { file: 'hdr-math-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-raw', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-editor-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'adjustments', 'mcp'] },
  { file: 'hdr-interaction-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'hdr-display', group: 'node', scopes: ['preview'] },
  { file: 'wayland-display', group: 'node', scopes: ['ui', 'preview'] },
  { file: 'pan-drag', group: 'node', scopes: ['ui', 'preview'] },
  { file: 'hdr-diagnostic-ui', group: 'electron', scopes: ['ui', 'preview'] },
  ...['white-balance', 'statistics', 'contrast', 'highlights', 'tonal-adjustments', 'edits'].map(
    (file) => ({
      file,
      group: 'node' as const,
      scopes: ['adjustments'] as Scope[],
    }),
  ),
  ...['frame-cache', 'preview-geometry', 'lens-correction'].map((file) => ({
    file,
    group: 'node' as const,
    scopes: ['preview'] as Scope[],
  })),
  { file: 'verification', group: 'node', scopes: ['mcp'] },
  ...[
    'white-balance-migration',
    'contrast-migration',
    'highlights-migration',
    'tonal-migration',
    'edit-history',
  ].map((file) => ({
    file,
    group: 'service' as const,
    scopes: ['adjustments', 'library'] as Scope[],
  })),
  { file: 'adjustment-engine', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'full-previews', group: 'service', scopes: ['preview', 'adjustments'] },
  ...['library', 'deletion'].map((file) => ({
    file,
    group: 'service' as const,
    scopes: ['library'] as Scope[],
  })),
  { file: 'white-balance-ui', group: 'raw-gpu', scopes: ['ui', 'adjustments'] },
  { file: 'comparison-ui', group: 'electron', scopes: ['ui', 'preview'] },
  { file: 'white-balance-raw', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'workspace', group: 'electron', scopes: ['ui'] },
  { file: 'all-photos-ui', group: 'electron', scopes: ['library', 'ui'], exclusive: true },
  ...['adjustment-input-decimal', 'adjustment-input-integer', 'adjustment-wiring'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['ui', 'adjustments'] as Scope[],
  })),
  { file: 'adjustment-history-ui', group: 'electron', scopes: ['adjustments'] },
  { file: 'adjustment-history-raw-ui', group: 'raw-gpu', scopes: ['adjustments'] },
  { file: 'adjustment-renderer-ui', group: 'electron', scopes: ['adjustments', 'preview'] },
  ...['preview', 'preview-pixels-ui'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['ui', 'preview'] as Scope[],
    exclusive: file === 'preview',
  })),
  { file: 'full-preview-ui', group: 'electron', scopes: ['preview'] },
  { file: 'lens-ui', group: 'electron', scopes: ['adjustments'] },
  ...['import', 'background-import', 'photo-actions'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['library'] as Scope[],
  })),
  { file: 'editor-mcp', group: 'electron', scopes: ['mcp', 'adjustments'] },
  { file: 'editor-mcp-raw', group: 'raw-gpu', scopes: ['mcp', 'adjustments'] },
  ...[
    'adjustment-engine-raw',
    'adjustment-renderer-raw-ui',
    'lens-raw-ui',
    'lens-correction-raw',
    'gpu-preview',
  ].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['adjustments', 'preview'] as Scope[],
  })),
  ...['full-previews-raw', 'full-preview-raw-ui'].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['preview'] as Scope[],
  })),
  ...['library-raw', 'import-raw'].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['library'] as Scope[],
  })),
  ...(['preview', 'adjustments', 'hdr', 'merge'] as BenchmarkFamily[]).map((family) => ({
    file: `${family === 'adjustments' ? 'adjustment' : family}-benchmark`,
    group: 'benchmark' as const,
    scopes: [] as Scope[],
    family,
  })),
]
export const suites = definitions.map((suite) => ({
  ...suite,
  target: suite.file,
  file: `tests/${suite.file}.spec.ts`,
}))
export const isolatedMcp = {
  target: 'mcp-import',
  file: 'scripts/check-mcp.mjs',
  group: 'mcp' as const,
}
export const registry = [...suites, isolatedMcp]
export const targets = registry.map((suite) => suite.target)

export function workersFor(group: Group, exclusive = false): number {
  return !exclusive && ['node', 'service', 'electron'].includes(group) ? 2 : 1
}

export interface ExecutionGroup {
  name: Group
  stage: string
  phase: Phase
  directory: string
  workers: number
  targets: string[]
  files: string[]
}

export interface VerificationPlan {
  label: string
  targets: string[]
  requestedTargets: string[]
  staticChecks: boolean
  build: boolean
  mcp: boolean
  benchmark: boolean
  comprehensive: boolean
  continueOnFailure: boolean
  routine: boolean
  grep?: string
  groups: ExecutionGroup[]
}

export function selectPlan(args: string[]): VerificationPlan {
  const requested = args.filter((arg) => arg !== '--plan')
  const mode = requested[0]
  const internal = ['--fast', '--full', '--all', '--functional', '--mcp', '--editor']
  const families: Record<string, BenchmarkFamily[]> = {
    '--benchmark': ['preview'],
    '--hdr-benchmark': ['hdr'],
    '--merge-benchmark': ['merge'],
    '--benchmark-all': ['preview', 'adjustments', 'hdr', 'merge'],
  }
  let selected: typeof suites
  let mcp = false
  let staticChecks = true
  let grep: string | undefined
  let requestedTargets: string[] = []
  if (mode === '--target') {
    for (let index = 0; index < requested.length; index += 2) {
      const target = requested[index + 1]
      if (requested[index] !== '--target' || !target || !targets.includes(target))
        throw new Error(
          `Unknown or missing target: ${target ?? '(missing)'}. Targets: ${targets.join(', ')}.`,
        )
      requestedTargets.push(target)
    }
    requestedTargets = [...new Set(requestedTargets)]
    selected = suites.filter((s) => s.group === 'node' || requestedTargets.includes(s.target))
    mcp = requestedTargets.includes(isolatedMcp.target)
  } else if (mode === '--adjustment-benchmark') {
    if (
      requested.length !== 2 ||
      ![
        'exposure',
        'contrast',
        'highlights',
        'shadows',
        'whites',
        'blacks',
        'temperature',
      ].includes(requested[1])
    )
      throw new Error(
        'Choose one adjustment: exposure, contrast, highlights, shadows, whites, blacks, or temperature.',
      )
    selected = suites.filter((s) => s.file === 'tests/adjustment-benchmark.spec.ts')
    grep = `warmed RAW ${requested[1]} gestures`
    staticChecks = false
  } else if (families[mode]) {
    if (requested.length !== 1) throw new Error(`${mode} does not accept scopes or targets.`)
    selected = suites.filter((s) => s.family && families[mode].includes(s.family))
    staticChecks = false
  } else if (internal.includes(mode)) {
    if (requested.length !== 1) throw new Error(`${mode} does not accept scopes.`)
    mcp = mode === '--full' || mode === '--all' || mode === '--mcp'
    staticChecks = mode === '--fast' || mode === '--full' || mode === '--all'
    selected = suites.filter((s) =>
      mode === '--fast'
        ? s.group === 'node'
        : mode === '--mcp'
          ? false
          : mode === '--editor'
            ? ['editor-mcp', 'editor-mcp-raw'].includes(s.target)
            : mode === '--all' || s.group !== 'benchmark',
    )
  } else {
    if (!requested.length || requested.some((scope) => !scopes.includes(scope as Scope)))
      throw new Error(
        `Choose scopes: ${scopes.join(', ')} or --target <id>. Use --plan to preview selection.`,
      )
    selected = suites.filter(
      (s) => s.group === 'node' || s.scopes.some((scope) => requested.includes(scope)),
    )
    mcp = requested.includes('mcp')
  }
  const groups: ExecutionGroup[] = []
  const add = (
    name: Group,
    members: typeof suites,
    stage: string,
    phase: Phase,
    directory: string,
    exclusive = false,
  ) => {
    if (!members.length) return
    groups.push({
      name,
      stage,
      phase,
      directory,
      workers: workersFor(name, exclusive),
      targets: members.map((s) => s.target).sort(),
      files: members.map((s) => s.file).sort(),
    })
  }
  for (const name of ['node', 'service', 'electron', 'raw-gpu'] as Group[]) {
    add(
      name,
      selected.filter((s) => s.group === name && !s.exclusive),
      name,
      'functional',
      `functional/${name}`,
    )
    add(
      name,
      selected.filter((s) => s.group === name && s.exclusive),
      `${name}-exclusive`,
      'functional',
      `functional/${name}-exclusive`,
      true,
    )
  }
  for (const family of ['preview', 'adjustments', 'hdr', 'merge'] as BenchmarkFamily[])
    add(
      'benchmark',
      selected.filter((s) => s.family === family),
      `benchmark-${family}`,
      'benchmark',
      `benchmarks/${family}`,
    )
  const benchmark = groups.some((group) => group.phase === 'benchmark')
  return {
    label: [...new Set(requested)].sort().join('+'),
    targets: [
      ...selected.map((suite) => suite.target).sort(),
      ...(mcp ? [isolatedMcp.target] : []),
    ],
    requestedTargets,
    staticChecks,
    // Library service tests also exercise the bundled preview worker.
    build: mcp || groups.some((group) => group.name !== 'node'),
    mcp,
    benchmark,
    comprehensive: mode === '--all',
    continueOnFailure: ['--full', '--all', '--benchmark-all'].includes(mode),
    routine: mode === '--fast' || mode === '--target',
    grep,
    groups,
  }
}
