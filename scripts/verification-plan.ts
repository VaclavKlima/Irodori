import { testUiMode } from './test-ui-mode.mjs'

export const scopes = ['ui', 'adjustments', 'preview', 'library', 'mcp'] as const
export type Scope = (typeof scopes)[number]
export type Group = 'node' | 'service' | 'electron' | 'raw-gpu' | 'benchmark'
export type Phase = 'functional' | 'benchmark'
export type BenchmarkFamily = 'preview' | 'adjustments' | 'hdr' | 'merge' | 'export' | 'research'

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
  { file: 'camera-runtime', group: 'node', scopes: ['mcp'] },
  { file: 'camera-control-model', group: 'node', scopes: ['mcp'] },
  { file: 'camera-control-service', group: 'node', scopes: ['mcp'] },
  { file: 'camera-control-mcp', group: 'node', scopes: ['mcp'] },
  { file: 'camera-acceptance', group: 'node', scopes: ['mcp'] },
  { file: 'edit-transfer-model', group: 'node', scopes: ['adjustments'] },
  { file: 'edit-transfer', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'edit-transfer-journal', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'jpeg-ycbcr-model', group: 'node', scopes: ['adjustments', 'library'] },
  { file: 'jpeg-ycbcr-reference', group: 'service', scopes: ['adjustments', 'library'] },
  {
    file: 'professional-editing-acceptance',
    group: 'raw-gpu',
    scopes: ['adjustments', 'library'],
    exclusive: true,
  },
  {
    file: 'professional-source-agreement',
    group: 'raw-gpu',
    scopes: ['adjustments', 'preview'],
    exclusive: true,
  },
  { file: 'professional-master-agreement', group: 'raw-gpu', scopes: [], exclusive: true },
  {
    file: 'professional-detail-resources',
    group: 'raw-gpu',
    scopes: ['adjustments', 'preview'],
    exclusive: true,
  },
  {
    file: 'edit-transfer-visual',
    group: 'electron',
    scopes: ['adjustments', 'ui'],
    exclusive: true,
  },
  {
    file: 'professional-editor-native',
    group: 'raw-gpu',
    scopes: ['adjustments', 'preview', 'ui'],
    exclusive: true,
  },
  { file: 'edit-transfer-ui', group: 'electron', scopes: ['adjustments', 'library', 'mcp', 'ui'] },
  { file: 'profile-migration', group: 'node', scopes: ['library'] },
  { file: 'app-identity', group: 'node', scopes: ['ui', 'library'] },
  { file: 'spatial-detail', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'strong-noise-reference', group: 'service', scopes: [], exclusive: true },
  { file: 'strong-noise-estimate', group: 'service', scopes: [], exclusive: true },
  { file: 'strong-noise-scaled-reference', group: 'service', scopes: [], exclusive: true },
  { file: 'detail-quality', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'spatial-detail-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'detail-resources', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'spatial-detail-owner', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preparation', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preparation-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'detail-placement', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-frame', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-frame-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preview', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preview-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preview-cache', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-preview-cache-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'prepared-comparison', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'detail-comparison', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'detail-comparison-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'raster-spatial-comparison', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'hdr-comparison-source', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'hdr-spatial-comparison', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'native-cpu-comparison-ui', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'hdr-cpu-comparison-ui', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'detail-application-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  {
    file: 'native-cpu-comparison',
    group: 'service',
    scopes: ['adjustments', 'preview'],
    exclusive: true,
  },
  { file: 'detail-export', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'detail-export-gpu', group: 'raw-gpu', scopes: ['adjustments', 'library'] },
  { file: 'detail-export-cache', group: 'service', scopes: ['adjustments', 'preview', 'library'] },
  {
    file: 'detail-native-source',
    group: 'service',
    scopes: ['adjustments', 'preview'],
    exclusive: true,
  },
  { file: 'export-resources', group: 'node', scopes: ['adjustments', 'library'] },
  { file: 'export-resources-gpu', group: 'raw-gpu', scopes: ['adjustments', 'library'] },
  { file: 'export-resources-encoder', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'export-resources-integration', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'color-intensity', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'color-intensity-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'color-export', group: 'raw-gpu', scopes: ['adjustments', 'library'] },
  { file: 'color-model', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-adapters', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-export', group: 'raw-gpu', scopes: ['adjustments', 'library'] },
  { file: 'creative-color-frame-identity', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-frame-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-native', group: 'service', scopes: ['adjustments', 'preview'] },
  {
    file: 'creative-color-native-frame',
    group: 'service',
    scopes: ['adjustments', 'preview'],
    exclusive: true,
  },
  { file: 'creative-color-webgl', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-presenter', group: 'electron', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-raw-proof', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'adjustment-snapshot', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'creative-color-edits', group: 'node', scopes: ['adjustments', 'mcp'] },
  { file: 'creative-color-history', group: 'service', scopes: ['adjustments', 'mcp', 'library'] },
  { file: 'creative-color-ui', group: 'electron', scopes: ['adjustments', 'mcp', 'ui'] },
  {
    file: 'creative-color-raster',
    group: 'service',
    scopes: ['adjustments', 'library', 'preview'],
  },
  { file: 'tone-curves', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'tone-curves-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'crop-geometry', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'crop-authoring', group: 'node', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'crop-preview-geometry', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'crop-pixels', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'crop-working', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'crop-filter', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'crop-filter-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'crop-resources', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'crop-preparation', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'crop-preparation-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'crop-frame', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'crop-frame-gpu', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'crop-export', group: 'service', scopes: ['adjustments', 'library'] },
  { file: 'crop-preview-cache', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'crop-context', group: 'service', scopes: ['adjustments', 'mcp'] },
  {
    file: 'crop-edit-service',
    group: 'service',
    scopes: ['adjustments', 'preview', 'library', 'mcp'],
  },
  { file: 'crop-working-preview-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'crop-editor-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'crop-application-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'crop-source-preview-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'image-resource-owners', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'image-resource-query-ui', group: 'electron', scopes: ['adjustments', 'preview', 'ui'] },
  { file: 'white-balance-picker', group: 'node', scopes: ['adjustments'] },
  { file: 'white-balance-picker-geometry', group: 'node', scopes: ['adjustments', 'preview'] },
  { file: 'white-balance-picker-service', group: 'service', scopes: ['adjustments', 'mcp'] },
  { file: 'white-balance-picker-ui', group: 'electron', scopes: ['adjustments', 'ui'] },
  { file: 'research-pipeline', group: 'node', scopes: [] },
  { file: 'research-resources', group: 'node', scopes: [] },
  ...[
    'research-native',
    'research-measurements',
    'research-libraries',
    'research-gpu',
    'research-wgpu',
    'research-presentation',
    'research-background',
    'research-merge-gpu',
  ].map((file) => ({
    file,
    group: 'benchmark' as const,
    scopes: [] as Scope[],
    family: 'research' as const,
  })),
  { file: 'export-model', group: 'node', scopes: ['library'] },
  { file: 'export-enlargement-model', group: 'node', scopes: ['library', 'adjustments'] },
  { file: 'export-enlargement-gpu', group: 'raw-gpu', scopes: ['library', 'adjustments'] },
  { file: 'professional-enlargement-fullsize', group: 'raw-gpu', scopes: [], exclusive: true },
  {
    file: 'export-enlargement',
    group: 'service',
    scopes: ['library', 'adjustments'],
    exclusive: true,
  },
  { file: 'export-enlargement-ui', group: 'electron', scopes: ['ui', 'library', 'mcp'] },
  { file: 'export-jpeg', group: 'node', scopes: ['library'] },
  { file: 'export-gpu', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'export-native', group: 'raw-gpu', scopes: ['library'] },
  { file: 'export-native-fullsize', group: 'raw-gpu', scopes: [] },
  { file: 'export-context', group: 'service', scopes: ['library', 'mcp'] },
  { file: 'export-rendering', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'export-ui', group: 'electron', scopes: ['ui', 'library', 'mcp'] },
  { file: 'background-testing-model', group: 'node', scopes: ['ui', 'mcp'] },
  { file: 'background-testing-ui', group: 'electron', scopes: ['ui', 'mcp'] },
  { file: 'continuous-scroll-model', group: 'node', scopes: ['library', 'ui'] },
  { file: 'continuous-scroll-context', group: 'service', scopes: ['library'] },
  { file: 'workspace-recovery', group: 'service', scopes: ['library'] },
  { file: 'continuous-scroll-ui', group: 'electron', scopes: ['library', 'ui'] },
  { file: 'workspace-recovery-ui', group: 'electron', scopes: ['library', 'ui'] },
  { file: 'work-scheduler', group: 'node', scopes: ['library', 'preview'] },
  { file: 'catalog-import-completion', group: 'node', scopes: ['library'] },
  { file: 'catalog-writer', group: 'service', scopes: ['library', 'preview'] },
  { file: 'resource-policy', group: 'node', scopes: ['ui', 'preview', 'library'] },
  { file: 'resource-settings', group: 'node', scopes: ['ui', 'preview', 'library'] },
  { file: 'resource-service', group: 'node', scopes: ['ui', 'preview', 'library'] },
  { file: 'native-raw-executable', group: 'node', scopes: ['preview'] },
  { file: 'native-raw-pipe', group: 'node', scopes: ['preview'] },
  { file: 'native-raw-source', group: 'service', scopes: ['preview'] },
  { file: 'native-raw-preparation', group: 'service', scopes: ['preview'] },
  { file: 'native-raw-owner-lifecycle', group: 'service', scopes: ['preview'], exclusive: true },
  {
    file: 'resource-settings-ui',
    group: 'electron',
    scopes: ['ui', 'preview', 'library'],
    exclusive: true,
  },
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
  { file: 'merge-three-raw-benchmark', group: 'benchmark', scopes: [], family: 'merge' },
  { file: 'merge-workflow-benchmark', group: 'benchmark', scopes: [], family: 'merge' },
  { file: 'merge-library', group: 'service', scopes: ['library', 'adjustments', 'preview'] },
  { file: 'merge-raw', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-gpu', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-gpu-preparation', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-gpu-reference', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-gpu-preparation-native', group: 'raw-gpu', scopes: ['preview', 'library'] },
  { file: 'merge-photographs', group: 'service', scopes: ['preview', 'library'] },
  { file: 'merge', group: 'node', scopes: ['preview', 'library'] },
  { file: 'merge-io', group: 'node', scopes: ['preview', 'library'] },
  { file: 'merge-gpu-output', group: 'node', scopes: ['preview', 'library'] },
  { file: 'merge-cpu-kernels', group: 'node', scopes: ['preview', 'library'] },
  { file: 'merge-engine', group: 'service', scopes: ['preview', 'library'] },
  { file: 'hdr', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-content', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-content-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'canonical-math-diagnostic-gpu', group: 'raw-gpu', scopes: [] },
  { file: 'interactive-preview-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'interactive-preview-quality', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  {
    file: 'interactive-preview-ui',
    group: 'raw-gpu',
    scopes: ['ui', 'preview', 'adjustments'],
  },
  {
    file: 'interactive-preview-lifecycle',
    group: 'raw-gpu',
    scopes: ['ui', 'preview', 'adjustments'],
  },
  { file: 'hdr-presentation-cache', group: 'node', scopes: ['preview'] },
  { file: 'hdr-source-cache', group: 'node', scopes: ['preview'] },
  { file: 'hdr-sample', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'detail-edits', group: 'node', scopes: ['adjustments'] },
  { file: 'detail-history', group: 'service', scopes: ['adjustments'] },
  {
    file: 'detail-edit-export',
    group: 'service',
    scopes: ['adjustments', 'library'],
    exclusive: true,
  },
  { file: 'hdr-first-surface', group: 'node', scopes: ['preview'] },
  { file: 'rgba16-validation', group: 'node', scopes: ['preview'] },
  {
    file: 'hdr-first-surface-orientation-gpu',
    group: 'raw-gpu',
    scopes: ['preview'],
    exclusive: true,
  },
  { file: 'hdr-first-surface-service', group: 'service', scopes: ['preview'] },
  { file: 'preview-process-lifecycle', group: 'service', scopes: ['preview'] },
  { file: 'hdr-first-surface-ui', group: 'raw-gpu', scopes: ['preview', 'ui'], exclusive: true },
  { file: 'native-cpu-pure', group: 'node', scopes: ['preview', 'library'] },
  { file: 'native-hdr-mask-pure', group: 'node', scopes: ['preview'] },
  { file: 'native-hdr-mask-controller', group: 'service', scopes: [], exclusive: true },
  {
    file: 'detail-comparison-mask',
    group: 'service',
    scopes: ['preview', 'adjustments'],
    exclusive: true,
  },
  { file: 'native-hdr-mask-ui', group: 'raw-gpu', scopes: [], exclusive: true },
  { file: 'native-cpu-executable', group: 'node', scopes: ['preview'] },
  { file: 'native-hdr-mask-capability', group: 'service', scopes: [], exclusive: true },
  { file: 'native-cpu-controller', group: 'service', scopes: [], exclusive: true },
  { file: 'native-cpu-preview-ui', group: 'raw-gpu', scopes: [], exclusive: true },
  { file: 'native-hdr-mask-parity', group: 'raw-gpu', scopes: [], exclusive: true },
  { file: 'hdr-readback', group: 'node', scopes: ['preview'] },
  { file: 'hdr-cpu-presenter', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'write-hdr-strip', group: 'node', scopes: ['preview'] },
  { file: 'editor-input-pacing', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'edit-gesture-commit', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-gesture-handoff', group: 'node', scopes: ['preview', 'adjustments'] },
  {
    file: 'hdr-presentation-cache-ui',
    group: 'raw-gpu',
    scopes: ['ui', 'preview'],
  },
  { file: 'hdr-source-cache-ui', group: 'raw-gpu', scopes: ['ui', 'preview'], exclusive: true },
  {
    file: 'hdr-source-cache-admission-ui',
    group: 'raw-gpu',
    scopes: ['ui', 'preview'],
    exclusive: true,
  },
  { file: 'editor-responsiveness-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'editor-responsiveness-interference', group: 'benchmark', scopes: [], family: 'hdr' },
  {
    file: 'editor-navigation-responsiveness-benchmark',
    group: 'benchmark',
    scopes: [],
    family: 'hdr',
  },
  {
    file: 'editor-spatial-responsiveness-benchmark',
    group: 'benchmark',
    scopes: [],
    family: 'hdr',
  },
  { file: 'hdr-content-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'adjustments'] },
  { file: 'hdr-slider-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'mac-workability-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'mac-workability-batching', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'mac-workability-interference', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'hdr-render-cache', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-render-cache-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-interaction-ui', group: 'raw-gpu', scopes: ['ui', 'preview'] },
  { file: 'display-rendering', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'aces-reference-fixture', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'display-rendering-reference', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-assets', group: 'service', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-pixel', group: 'service', scopes: ['preview', 'mcp'] },
  { file: 'hdr-math-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-raw', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-jpeg', group: 'raw-gpu', scopes: ['preview', 'library', 'adjustments'] },
  { file: 'hdr-jpeg-ui', group: 'electron', scopes: ['preview', 'library', 'ui'] },
  { file: 'hdr-editor-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'adjustments', 'mcp'] },
  { file: 'hdr-interaction-benchmark', group: 'benchmark', scopes: [], family: 'hdr' },
  { file: 'hdr-display', group: 'node', scopes: ['preview'] },
  { file: 'wayland-display', group: 'node', scopes: ['ui', 'preview'] },
  { file: 'pan-drag', group: 'node', scopes: ['ui', 'preview'] },
  { file: 'hdr-diagnostic-ui', group: 'electron', scopes: ['ui', 'preview'] },
  { file: 'recovery-color-gpu', group: 'raw-gpu', scopes: [], exclusive: true },
  { file: 'raw-half-recovery-ui', group: 'electron', scopes: [], exclusive: true },
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
  { file: 'edit-history', group: 'service', scopes: ['adjustments', 'library'] },
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
  { file: 'inspector-ui', group: 'electron', scopes: ['ui', 'adjustments'] },
  {
    file: 'adjustment-input-visual',
    group: 'electron',
    scopes: ['ui', 'adjustments'],
    exclusive: true,
  },
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
  ...(['preview', 'adjustments', 'hdr', 'merge', 'export'] as BenchmarkFamily[]).map((family) => ({
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
  uiMode: 'background' | 'foreground'
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
  if (args.includes('--background') && args.includes('--foreground'))
    throw new Error('--background and --foreground are mutually exclusive.')
  const uiMode = testUiMode(
    args.includes('--background')
      ? { IRODORI_TEST_UI_MODE: 'background' }
      : args.includes('--foreground')
        ? { IRODORI_TEST_UI_MODE: 'foreground' }
        : process.env,
  )
  const requested = args.filter((arg) => !['--plan', '--background', '--foreground'].includes(arg))
  const mode = requested[0]
  const internal = ['--fast', '--full', '--all', '--functional', '--mcp', '--editor']
  const families: Record<string, BenchmarkFamily[]> = {
    '--benchmark': ['preview'],
    '--hdr-benchmark': ['hdr'],
    '--merge-benchmark': ['merge'],
    '--export-benchmark': ['export'],
    '--benchmark-all': ['preview', 'adjustments', 'hdr', 'merge', 'export', 'research'],
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
  for (const family of [
    'preview',
    'adjustments',
    'hdr',
    'merge',
    'export',
    'research',
  ] as BenchmarkFamily[])
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
    uiMode,
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
