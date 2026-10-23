/** Frozen ordinary editor policy. Unconfirmed and other platforms retain reference behavior. */
export interface EditorPreviewPolicy {
  readonly interactivePrecision: 'reference' | 'f32'
  readonly presentationCache: boolean
  readonly tileBatch: 32 | 512
  readonly interactiveFence: 'separate' | 'final'
}

const reference: EditorPreviewPolicy = Object.freeze({
  interactivePrecision: 'reference',
  presentationCache: false,
  tileBatch: 32,
  interactiveFence: 'separate',
})

const linux: EditorPreviewPolicy = Object.freeze({
  interactivePrecision: 'f32',
  presentationCache: true,
  tileBatch: 512,
  interactiveFence: 'final',
})

/** AppInfo.platform is authoritative; null never infers a platform from browser hints. */
export function selectEditorPreviewPolicy(platform: string | null): Readonly<EditorPreviewPolicy> {
  return platform === 'linux' ? linux : reference
}
