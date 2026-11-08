import {
  ArrowUpFromLine,
  CheckSquare,
  Copy,
  ClipboardPaste,
  Image,
  Layers,
  ScanLine,
  Trash2,
  Ungroup,
  Unlink,
} from 'lucide-react'
import {
  buildPhotoMenu,
  type PhotoActionId,
  type PhotoActionsContext,
} from '../../../shared/photo-actions'
import { CommandMenu, type MenuInitialFocus } from './ui/CommandMenu'

const icons = {
  copy: Copy,
  paste: ClipboardPaste,
  export: ArrowUpFromLine,
  cover: Image,
  remove: Unlink,
  merge: Layers,
  group: ScanLine,
  select: CheckSquare,
  ungroup: Ungroup,
  trash: Trash2,
}
export type { MenuInitialFocus } from './ui/CommandMenu'

export function PhotoContextMenu({
  x,
  y,
  context,
  toolbar,
  initialFocus,
  pending,
  onAction,
  onClose,
}: {
  x: number
  y: number
  context: PhotoActionsContext
  toolbar: boolean
  initialFocus: MenuInitialFocus
  pending: boolean
  onAction: (id: PhotoActionId) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const model = buildPhotoMenu(context, toolbar)
  return (
    <CommandMenu
      id="photo-actions-menu"
      idPrefix="photo-menu"
      label="Photo actions"
      x={x}
      y={y}
      initialFocus={initialFocus}
      pending={pending}
      blockers={model.blockers}
      statusesBeforeSection="trash"
      emptyText="No photo actions available."
      sections={model.sections.map((section) => ({
        ...section,
        actions: section.actions.map((action) => ({
          ...action,
          icon: icons[action.icon],
          disabledReason:
            action.availability.kind === 'blocked' ? action.availability.reason : undefined,
        })),
      }))}
      onAction={onAction}
      onClose={onClose}
    />
  )
}
