import { validateHdrAsset } from '../preview/hdr-stream'
import { validateWhiteBalanceProfile } from '../../../shared/white-balance'
import { useEffect, useState, useRef } from 'react'
import type { DisplayPreview } from '../../../shared/contracts'
import { frameByteLength } from '../../../shared/preview-frame'
import type { WorkingFrame } from '../../../shared/adjustments'

export function useWorkingPreview(preview: DisplayPreview | null, presented: boolean) {
  const [working, setWorking] = useState<WorkingFrame | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [generation, setGeneration] = useState(0)
  const prepared = useRef(false)
  const preparedIdentity = useRef('')
  const requiredRevision = useRef(0)
  useEffect(
    () =>
      window.luma.onLibraryEvent((event) => {
        if (event.lensChanged && event.lensChanged.photoId === preview?.photoId) {
          requiredRevision.current = event.lensChanged.revision
          prepared.current = false
          setWorking(null)
          setGeneration((value) => value + 1)
        }
      }),
    [preview?.photoId],
  )
  useEffect(() => {
    if (
      !preview ||
      !presented ||
      (prepared.current &&
        (preview.format !== 'hdr-working' ||
          preparedIdentity.current === `${preview.linear.url}:${preview.linear.sha256}`)) ||
      (preview.settingsRevision ?? 0) < requiredRevision.current
    )
      return
    const abort = new AbortController()
    const token = crypto.randomUUID()
    let cancelled = false
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const result =
              preview.format === 'hdr-working'
                ? preview
                : await window.luma.requestEditingPreview(preview.photoId, token)
            if (cancelled) return
            if (
              result.photoId !== preview.photoId ||
              (result.format !== 'hdr-working' && result.requestId !== token) ||
              (result.settingsRevision ?? 0) < (preview.settingsRevision ?? 0)
            )
              throw new Error('The working preview is stale.')
            const asset = result.linear
            if (
              !asset?.url ||
              asset.byteLength !== frameByteLength(result.width, result.height) * 4 ||
              asset.byteLength > 512 * 1024 ** 2 ||
              result.width !== preview.width ||
              result.height !== preview.height
            )
              throw new Error('Invalid working preview dimensions.')
            if (asset.hdr) {
              const hdr = { ...asset.hdr, url: asset.url }
              validateHdrAsset(hdr)
              if (
                hdr.width !== result.width ||
                hdr.height !== result.height ||
                hdr.byteLength !== asset.byteLength ||
                hdr.sha256 !== asset.sha256
              )
                throw new Error('HDR descriptor does not match its frame.')
              if (!cancelled) {
                preparedIdentity.current = `${asset.url}:${asset.sha256}`
                prepared.current = true
                setError('')
                setWorking({
                  identity: `${asset.url}:${asset.sha256}`,
                  data: new Float32Array(0),
                  width: result.width,
                  height: result.height,
                  transform: asset.transform,
                  hdr,
                })
              }
              return
            }
            const response = await fetch(asset.url, { signal: abort.signal, cache: 'no-store' })
            if (!response.ok || Number(response.headers.get('content-length')) !== asset.byteLength)
              throw new Error('Incomplete working preview.')
            const bytes = await response.arrayBuffer()
            if (bytes.byteLength !== asset.byteLength)
              throw new Error('Incomplete working preview.')
            const digest = await crypto.subtle.digest('SHA-256', bytes)
            const hash = Array.from(new Uint8Array(digest), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join('')
            if (
              hash !== asset.sha256 ||
              !Number.isFinite(asset.transform.white) ||
              asset.transform.white <= 0 ||
              !Number.isFinite(asset.transform.threshold) ||
              !Number.isFinite(asset.transform.offset)
            )
              throw new Error('Invalid working preview.')
            if (asset.transform.whiteBalance)
              validateWhiteBalanceProfile(asset.transform.whiteBalance)
            const data = new Float32Array(bytes)
            if (!data.every(Number.isFinite)) throw new Error('Invalid working pixels.')
            if (!cancelled) {
              preparedIdentity.current = `${asset.url}:${asset.sha256}`
              prepared.current = true
              setError('')
              setWorking({
                identity: `${asset.url}:${asset.sha256}`,
                data,
                width: result.width,
                height: result.height,
                transform: asset.transform,
              })
            }
          } catch (error) {
            if (!cancelled && !String(error).toLowerCase().includes('cancel'))
              setError('Live adjustments could not be prepared.')
          }
        })()
      },
      preview.format === 'hdr-working' ? 0 : 100,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
      abort.abort()
      void window.luma.releaseFullPreview(token).catch(() => undefined)
    }
  }, [preview, presented, generation, attempt])
  return {
    working,
    generation,
    error,
    retry: () => {
      setError('')
      setAttempt((value) => value + 1)
    },
  }
}
