import { Brush, ScanSearch } from 'lucide-react'
import { maskCapabilities } from '../../../shared/masks'
import type { CommandMenuAction } from './ui/CommandMenu'

type CreationContext = {
  available: boolean
  objectSelection?: { available: boolean; active: boolean; start: () => Promise<void> }
  maskCount: number
  busy: boolean
}
type InvocationContext = CreationContext & { createBrush: () => void }

// Only implemented tools enter the chooser; future tools share this invocation path.
const tools = [
  {
    id: 'object',
    label: 'Select object…',
    icon: ScanSearch,
    start: (context: InvocationContext) => void context.objectSelection?.start(),
  },
  {
    id: 'brush',
    label: 'Brush',
    icon: Brush,
    start: (context: InvocationContext) => context.createBrush(),
  },
] as const
export type MaskToolId = (typeof tools)[number]['id']

export function maskCreationActions(context: CreationContext): CommandMenuAction<MaskToolId>[] {
  const reason = context.objectSelection?.active
    ? 'Finish or cancel the object selection first.'
    : context.maskCount >= maskCapabilities.maxMasks
      ? `A photograph can have up to ${maskCapabilities.maxMasks} masks.`
      : context.busy
        ? 'Wait for the current edit to finish.'
        : undefined
  return tools.flatMap((tool) => {
    if (tool.id === 'object' && !context.objectSelection) return []
    const available = tool.id === 'object' ? context.objectSelection?.available : context.available
    const { id, label, icon } = tool
    return [
      {
        id,
        label,
        icon,
        disabledReason:
          reason ?? (available ? undefined : 'Wait for a supported photograph to be ready.'),
      },
    ]
  })
}

export function startMaskCreation(id: MaskToolId, context: InvocationContext) {
  const action = maskCreationActions(context).find((action) => action.id === id)
  if (action && !action.disabledReason) tools.find((tool) => tool.id === id)?.start(context)
}
