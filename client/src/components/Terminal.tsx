import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useStore, AgentStatus } from "../stores/useStore";

interface TerminalProps {
  sessionId: string;
  color: string;
  nodeId: string;
}

export function Terminal({ sessionId, color, nodeId }: TerminalProps) {
  const updateSession = useStore((state) => state.updateSession);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!terminalRef.current || !sessionId) return;

    // Prevent double mount in strict mode
    if (mountedRef.current) return;
    mountedRef.current = true;

    // Clear container completely
    while (terminalRef.current.firstChild) {
      terminalRef.current.removeChild(terminalRef.current.firstChild);
    }

    // Create terminal
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace',
      fontWeight: "400",
      lineHeight: 1.4,
      letterSpacing: 0,
      theme: {
        background: "#0d0d0d",
        foreground: "#d4d4d4",
        cursor: color,
        cursorAccent: "#0d0d0d",
        selectionBackground: "#3b3b3b",
        selectionForeground: "#ffffff",
        black: "#1a1a1a",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#d4d4d4",
        brightBlack: "#525252",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fcd34d",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    
    // Reset all terminal attributes before receiving buffered content
    term.write("\x1b[0m\x1b[?25h");
    
    setTimeout(() => fitAddon.fit(), 50);

    // Keep scrolling working while chatting with interactive agent CLIs.
    // These CLIs (Copilot CLI, Claude Code, …) render in the alternate screen
    // buffer and turn on mouse tracking, so they scroll their own view in
    // response to mouse-wheel events rather than letting the terminal scroll a
    // scrollback buffer (the alt buffer has none).
    //
    // xterm does forward the wheel to the app as a mouse event, but it runs the
    // delta through Viewport.getLinesScrolled() first and drops the event when
    // that rounds to 0 lines — which happens constantly for trackpad pixel
    // deltas — so scrolling feels stuck. To make it reliable we accumulate the
    // delta ourselves and emit the SGR mouse-wheel sequence (button 64 = up,
    // 65 = down) directly, one event per line of movement.
    //
    // In the normal buffer (an agent rendering inline) real scrollback exists,
    // so we just scroll it ourselves. When the mouse isn't grabbed we let xterm
    // handle the wheel normally (native scrollback scrolling / selection).
    let wheelRemainder = 0;
    const wheelLines = (e: WheelEvent): number => {
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * term.rows;
      const fontSize = term.options.fontSize ?? 12;
      const lineHeight = typeof term.options.lineHeight === "number" ? term.options.lineHeight : 1.4;
      wheelRemainder += e.deltaY / (fontSize * lineHeight);
      const lines = Math.trunc(wheelRemainder);
      wheelRemainder -= lines;
      return lines;
    };

    // Map the wheel event's pixel position to a 1-based terminal cell so the
    // synthetic mouse event carries sensible coordinates.
    const wheelCell = (e: WheelEvent): { col: number; row: number } => {
      const el = term.element;
      if (!el) return { col: 1, row: 1 };
      const rect = el.getBoundingClientRect();
      const col = Math.floor(((e.clientX - rect.left) / rect.width) * term.cols) + 1;
      const row = Math.floor(((e.clientY - rect.top) / rect.height) * term.rows) + 1;
      return {
        col: Math.min(term.cols, Math.max(1, col)),
        row: Math.min(term.rows, Math.max(1, row)),
      };
    };

    term.attachCustomWheelEventHandler((e) => {
      const mouseGrabbed = term.element?.classList.contains("enable-mouse-events");
      if (!mouseGrabbed) return true;

      const lines = Math.round(wheelLines(e));
      if (lines === 0) return false;

      if (term.buffer.active.type === "normal") {
        term.scrollLines(lines);
        return false;
      }

      // Alternate buffer: forward the wheel to the app as SGR mouse events so it
      // scrolls its own view. button 64 = wheel up, 65 = wheel down.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const { col, row } = wheelCell(e);
        const button = lines < 0 ? 64 : 65;
        const count = Math.min(Math.abs(lines), 10);
        const seq = `\x1b[<${button};${col};${row}M`.repeat(count);
        wsRef.current.send(JSON.stringify({ type: "input", data: seq }));
      }
      return false;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket with small delay to allow session to be ready.
    // Always mirror the page's protocol (ws for http, wss for https) so the
    // browser never blocks the connection under its mixed-content policy.
    // In dev, Vite's proxy can't relay Bun's WebSocket upgrade response, so connect
    // directly to the backend's host/port; the default dev page is served over plain
    // HTTP, yielding ws://. (Serving the dev page over HTTPS requires the backend to
    // be reachable over TLS, since the browser forbids ws:// from an https:// origin.)
    // In production (single-server) the backend serves the client itself, so reuse
    // the current host.
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = import.meta.env.DEV
      ? `${protocol}//${window.location.hostname}:${import.meta.env.VITE_BACKEND_PORT ?? 6968}/ws?sessionId=${sessionId}`
      : `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;

    let ws: WebSocket | null = null;
    let isFirstMessage = true;

    const connectWs = () => {
      if (!mountedRef.current) return;

      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (xtermRef.current) {
          ws?.send(JSON.stringify({ type: "resize", cols: xtermRef.current.cols, rows: xtermRef.current.rows }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            // On first message (buffered history), reset terminal state first
            if (isFirstMessage) {
              isFirstMessage = false;
              // Clear screen, reset attributes, move cursor home
              term.write("\x1b[2J\x1b[H\x1b[0m");
            }
            term.write(msg.data);
          } else if (msg.type === "status") {
            // Handle status updates from plugin hooks
            updateSession(nodeId, {
              status: msg.status as AgentStatus,
              isRestored: msg.isRestored,
              currentTool: msg.currentTool,
            });
          }
        } catch (e) {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        // Silently handle errors - don't spam the terminal
      };

      ws.onclose = () => {
        // Only show if not intentionally closed
      };
    };

    // Small delay to let server session be ready
    const connectTimeout = setTimeout(connectWs, 100);

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
        if (ws?.readyState === WebSocket.OPEN && xtermRef.current) {
          ws.send(JSON.stringify({
            type: "resize",
            cols: xtermRef.current.cols,
            rows: xtermRef.current.rows
          }));
        }
      });
    });

    resizeObserver.observe(terminalRef.current);

    // --- Image paste / drag-and-drop support ---
    // The box is a text-only xterm terminal, so raw images can't be entered.
    // Instead we capture pasted/dropped images, upload them to the session's
    // working directory, and type the saved file path into the terminal so the
    // agent can reference it.
    const container = terminalRef.current;

    const quotePath = (p: string) => (/\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p);

    const insertPath = (path: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data: `${quotePath(path)} ` }));
      }
    };

    const uploadImage = async (file: File) => {
      try {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        const res = await fetch(`/api/sessions/${sessionId}/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
        });
        if (!res.ok) {
          term.write(`\r\n\x1b[31m[openui] image upload failed\x1b[0m\r\n`);
          return;
        }
        const { path } = await res.json();
        if (path) insertPath(path);
      } catch {
        term.write(`\r\n\x1b[31m[openui] image upload error\x1b[0m\r\n`);
      }
    };

    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            e.stopPropagation();
            void uploadImage(file);
            return;
          }
        }
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (images.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        images.forEach((f) => void uploadImage(f));
      }
    };

    container.addEventListener("paste", onPaste, true);
    container.addEventListener("dragover", onDragOver);
    container.addEventListener("drop", onDrop);

    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimeout);
      resizeObserver.disconnect();
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("dragover", onDragOver);
      container.removeEventListener("drop", onDrop);
      ws?.close();
      term.dispose();
    };
  }, [sessionId, color, nodeId, updateSession]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full"
      style={{ 
        padding: "12px", 
        backgroundColor: "#0d0d0d",
        minHeight: "200px"
      }}
    />
  );
}
