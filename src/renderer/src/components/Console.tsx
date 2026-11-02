import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalSquare, ChevronDown } from 'lucide-react'
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
      fontSize: 11,
      lineHeight: 1.8,
      scrollback: 100,
      theme: {
        background: '#161616',
        foreground: '#c0c0c0',
        cursor: '#161616',
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
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminal.textarea?.setAttribute(
      'aria-label',
      'Agent console output, disconnected and read only',
    )
    terminal.textarea?.setAttribute('readonly', '')
    terminal.writeln('Console is read-only. Command execution is not available.')
    terminal.writeln('')
    terminal.writeln('No agent connected.')
    terminal.write('CLI agent support is coming in a future version.')

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
          <TerminalSquare size={14} /> Console
        </span>
        <span className={styles.disconnected}>Disconnected</span>
        <span className={styles.consoleSpacer} />
        <button className={styles.iconButton} aria-label="Close agent console" onClick={onClose}>
          <ChevronDown size={14} />
        </button>
      </header>
      <div className={styles.terminal}>
        <div className={styles.terminalHost} ref={containerRef} />
      </div>
    </section>
  )
}
