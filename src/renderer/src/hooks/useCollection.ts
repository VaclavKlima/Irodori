import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { CollectionController } from '../collections/controller'

export function useCollection<T>(onStale?: (error: unknown) => boolean) {
  const [controller] = useState(() => new CollectionController<T>())
  useLayoutEffect(() => {
    controller.setStaleHandler(onStale)
  }, [controller, onStale])
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => () => controller.close(), [controller])
  return { controller, ...snapshot }
}
