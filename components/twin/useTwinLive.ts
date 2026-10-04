// ShapesOS — Phase 13 (twinui): keeps a twin snapshot live.
//
// Subscribes to TWIN_API.live (EventSource): `snapshot` frames replace the
// state, `patch` frames are RFC 6902 ops applied with lib/twin/patch.ts — a
// patch that doesn't resolve triggers a resync from TWIN_API.state. When the
// stream errors repeatedly it falls back to polling TWIN_API.state through
// sharedJson every TWIN_LIVE_POLL_MS, and retries the stream every minute.
// Status for the top bar: "live" | "reconnecting" | "polling".

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { applyTwinPatch } from "@/lib/twin/patch";
import { TWIN_API, TWIN_LIVE_POLL_MS, type TwinPatchOp, type TwinSnapshot } from "@/lib/twin/types";
import { sharedJson } from "@/lib/ui/shared-fetch";

export type TwinLiveStatus = "live" | "reconnecting" | "polling";

function looksLikeSnapshot(v: unknown): v is TwinSnapshot {
  const s = v as TwinSnapshot | null;
  return !!s && typeof s === "object" && !!s.site && typeof s.site.id === "string" && Array.isArray(s.objects) && Array.isArray(s.kpis);
}

export function useTwinLive(initial: TwinSnapshot, opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled ?? true;
  const siteId = initial.site.id;
  const [snapshot, setSnapshot] = useState<TwinSnapshot>(initial);
  const [status, setStatus] = useState<TwinLiveStatus>("reconnecting");
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  // A new site (switcher) starts from its server snapshot.
  useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  const resync = useCallback(async () => {
    const r = await sharedJson(TWIN_API.state(siteId), { fresh: true }).catch(() => null);
    const body = r?.ok ? (r.body as { snapshot?: unknown } | TwinSnapshot | null) : null;
    const snap = looksLikeSnapshot(body) ? body : looksLikeSnapshot((body as { snapshot?: unknown } | null)?.snapshot) ? (body as { snapshot: TwinSnapshot }).snapshot : null;
    if (snap) setSnapshot(snap);
    return !!snap;
  }, [siteId]);

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
        void resync();
        pollTimer = setInterval(() => void resync(), TWIN_LIVE_POLL_MS);
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
          const r = applyTwinPatch(snapRef.current, Array.isArray(ops) ? ops : []);
          if (r.ok) setSnapshot(r.value);
          else void resync();
        } catch {
          void resync();
        }
      });
      es.addEventListener("end", () => {
        // max duration reached server-side: reconnect for a fresh stream
        es?.close();
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
  }, [enabled, siteId, resync]);

  return { snapshot, status: enabled ? status : ("polling" as TwinLiveStatus), resync, setSnapshot };
}
