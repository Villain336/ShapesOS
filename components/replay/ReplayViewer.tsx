// Marketr — replay viewer client (Phase 12 "embeds", rrweb).
// Session picker + lazy-loaded rrweb Replayer. Events arrive from the
// tenant-scoped session API; the Replayer only ever sees events for a
// session the workspace owns.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MonitorPlay } from "lucide-react";

interface SessionInfo {
  id: string;
  startedAt: string;
  endedAt: string | null;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" };

export function ReplayViewer({
  token,
  eventsBase,
  sessions,
  initialSessionId,
}: {
  token: string;
  /** Override for the events endpoint base (defaults to the public token-bound route). */
  eventsBase?: string;
  sessions: SessionInfo[];
  initialSessionId: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(
    initialSessionId ?? sessions[0]?.id ?? null,
  );
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<{ pause: () => void } | null>(null);

  const load = useCallback(
    async (sessionId: string) => {
      setState({ kind: "loading" });
      playerRef.current?.pause();
      if (mountRef.current) mountRef.current.innerHTML = "";
      try {
        const base =
          eventsBase ?? `/api/s/${encodeURIComponent(token)}/replay`;
        const res = await fetch(
          `${base}/${encodeURIComponent(sessionId)}`,
        );
        const json = (await res.json()) as {
          events?: Array<Record<string, unknown>>;
          error?: string;
        };
        if (!res.ok || !json.events) {
          setState({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
          return;
        }
        if (json.events.length === 0) {
          setState({ kind: "empty" });
          return;
        }
        const { Replayer } = await import("rrweb");
        if (!mountRef.current) {
          setState({ kind: "error", message: "Viewer unmounted." });
          return;
        }
        const player = new Replayer(json.events as never, {
          root: mountRef.current,
        });
        playerRef.current = player;
        player.play();
        setState({ kind: "idle" });
      } catch (e) {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load replay.",
        });
      }
    },
    [token, eventsBase],
  );

  useEffect(() => {
    if (selected) void load(selected);
    return () => {
      playerRef.current?.pause();
      playerRef.current = null;
    };
  }, [selected, load]);

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
        <MonitorPlay className="mx-auto h-8 w-8 text-subtle" />
        <p className="mt-3 text-[0.8125rem] text-muted">
          No recordings yet. Recordings appear here once someone views this
          share link.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="replay-session" className="text-[0.8125rem] font-medium text-ink">
          Session
        </label>
        <select
          id="replay-session"
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2.5 text-[0.8125rem] text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.startedAt).toLocaleString()} — {s.id.slice(0, 8)}
              {s.endedAt ? "" : " (live)"}
            </option>
          ))}
        </select>
      </div>

      {state.kind === "loading" && (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline text-sm text-muted">
          Loading recording…
        </div>
      )}
      {state.kind === "error" && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-failed-tint p-4 text-[0.8125rem] text-failed-text">
          <span className="aos-shape aos-shape--failed mt-1 shrink-0" aria-hidden="true" />
          {state.message}
        </div>
      )}
      {state.kind === "empty" && (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline text-[0.8125rem] text-muted">
          This session captured no events.
        </div>
      )}
      <div
        ref={mountRef}
        className="min-h-[320px] overflow-hidden rounded-lg bg-paper shadow-hairline"
      />
    </div>
  );
}
