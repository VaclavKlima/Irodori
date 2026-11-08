import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalSquare, ChevronDown, Square } from 'lucide-react'
import { useConsoleResize } from '../hooks/useConsoleResize'
import { CONSOLE_HEIGHT_MIN } from '../../../shared/workspace'
import { Button, IconButton } from './ui/Controls'
import type { AgentOutput, AgentSessionState, AgentInspectionRegion } from '../../../shared/agent'
import { terminalChunks } from '../../../shared/agent'
import '@xterm/xterm/css/xterm.css'
import styles from '../App.module.css'

const initial: AgentSessionState = {
  sessionId: '',
  status: 'disconnected',
  resumable: false,
  message: 'Connect Codex to edit photos.',
}

/** A stable portal is moved between workspace slots; xterm and its session never remount. */
export function Console({
  host,
  open,
  onClose,
  height: preferredHeight,
  onHeightChange,
  inspection,
}: {
  host: HTMLElement | null
  open: boolean
  onClose: () => void
  height: number | null
  onHeightChange: (height: number | null) => void
  inspection?: AgentInspectionRegion
}) {
  const [root] = useState(() => {
    const element = document.createElement('div')
    element.style.display = 'contents'
    return element
  })
  const [state, setState] = useState(initial)
  const [error, setError] = useState('')
  const sizing = useConsoleResize(host, open, preferredHeight, onHeightChange)
  const stateRef = useRef(state)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const resizeRef = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    host?.appendChild(root)
  }, [host, root])
  useEffect(() => () => root.remove(), [root])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const terminal = new Terminal({
      disableStdin: true,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 11,
      lineHeight: 1.25,
      scrollback: 1500,
      linkHandler: {
        activate: (_event, uri) => {
          if (stateRef.current.status !== 'connected') return
          void window.irodori
            .openAgentSignInLink(stateRef.current.sessionId, uri)
            .catch((error) => setError(String(error)))
        },
      },
      theme: {
        background: '#161616',
        foreground: '#c0c0c0',
        cursor: '#e7c75c',
        selectionBackground: '#3c3c3c',
        black: '#161616',
        red: '#f0a4a4',
        green: '#afd0b7',
        yellow: '#e7c75c',
        blue: '#9dbbdf',
        magenta: '#c6a6d7',
        cyan: '#9fcbd0',
        white: '#c0c0c0',
        brightBlack: '#606060',
        brightRed: '#f0a4a4',
        brightGreen: '#afd0b7',
        brightYellow: '#e7c75c',
        brightBlue: '#9dbbdf',
        brightMagenta: '#c6a6d7',
        brightCyan: '#9fcbd0',
        brightWhite: '#f2f2f2',
      },
    })
    terminalRef.current = terminal
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.textarea?.setAttribute('aria-label', 'Codex terminal')
    let selectionStarted = false,
      copyFrame = 0,
      clipboardTail = Promise.resolve()
    const copySelection = () => {
      const text = terminal.getSelection()
      if (!text) return
      const id = stateRef.current.sessionId
      clipboardTail = clipboardTail
        .then(() => window.irodori.copyAgentSelection(id, text))
        .catch((error) => setError(String(error)))
    }
    const startSelection = (event: PointerEvent) => {
      if (event.button === 0 && event.isPrimary) {
        cancelAnimationFrame(copyFrame)
        selectionStarted = true
      }
    }
    const endSelection = () => {
      if (!selectionStarted) return
      selectionStarted = false
      cancelAnimationFrame(copyFrame)
      // Let xterm finish its mouse-up selection before reading the selected plain text.
      copyFrame = requestAnimationFrame(copySelection)
    }
    const cancelSelection = () => {
      selectionStarted = false
      cancelAnimationFrame(copyFrame)
    }
    container.addEventListener('pointerdown', startSelection, true)
    window.addEventListener('pointerup', endSelection, true)
    window.addEventListener('pointercancel', cancelSelection)
    window.addEventListener('blur', cancelSelection)
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'c' &&
        terminal.hasSelection()
      ) {
        if (event.type === 'keydown') {
          event.preventDefault()
          copySelection()
        }
        return false
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        if (event.type === 'keydown' && stateRef.current.status === 'connected') {
          event.preventDefault()
          void window.irodori
            .pasteAgentInput(stateRef.current.sessionId, terminal.modes.bracketedPasteMode)
            .catch((error) => setError(String(error)))
        }
        return false
      }
      return !(event.key === 'Tab' && event.shiftKey)
    })
    let lastSequence = 0,
      disposed = false,
      frame = 0,
      lastSize = '',
      loaded = false
    const buffered: AgentOutput[] = []
    const accept = (next: AgentSessionState) => {
      if (disposed) return
      if (next.sessionId !== stateRef.current.sessionId) {
        terminal.reset()
        lastSequence = 0
        lastSize = ''
      }
      stateRef.current = next
      setState(next)
      terminal.options.disableStdin = next.status !== 'connected'
      resize()
    }
    const consume = (output: AgentOutput) => {
      if (disposed || output.sessionId !== stateRef.current.sessionId) return
      const ack = () => {
        void window.irodori
          .acknowledgeAgentOutput(output.sessionId, output.sequence)
          .catch(() => {})
      }
      if (output.sequence <= lastSequence) {
        ack()
        return
      }
      lastSequence = output.sequence
      terminal.write(output.data, ack)
    }
    const unsubscribeState = window.irodori.onAgentState(accept)
    const unsubscribeOutput = window.irodori.onAgentOutput((output) => {
      if (loaded) consume(output)
      else buffered.push(output)
    })
    void window.irodori
      .getAgentSession()
      .then((snapshot) => {
        if (disposed) return
        accept(snapshot)
        loaded = true
        for (const output of [...snapshot.output, ...buffered].sort(
          (a, b) => a.sequence - b.sequence,
        ))
          consume(output)
        buffered.length = 0
      })
      .catch((error) => {
        if (!disposed) setError(String(error))
      })
    let inputTail = Promise.resolve(),
      inputBytes = 0
    const input = terminal.onData((data) => {
      if (stateRef.current.status !== 'connected') return
      const bytes = new TextEncoder().encode(data).byteLength
      if (inputBytes + bytes > 64 * 1024) {
        setError('Paste is limited to 64 KiB. Use a shorter photo request.')
        return
      }
      inputBytes += bytes
      const id = stateRef.current.sessionId
      inputTail = inputTail
        .then(async () => {
          for (const chunk of terminalChunks(data)) await window.irodori.writeAgentInput(id, chunk)
        })
        .catch((error) => {
          if (!disposed) setError(String(error))
        })
        .finally(() => {
          inputBytes -= bytes
        })
    })
    function resize() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return
        fit.fit()
        const current = stateRef.current,
          size = `${current.sessionId}:${terminal.cols}:${terminal.rows}`
        if (
          current.status === 'connected' &&
          terminal.cols >= 2 &&
          terminal.rows >= 2 &&
          size !== lastSize
        ) {
          lastSize = size
          void window.irodori
            .resizeAgent(
              current.sessionId,
              Math.min(500, terminal.cols),
              Math.min(200, terminal.rows),
            )
            .catch(() => {})
        }
      })
    }
    resizeRef.current = resize
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()
    return () => {
      disposed = true
      observer.disconnect()
      cancelAnimationFrame(frame)
      cancelSelection()
      container.removeEventListener('pointerdown', startSelection, true)
      window.removeEventListener('pointerup', endSelection, true)
      window.removeEventListener('pointercancel', cancelSelection)
      window.removeEventListener('blur', cancelSelection)
      unsubscribeState()
      unsubscribeOutput()
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])
  useEffect(() => {
    resizeRef.current()
  }, [host, open])

  const connect = async (choice: 'new' | 'resume' | 'reconnect') => {
    setError('')
    try {
      const next = await window.irodori.connectAgent(choice)
      stateRef.current = next
      setState(next)
      if (next.status === 'connected') terminalRef.current?.focus()
    } catch (error) {
      setError(String(error))
    }
  }
  const busy = state.status === 'connecting'
  return createPortal(
    <section
      className={styles.console}
      aria-label="Agent console"
      id="agent-console"
      data-testid="console-panel"
      hidden={!open}
      style={{ height: sizing.height, flexBasis: sizing.height }}
    >
      <div
        className={styles.consoleResize}
        role="separator"
        tabIndex={0}
        aria-label="Resize agent console"
        aria-orientation="horizontal"
        aria-controls="agent-console"
        aria-valuemin={CONSOLE_HEIGHT_MIN}
        aria-valuemax={sizing.maximum}
        aria-valuenow={sizing.height}
        aria-valuetext={`${sizing.height} pixels high`}
        title="Drag to resize. Arrow Up/Down adjusts height; Home/End sets limits. Double-click to reset."
        onPointerDown={sizing.start}
        onPointerMove={sizing.move}
        onPointerUp={sizing.finish}
        onPointerCancel={sizing.cancel}
        onLostPointerCapture={sizing.cancel}
        onKeyDown={sizing.keydown}
        onDoubleClick={() => onHeightChange(null)}
      />
      <header className={styles.consoleHeader}>
        <span className={styles.consoleTitle}>
          <TerminalSquare size={14} /> Console
        </span>
        <span className={styles.disconnected} role="status">
          {state.status === 'choice'
            ? 'Conversation saved'
            : state.status === 'connected'
              ? 'Codex'
              : state.status === 'connecting'
                ? 'Connecting'
                : state.status === 'error'
                  ? 'Connection failed'
                  : 'Disconnected'}
        </span>
        <span className={styles.consoleSpacer} />
        {state.status === 'connected' && state.signInAvailable && (
          <>
            <Button
              variant="primary"
              onClick={() =>
                void window.irodori
                  .openAgentSignIn(state.sessionId)
                  .catch((error) => setError(String(error)))
              }
            >
              Open sign-in
            </Button>
            <Button
              onClick={() =>
                void window.irodori
                  .copyAgentSignInLink(state.sessionId)
                  .catch((error) => setError(String(error)))
              }
            >
              Copy sign-in link
            </Button>
          </>
        )}
        {state.status === 'choice' && (
          <Button variant="primary" disabled={busy} onClick={() => void connect('resume')}>
            Resume conversation
          </Button>
        )}
        {!['connected', 'choice'].includes(state.status) && (
          <Button variant="primary" disabled={busy} onClick={() => void connect('reconnect')}>
            {state.resumable ? 'Reconnect' : 'Connect Codex'}
          </Button>
        )}
        <Button disabled={busy} onClick={() => void connect('new')}>
          New conversation
        </Button>
        {state.status === 'connected' && (
          <Button
            onClick={() =>
              void window.irodori
                .interruptAgent(state.sessionId)
                .catch((error) => setError(String(error)))
            }
          >
            <Square size={11} /> Stop
          </Button>
        )}
        {state.status === 'error' && (
          <Button
            onClick={() => {
              void window.irodori
                .chooseAgentExecutable()
                .then((selected) => {
                  if (selected) void connect('reconnect')
                })
                .catch((error) => setError(String(error)))
            }}
          >
            Choose Codex executable
          </Button>
        )}
        <IconButton icon={ChevronDown} label="Close agent console" onClick={onClose} />
      </header>
      {inspection && (
        <div
          className={styles.consoleInspection}
          data-testid="console-inspection-context"
          role="status"
        >
          Next prompt · Region {inspection.region.x}, {inspection.region.y} ·{' '}
          {inspection.region.width} × {inspection.region.height} photo pixels
        </div>
      )}
      {(error || state.status !== 'connected') && (
        <p
          className={styles.consoleNotice}
          role={error || state.status === 'error' ? 'alert' : 'status'}
        >
          {error || state.message}
        </p>
      )}
      <div
        className={styles.terminal}
        title="Select terminal text to copy it. Shift+Tab returns to the console controls."
      >
        <div className={styles.terminalHost} ref={containerRef} />
      </div>
    </section>,
    root,
  )
}
