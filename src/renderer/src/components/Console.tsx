import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Circle, Play, TerminalSquare, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import styles from '../App.module.css'

export function Console({ onClose }: { onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      convertEol: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.55,
      scrollback: 100,
      theme: {
        background: '#1b1b1b',
        foreground: '#a5a59f',
        cursor: '#1b1b1b',
        selectionBackground: '#44443c',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.textarea?.setAttribute(
      'aria-label',
      'Agent console output, disconnected and read only',
    )
    terminal.textarea?.setAttribute('readonly', '')
    terminal.writeln('\x1b[38;2;197;189;142m  IRODORI\x1b[0m  /  Agent console')
    terminal.writeln('')
    terminal.writeln('  No agent connected.')
    terminal.writeln('  Your workspace is ready. CLI agent support is coming in a future version.')
    terminal.writeln('')
    terminal.writeln(
      '\x1b[38;2;117;117;110m  This demo console is read only. No commands are executed.\x1b[0m',
    )

    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      terminal.dispose()
    }
  }, [])

  return (
    <section
      className={styles.console}
      aria-label="Agent console"
      id="agent-console"
      data-testid="console-panel"
    >
      <header className={styles.consoleHeader}>
        <span className={styles.consoleTitle}>
          <TerminalSquare size={14} /> Agent console
        </span>
        <span className={styles.disconnected}>
          <Circle size={6} fill="currentColor" /> Disconnected
        </span>
        <span className={styles.consoleSpacer} />
        <button className={styles.connectButton} disabled aria-label="Connect agent">
          <Play size={11} /> Connect agent
        </button>
        <button className={styles.iconButton} aria-label="Close agent console" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className={styles.terminal} ref={containerRef} />
    </section>
  )
}
