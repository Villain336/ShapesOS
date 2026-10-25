"use client";

// ShapesOS — docked chat: the assistant beside the work, on every dashboard
// page (member-requested, Oct 2026; comparison pick #1). Until now the
// assistant lived only on /dashboard/assistant; split view could place it
// beside one other page, but nothing carried it across pages. This dock
// renders the same AiChatPanel (same ChatProvider state, same threads) as a
// resizable overlay panel that stays open while you move between tools.
//
// - Hidden on the assistant page itself (the full page is already chat),
//   on the legacy /dashboard/chat route, and inside split-view panes (the
//   layout's pane branch never mounts the dock).
// - Open/closed and the panel width are per-viewer, in localStorage.
// - Chat sessions are per project: the dock uses the workspace's first
//   project (the same default the assistant page uses), with the canEdit /
//   mockMode flags computed server-side in the dashboard layout.
// - Cmd/Ctrl+J toggles the dock from anywhere.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquare, X } from "lucide-react";
import { useChat } from "./ChatContext";
import AiChatPanel from "@/components/AiChatPanel";

const OPEN_KEY = "shapesos:chatdock:open";
const WIDTH_KEY = "shapesos:chatdock:width";
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
// Push mode must leave a usable work column: the sidebar takes up to 288px
// (w-72; rail mode is narrower, which only leaves more room) and the work
// area should keep at least 420px. Below that viewport the dock floats over
// the content (no push) and its width is capped to the viewport.
const NAV_W = 288;
const MIN_WORK_W = 420;
const PUSH_MIN_VW = NAV_W + MIN_WIDTH + MIN_WORK_W; // 1028
/** Routes where the dock would duplicate the page's own chat. */
const HIDDEN_PREFIXES = ["/dashboard/assistant", "/dashboard/chat"];

export interface ChatDockProject {
  id: string;
  domain: string;
}

export function ChatDock({
  project,
  canEdit,
  mockMode,
  workspaceId,
}: {
  /** Default project (workspace's first), or null when none exists yet. */
  project: ChatDockProject | null;
  canEdit: boolean;
  mockMode: boolean;
  workspaceId: string;
}) {
  const pathname = usePathname();
  const { setSession } = useChat();
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  // Live viewport width for the push/overlay fallback (0 until measured on
  // the client; an unmeasured first paint keeps the desktop default).
  const [vw, setVw] = useState(0);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const measure = () => setVw(window.innerWidth);
    const id = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Per-viewer panel state (client-only; first paint matches the server).
  useEffect(() => {
    // Deferred a frame so the first client paint still matches the server.
    const id = requestAnimationFrame(() => {
      try {
        setOpen(window.localStorage.getItem(OPEN_KEY) === "1");
        const w = Number(window.localStorage.getItem(WIDTH_KEY));
        if (Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) setWidth(w);
      } catch {
        // storage unavailable: defaults
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const hidden = !project || HIDDEN_PREFIXES.some((p) => pathname.startsWith(p));

  // Wide desktop: push the work aside at the chosen width (clamped so the
  // work column never drops below MIN_WORK_W). Narrow desktop: float over
  // the content instead, capped to the viewport with a small gutter.
  const push = vw === 0 || vw >= PUSH_MIN_VW;
  const effWidth =
    vw === 0
      ? width
      : push
        ? Math.min(width, Math.max(MIN_WIDTH, vw - NAV_W - MIN_WORK_W))
        : Math.min(width, Math.max(MIN_WIDTH, vw - 32));

  // The dock owns the chat session while it is open. The assistant page sets
  // and clears its own session around its mount; the dock is hidden there,
  // so the two never fight over the provider.
  useEffect(() => {
    if (!open || hidden || !project) return;
    setSession({ projectId: project.id, projectDomain: project.domain, canEdit, mockMode });
    return () => setSession(null);
  }, [open, hidden, project, canEdit, mockMode, setSession]);

  // Beside the work on wide desktop, over it on narrow: while pushing, the
  // dock publishes its effective width on the root and the shell's main
  // column (data-shell-main) shifts left by the same amount (globals.css,
  // md+ only). In overlay mode nothing is published, so the column keeps
  // the full width beneath the floating dock.
  useEffect(() => {
    const root = document.documentElement;
    if (!open || hidden || !push) {
      delete root.dataset.chatDock;
      root.style.removeProperty("--chat-dock-w");
      return;
    }
    root.dataset.chatDock = "open";
    root.style.setProperty("--chat-dock-w", `${effWidth}px`);
    return () => {
      delete root.dataset.chatDock;
      root.style.removeProperty("--chat-dock-w");
    };
  }, [open, hidden, push, effWidth]);

  const setOpenPersist = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // best effort
    }
  }, []);

  // Cmd/Ctrl+J toggles the dock from anywhere on the dashboard.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpenPersist(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, open, setOpenPersist]);

  // Drag the left edge to resize (320-720px), width persists per viewer.
  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startWidth: width };
      const onMove = (ev: PointerEvent) => {
        if (!drag.current) return;
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.current.startWidth + (drag.current.startX - ev.clientX)));
        drag.current.startWidth = next;
        drag.current.startX = ev.clientX;
        setWidth(next);
      };
      const onUp = () => {
        if (drag.current) {
          try {
            const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.current.startWidth));
            window.localStorage.setItem(WIDTH_KEY, String(w));
          } catch {
            // best effort
          }
        }
        drag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width],
  );

  if (hidden) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpenPersist(true)}
        aria-label="Open chat"
        title="Chat (⌘J)"
        className="fixed right-4 bottom-4 z-40 hidden items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-paper shadow-overlay transition-transform duration-150 hover:scale-[1.03] active:scale-[0.97] md:flex"
      >
        <MessageSquare className="size-4" aria-hidden />
        Chat
      </button>
    );
  }

  return (
    <aside
      aria-label="Chat"
      className="fixed inset-y-0 right-0 z-40 hidden md:flex"
      style={{ width: effWidth }}
    >
      {/* Resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        onPointerDown={onHandleDown}
        className="w-1.5 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-line-strong"
      />
      <div className="flex min-w-0 flex-1 flex-col border-l border-line bg-canvas shadow-overlay">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <MessageSquare className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-ink">{project.domain}</span>
          <button
            type="button"
            onClick={() => setOpenPersist(false)}
            aria-label="Close chat"
            title="Close chat (⌘J)"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <AiChatPanel workspaceId={workspaceId} />
        </div>
      </div>
    </aside>
  );
}
