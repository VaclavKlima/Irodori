import { useCallback, useLayoutEffect, useState } from 'react'
import { WorkspaceCheckpoint } from '../collections/workspace-checkpoint'
import type { WorkspaceState } from '../../../shared/workspace'

export function useWorkspaceCheckpoint() {
  const [status, setStatus] = useState('')
  const [checkpoint] = useState(
    () => new WorkspaceCheckpoint((change) => window.irodori.saveWorkspaceState(change), setStatus),
  )
  const patch = useCallback(
    (change: Partial<WorkspaceState>) => checkpoint.patch(change),
    [checkpoint],
  )
  useLayoutEffect(() => {
    checkpoint.resume()
    return () => checkpoint.close()
  }, [checkpoint])
  return { checkpoint, patch, status }
}
