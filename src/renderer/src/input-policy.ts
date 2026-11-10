const copyableText = '[data-selectable-text], [role="alert"]'
const nonTextInputs = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

function nativeTextOwner(element: Element | null): boolean {
  const input = element?.closest('input, textarea')
  return (
    input instanceof HTMLTextAreaElement ||
    (input instanceof HTMLInputElement && !nonTextInputs.has(input.type)) ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    !!element?.closest('.xterm')
  )
}

function copyableOwner(element: Element | null): Element | null {
  if (element?.closest('button, select, input, summary, [role="button"], [role="menuitem"]'))
    return null
  return element?.closest(copyableText) ?? null
}

function nodeElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null)
}

/** Keep document selection inside deliberate copyable regions, including native menu Select All. */
export function installInputPolicy(document: Document): () => void {
  let pointerOwner: Element | null = null
  const pointerdown = (event: PointerEvent) => {
    pointerOwner = copyableOwner(nodeElement(event.target as Node | null))
  }
  const focusin = (event: FocusEvent) => {
    if (event.target !== document.body) pointerOwner = null
  }
  const selectContents = (element: Element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      (!event.ctrlKey && !event.metaKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== 'a'
    )
      return
    const element = event.composedPath().find((item): item is Element => item instanceof Element)
    if (nativeTextOwner(element ?? null)) return
    event.preventDefault()
    const owner = copyableOwner(element ?? null)
    pointerOwner = null
    if (owner) selectContents(owner)
    else document.getSelection()?.removeAllRanges()
  }
  const selectionchange = () => {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || nativeTextOwner(document.activeElement)) return
    const owner = copyableOwner(document.activeElement) ?? pointerOwner
    if (owner?.contains(selection.anchorNode) && owner.contains(selection.focusNode)) return
    if (owner) selectContents(owner)
    else selection.removeAllRanges()
  }
  document.addEventListener('keydown', keydown, true)
  document.addEventListener('pointerdown', pointerdown, true)
  document.addEventListener('focusin', focusin)
  document.addEventListener('selectionchange', selectionchange)
  return () => {
    document.removeEventListener('keydown', keydown, true)
    document.removeEventListener('pointerdown', pointerdown, true)
    document.removeEventListener('focusin', focusin)
    document.removeEventListener('selectionchange', selectionchange)
  }
}
