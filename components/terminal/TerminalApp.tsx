"use client";

// ShapesOS — Phase 18.2 (WS=content): the Terminal app.
//
// xterm.js (+ addon-fit) in the browser, loaded lazily so the page's bundle
// doesn't carry it; the shell itself runs in the person's workspace sandbox
// (lib/terminal/service.ts). It is a line terminal over the sandbox's exec
// API — each Enter runs one command (`sh -lc` in the current directory, which
// carries over), output streams back as NDJSON from
// /api/terminal/[id]/exec, Ctrl+C stops the running command (the request is
// aborted, the sandbox kills the process). No PTY: full-screen programs
// (vim, top) are not supported; the sandbox has no stdin for them.
//
// Colours: the night surface tokens only. Programs' ANSI colours are mapped
// to neutral greys — status colours mean agent states (DESIGN.md), and a
// fifth accent is not allowed.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "@xterm/xterm/css/xterm.css";
import { Power, SquareTerminal } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { TerminalSessionOut } from "@/lib/terminal/service";

export interface TerminalAppProps {
  available: { ok: true; provider: string } | { ok: false; reason: string };
  canUse: boolean;
  initialSession: TerminalSessionOut | null;
  initialHistory: string[];
  idleMinutes: number;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The xterm theme from the night tokens; ANSI colours collapse to neutrals. */
function nightTheme() {
  const bg = cssVar("--aos-night", "#000000");
  const fg = cssVar("--aos-night-text", "#FFFFFF");
  const soft = cssVar("--aos-night-text-soft", "#BDBDB8");
  const muted = cssVar("--aos-night-text-muted", "#A3A39E");
  const raised = cssVar("--aos-night-raised", "#2A2A28");
  const line = cssVar("--aos-night-border", "#4A4A47");
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: line,
    black: raised,
    red: soft,
    green: soft,
    yellow: soft,
    blue: soft,
    magenta: soft,
    cyan: soft,
    white: fg,
    brightBlack: muted,
    brightRed: fg,
    brightGreen: fg,
    brightYellow: fg,
    brightBlue: fg,
    brightMagenta: fg,
    brightCyan: fg,
    brightWhite: fg,
  };
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function TerminalApp({ available, canUse, initialSession, initialHistory, idleMinutes }: TerminalAppProps) {
  const { t } = useI18n();
  const [session, setSession] = useState<TerminalSessionOut | null>(initialSession);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const open = useCallback(async () => {
    setOpening(true);
    try {
      const res = await fetch("/api/terminal", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { session?: TerminalSessionOut; error?: string };
      if (!res.ok || !body.session) {
        toastError(t("terminalApp.startFailed"), body.error);
        return;
      }
      setEnded(false);
      setSession(body.session);
    } catch {
      toastError(t("terminalApp.startFailed"), t("common.couldNotReach"));
    } finally {
      setOpening(false);
    }
  }, [t]);

  const close = useCallback(async () => {
    if (!session) return;
    const ok = await confirmAction({ title: t("terminalApp.closeConfirm"), confirmLabel: t("terminalApp.close"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    const res = await fetch(`/api/terminal/${encodeURIComponent(session.id)}`, { method: "DELETE" }).catch(() => null);
    if (res && res.ok) {
      toast({ title: t("terminalApp.closed"), status: "done" });
      setSession(null);
    } else {
      toastError(t("terminalApp.startFailed"));
    }
  }, [session, t]);

  if (!available.ok || !canUse) {
    return (
      <div className="flex flex-col gap-6">
        <Header />
        <section className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-16 text-center shadow-hairline">
          <SquareTerminal className="size-7 text-subtle" aria-hidden />
          <h2 className="aos-subheading">{!canUse ? t("terminalApp.viewerTitle") : t("terminalApp.unavailableTitle")}</h2>
          <p className="max-w-[56ch] text-md text-muted">{!canUse ? t("terminalApp.viewerBody") : t("terminalApp.unavailableBody")}</p>
          {canUse && !available.ok ? <p className="max-w-[64ch] rounded-md bg-canvas px-3 py-2 font-mono text-xs text-muted">{t("terminalApp.unavailableReason", { reason: available.reason })}</p> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Header
        right={
          <div className="flex flex-wrap items-center gap-2">
            <NeutralBadge size="sm" label={t("terminalApp.sandbox", { provider: available.provider })} />
            {session ? (
              <>
                <NeutralBadge size="sm" label={busy ? t("terminalApp.running") : t("terminalApp.ready")} />
                <button type="button" onClick={() => void close()} className={aosButton({ variant: "secondary", size: "sm" })}>
                  <Power className="size-4" aria-hidden />
                  {t("terminalApp.close")}
                </button>
              </>
            ) : null}
          </div>
        }
      />
      {session && !ended ? (
        <TerminalView
          key={session.id}
          session={session}
          provider={available.provider}
          resumed={!!initialSession && initialSession.id === session.id}
          initialHistory={initialSession?.id === session.id ? initialHistory : []}
          onBusy={setBusy}
          onEnded={() => setEnded(true)}
        />
      ) : (
        <section className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-16 text-center shadow-hairline">
          <SquareTerminal className="size-7 text-subtle" aria-hidden />
          <h2 className="aos-subheading">{ended ? t("terminalApp.ended") : t("terminalApp.idleTitle")}</h2>
          {!ended ? <p className="max-w-[56ch] text-md text-muted">{t("terminalApp.idleBody")}</p> : null}
          <button type="button" onClick={() => void open()} disabled={opening} className={aosButton({ size: "sm" })}>
            <SquareTerminal className="size-4" aria-hidden />
            {opening ? t("terminalApp.opening") : t("terminalApp.open")}
          </button>
        </section>
      )}
      <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">{t("terminalApp.recorded", { minutes: idleMinutes })}</p>
    </div>
  );
}

function Header({ right }: { right?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("terminalApp.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("terminalApp.subtitle")}</p>
      </div>
      {right}
    </div>
  );
}

function TerminalView({
  session,
  provider,
  resumed,
  initialHistory,
  onBusy,
  onEnded,
}: {
  session: TerminalSessionOut;
  provider: string;
  resumed: boolean;
  initialHistory: string[];
  onBusy: (b: boolean) => void;
  onEnded: () => void;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Everything the key handler needs lives in refs (xterm's handler is bound once).
  const state = useRef({
    line: "",
    pos: 0,
    cwd: null as string | null,
    history: [...initialHistory],
    histIdx: -1,
    running: null as AbortController | null,
  });
  const strings = useRef({ t });
  useEffect(() => {
    strings.current = { t };
  }, [t]);

  useEffect(() => {
    let term: XTerm | null = null;
    let fit: FitAddon | null = null;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    const s = state.current;

    const prompt = () => {
      const dir = s.cwd ? s.cwd.replace(/^\/home\/[^/]+/, "~") : "~";
      return `${BOLD}${dir}${RESET} $ `;
    };
    const redraw = () => {
      if (!term) return;
      term.write(`\r\x1b[K${prompt()}${s.line}`);
      const back = s.line.length - s.pos;
      if (back > 0) term.write(`\x1b[${back}D`);
    };
    const note = (text: string) => term?.write(`${DIM}[${text}]${RESET}\r\n`);

    const run = async (command: string) => {
      if (!term) return;
      term.write("\r\n");
      if (!command.trim()) {
        redraw();
        return;
      }
      if (s.history[s.history.length - 1] !== command) s.history.push(command);
      if (s.history.length > 200) s.history.shift();
      s.histIdx = -1;
      const ctrl = new AbortController();
      s.running = ctrl;
      onBusy(true);
      let endedNow = false;
      let lastByte = "\n";
      try {
        const res = await fetch(`/api/terminal/${encodeURIComponent(session.id)}/exec`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command, cwd: s.cwd ?? undefined }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          term.write(`${body.error ?? `HTTP ${res.status}`}\r\n`);
          if (res.status === 409) endedNow = true;
        } else {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const raw = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!raw.trim()) continue;
              const msg = JSON.parse(raw) as
                | { type: "out"; stream: "stdout" | "stderr"; data: string }
                | { type: "exit"; exitCode: number; timedOut: boolean; truncated: boolean; cwd: string }
                | { type: "error"; error: string };
              if (msg.type === "out") {
                if (msg.data) {
                  term.write(msg.stream === "stderr" ? `${DIM}${msg.data}${RESET}` : msg.data);
                  lastByte = msg.data.slice(-1);
                }
              } else if (msg.type === "exit") {
                if (lastByte !== "\n") term.write("\r\n");
                lastByte = "\n";
                if (msg.timedOut) note(strings.current.t("terminalApp.timedOut"));
                if (msg.truncated) note(strings.current.t("terminalApp.truncated"));
                if (msg.exitCode !== 0) note(strings.current.t("terminalApp.exit", { code: msg.exitCode }));
                s.cwd = msg.cwd || s.cwd;
              } else if (msg.type === "error") {
                if (lastByte !== "\n") term.write("\r\n");
                lastByte = "\n";
                term.write(`${msg.error}\r\n`);
                if (/ended|stopped \(idle/.test(msg.error)) endedNow = true;
              }
            }
          }
        }
      } catch (err) {
        if (lastByte !== "\n") term?.write("\r\n");
        if ((err as { name?: string })?.name === "AbortError") note(strings.current.t("terminalApp.interrupted"));
        else term?.write(`${strings.current.t("common.couldNotReach")}\r\n`);
      } finally {
        s.running = null;
        onBusy(false);
      }
      if (endedNow) {
        onEnded();
        return;
      }
      redraw();
    };

    const onData = (data: string) => {
      if (!term) return;
      if (s.running) {
        if (data === "\x03") s.running.abort();
        return; // no stdin while a command runs
      }
      // Paste with newlines: every complete line runs as one script.
      if (data.length > 1 && /[\r\n]/.test(data)) {
        const text = (s.line.slice(0, s.pos) + data.replace(/\r\n?/g, "\n") + s.line.slice(s.pos)).split("\n");
        const rest = text.pop() ?? "";
        const script = text.join("\n");
        s.line = "";
        s.pos = 0;
        term.write(script.replace(/\n/g, "\r\n> "));
        void run(script).then(() => {
          s.line = rest;
          s.pos = rest.length;
          redraw();
        });
        return;
      }
      switch (data) {
        case "\r": {
          const cmd = s.line;
          s.line = "";
          s.pos = 0;
          void run(cmd);
          return;
        }
        case "\x7f": // Backspace
          if (s.pos > 0) {
            s.line = s.line.slice(0, s.pos - 1) + s.line.slice(s.pos);
            s.pos -= 1;
            redraw();
          }
          return;
        case "\x1b[3~": // Delete
          if (s.pos < s.line.length) {
            s.line = s.line.slice(0, s.pos) + s.line.slice(s.pos + 1);
            redraw();
          }
          return;
        case "\x03": // Ctrl+C on an idle line: drop it
          term.write("^C\r\n");
          s.line = "";
          s.pos = 0;
          redraw();
          return;
        case "\x0c": // Ctrl+L
          term.clear();
          redraw();
          return;
        case "\x1b[D":
          if (s.pos > 0) {
            s.pos -= 1;
            term.write(data);
          }
          return;
        case "\x1b[C":
          if (s.pos < s.line.length) {
            s.pos += 1;
            term.write(data);
          }
          return;
        case "\x1b[H":
        case "\x01":
          s.pos = 0;
          redraw();
          return;
        case "\x1b[F":
        case "\x05":
          s.pos = s.line.length;
          redraw();
          return;
        case "\x1b[A": // history up
          if (s.history.length === 0) return;
          s.histIdx = s.histIdx < 0 ? s.history.length - 1 : Math.max(0, s.histIdx - 1);
          s.line = s.history[s.histIdx] ?? "";
          s.pos = s.line.length;
          redraw();
          return;
        case "\x1b[B": // history down
          if (s.histIdx < 0) return;
          s.histIdx += 1;
          if (s.histIdx >= s.history.length) {
            s.histIdx = -1;
            s.line = "";
          } else s.line = s.history[s.histIdx] ?? "";
          s.pos = s.line.length;
          redraw();
          return;
        default: {
          if (data.startsWith("\x1b")) return; // other escape sequences
          // Printable text (typed or pasted on one line).
          const printable = data.replace(/[\x00-\x1f\x7f]/g, "");
          if (!printable) return;
          s.line = s.line.slice(0, s.pos) + printable + s.line.slice(s.pos);
          s.pos += printable.length;
          redraw();
        }
      }
    };

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      const mono = cssVar("--aos-font-mono", "ui-monospace, Menlo, monospace");
      term = new Terminal({
        theme: nightTheme(),
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
        allowProposedApi: false,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        // hidden host (e.g. a split pane collapsed): the observer fits later
      }
      ro = new ResizeObserver(() => {
        try {
          fit?.fit();
        } catch {
          // ignore
        }
      });
      ro.observe(hostRef.current);
      term.onData(onData);
      term.write(`${DIM}${strings.current.t(resumed ? "terminalApp.resumed" : "terminalApp.welcome", { provider })}${RESET}\r\n`);
      if (resumed) term.write(`${DIM}${strings.current.t("terminalApp.welcome", { provider })}${RESET}\r\n`);
      redraw();
      term.focus();
    })();

    return () => {
      disposed = true;
      s.running?.abort();
      ro?.disconnect();
      term?.dispose();
      term = null;
    };
    // The session is fixed for this view (keyed by session id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <section aria-label={t("terminalApp.label")} className="overflow-hidden rounded-lg bg-night p-3 shadow-hairline">
      <div ref={hostRef} className="h-[min(65vh,36rem)] min-h-[16rem] w-full" />
    </section>
  );
}

export default TerminalApp;
