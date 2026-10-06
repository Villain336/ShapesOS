// ShapesOS — Phase 13 (twinui): keeps a twin snapshot live.
//
// Subscribes to TWIN_API.live (EventSource): `snapshot` frames replace the
// state, `patch` frames are RFC 6902 ops applied with the data side's applier
// (lib/twin/derive.ts, guarded by view-model applyLivePatch) — a
// patch that doesn't resolve triggers a resync from TWIN_API.state. When the
// stream errors repeatedly it falls back to polling TWIN_API.state through
// sharedJson every TWIN_LIVE_POLL_MS, and retries the stream every minute.
// Status for the top bar: "live" | "reconnecting" | "polling" ("off" when disabled).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyLivePatch } from "@/lib/twin/view-model";
import { TWIN_API, TWIN_LIVE_POLL_MS, type TwinPatchOp, type TwinSnapshot } from "@/lib/twin/types";
import { sharedJson } from "@/lib/ui/shared-fetch";

/**
 * "off" (shown as "Snapshot"): not live — disabled, or (Phase 14) the stream
 * ended for good (access revoked: e.g. a published site went back to draft
 * for a viewer; or the site is gone). The last snapshot stays on screen.
 * Every member gets live updates since Phase 14 (published sites).
 */
export type TwinLiveStatus = "live" | "reconnecting" | "polling" | "off";

/** Phase 14: stream end reasons after which reconnecting can't help. */
const FINAL_END_REASONS = new Set(["access-revoked", "site-gone"]);

function looksLikeSnapshot(v: unknown): v is TwinSnapshot {
  const s = v as TwinSnapshot | null;
  return !!s && typeof s === "object" && !!s.site && typeof s.site.id === "string" && Array.isArray(s.objects) && Array.isArray(s.kpis);
}

export function useTwinLive(initial: TwinSnapshot, opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const siteId = initial.site.id;
  const [snapshot, setSnapshot] = useState<TwinSnapshot>(initial);
  const [status, setStatus] = useState<TwinLiveStatus>("reconnecting");
  const [ended, setEnded] = useState(false);
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  // A new site (switcher) starts from its server snapshot.
  useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  // Phase 17 (latency): the polling fallback asks the cheap change signal
  // first and fetches the full snapshot only when the version moved.
  const versionRef = useRef<string | null>(null);
  const pollTick = useCallback(async () => {
    const r = await sharedJson(TWIN_API.signal(siteId), { fresh: true }).catch(() => null);
    const version = r?.ok ? ((r.body as { version?: unknown } | null)?.version ?? null) : null;
    if (typeof version === "string" && version === versionRef.current) return;
    versionRef.current = typeof version === "string" ? version : null;
    await resyncRef.current();
  }, [siteId]);

  const resync = useCallback(async () => {
    const r = await sharedJson(TWIN_API.state(siteId), { fresh: true }).catch(() => null);
    const body = r?.ok ? (r.body as { snapshot?: unknown } | TwinSnapshot | null) : null;
    const snap = looksLikeSnapshot(body) ? body : looksLikeSnapshot((body as { snapshot?: unknown } | null)?.snapshot) ? (body as { snapshot: TwinSnapshot }).snapshot : null;
    if (snap) setSnapshot(snap);
    return !!snap;
  }, [siteId]);
  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let es: EventSource | null = null;
    let errors = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };
    const startPolling = () => {
      if (closed) return;
      setStatus("polling");
      if (!pollTimer) {
        versionRef.current = null;
        void pollTick();
        pollTimer = setInterval(() => void pollTick(), TWIN_LIVE_POLL_MS);
      }
      // keep trying the stream once a minute while polling
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        errors = 0;
        connect();
      }, 60_000);
    };

    function connect() {
      if (closed) return;
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      es?.close();
      es = new EventSource(TWIN_API.live(siteId));
      es.addEventListener("open", () => {
        errors = 0;
        stopPolling();
        if (retryTimer) clearTimeout(retryTimer);
        setStatus("live");
      });
      es.addEventListener("snapshot", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as unknown;
          if (looksLikeSnapshot(data)) setSnapshot(data);
          setStatus("live");
        } catch {
          void resync();
        }
      });
      es.addEventListener("patch", (ev) => {
        try {
          const ops = JSON.parse((ev as MessageEvent).data) as TwinPatchOp[];
          const next = applyLivePatch(snapRef.current, ops);
          if (next) setSnapshot(next);
          else void resync();
        } catch {
          void resync();
        }
      });
      // Deploy PR: the server is shutting down (lib/http/sse.ts drain) —
      // reconnect right away; the load balancer picks a live replica and the
      // new stream starts with a fresh snapshot.
      es.addEventListener("reconnect", () => {
        es?.close();
        es = null;
        setStatus("reconnecting");
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, 100 + Math.round(Math.random() * 400));
      });
      es.addEventListener("end", (ev) => {
        es?.close();
        let reason = "";
        try {
          reason = String((JSON.parse((ev as MessageEvent).data ?? "{}") as { reason?: unknown }).reason ?? "");
        } catch {
          reason = "";
        }
        // Phase 14: access revoked / site gone — stop; keep the last snapshot.
        if (FINAL_END_REASONS.has(reason)) {
          closed = true;
          es = null;
          stopPolling();
          if (retryTimer) clearTimeout(retryTimer);
          setEnded(true);
          return;
        }
        // max duration reached server-side: reconnect for a fresh stream
        setStatus("reconnecting");
        retryTimer = setTimeout(connect, 500);
      });
      es.addEventListener("error", () => {
        errors += 1;
        if (es?.readyState === EventSource.CLOSED || errors >= 3) {
          es?.close();
          es = null;
          startPolling();
        } else if (!pollTimer) {
          setStatus("reconnecting");
        }
      });
    }

    connect();
    return () => {
      closed = true;
      es?.close();
      stopPolling();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, siteId, resync, pollTick]);

  return { snapshot, status: enabled && !ended ? status : ("off" as TwinLiveStatus), resync, setSnapshot };
}
