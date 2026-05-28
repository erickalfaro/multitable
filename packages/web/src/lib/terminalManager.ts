import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement | null;
}

class TerminalManager {
  private entries: Map<string, TerminalEntry> = new Map();

  private createTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 10000,
      fontFamily: '"Menlo", "Consolas", "DejaVu Sans Mono", monospace',
      theme: {
        background: '#1a1a1a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    return { terminal, fitAddon };
  }

  getOrCreate(processId: string): TerminalEntry {
    if (this.entries.has(processId)) return this.entries.get(processId)!;

    const { terminal, fitAddon } = this.createTerminal();
    const entry: TerminalEntry = { terminal, fitAddon, container: null };
    this.entries.set(processId, entry);
    return entry;
  }

  attach(processId: string, container: HTMLDivElement): void {
    // Destroy any previous terminal for this process (xterm can only open() once)
    const existing = this.entries.get(processId);
    if (existing) {
      try { existing.terminal.dispose(); } catch { /* ignore */ }
      this.entries.delete(processId);
    }

    // Clear the container of any leftover DOM from previous terminals
    container.innerHTML = '';

    // Create fresh terminal and open it
    const { terminal, fitAddon } = this.createTerminal();
    const entry: TerminalEntry = { terminal, fitAddon, container };
    this.entries.set(processId, entry);

    terminal.open(container);

    // Fit after layout settles
    const doFit = () => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    };
    requestAnimationFrame(() => {
      doFit();
      requestAnimationFrame(doFit);
    });
  }

  detach(processId: string): void {
    const entry = this.entries.get(processId);
    if (!entry) return;
    // Dispose and remove — scrollback will be re-sent by backend on next subscribe
    try { entry.terminal.dispose(); } catch { /* ignore */ }
    this.entries.delete(processId);
  }

  destroy(processId: string): void {
    this.detach(processId);
  }

  fit(processId: string): { cols: number; rows: number } | null {
    const entry = this.entries.get(processId);
    if (!entry) return null;
    try {
      entry.fitAddon.fit();
      return { cols: entry.terminal.cols, rows: entry.terminal.rows };
    } catch {
      return null;
    }
  }

  handleScrollback(processId: string, data: string): void {
    const entry = this.entries.get(processId);
    if (!entry) return;

    // Reset terminal before replaying scrollback to prevent duplicates
    // (e.g. on WebSocket reconnect, the backend re-sends full scrollback)
    entry.terminal.reset();

    const CHUNK_SIZE = 16 * 1024; // 16KB
    if (data.length <= CHUNK_SIZE) {
      entry.terminal.write(data);
      entry.terminal.scrollToBottom();
      return;
    }

    // Chunked write for large scrollback
    let offset = 0;
    const writeChunk = () => {
      if (offset >= data.length) {
        entry.terminal.scrollToBottom();
        return;
      }
      const chunk = data.slice(offset, offset + CHUNK_SIZE);
      entry.terminal.write(chunk);
      entry.terminal.scrollToBottom();
      offset += CHUNK_SIZE;
      setTimeout(writeChunk, 0);
    };
    writeChunk();
  }

  writeData(processId: string, data: string): void {
    const entry = this.entries.get(processId);
    if (entry) entry.terminal.write(data);
  }

  focus(processId: string): void {
    const entry = this.entries.get(processId);
    if (entry) entry.terminal.focus();
  }

  updateThemeColors(theme: { background: string; foreground: string; cursor: string }): void {
    for (const { terminal } of this.entries.values()) {
      terminal.options.theme = theme;
    }
  }
}

export const terminalManager = new TerminalManager();
