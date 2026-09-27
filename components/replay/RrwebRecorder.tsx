// Marketr — Phase 12 "embeds": rrweb session recorder (MIT) for the
// public share page (/s/[token]). Rendered ONLY when the share link was
// created with replay opt-in. Lazy-loads rrweb, masks ALL inputs and
// selections, and ships events in small batches to the ingest API.

"use client";

import { useEffect, useRef } from "react";

const BATCH_SIZE = 50;
const FLUSH_MS = 5000;

export function RrwebRecorder({ token }: { token: string }) {
  const stopped = useRef(false);

  useEffect(() => {
    let stopFn: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const queue: Array<Record<string, unknown>> = [];

    async function flush() {
      if (queue.length === 0 || stopped.current) return;
      const batch = queue.splice(0, BATCH_SIZE);
      try {
        await fetch(`/api/s/${encodeURIComponent(token)}/replay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive: true,
        });
      } catch {
        // Best-effort: replay is observability, not the product. Drop the
        // batch rather than retrying forever from a public page.
      }
    }

    (async () => {
      try {
        const { record } = await import("rrweb");
        if (stopped.current) return;
        stopFn = record({
          emit(event) {
            queue.push(event as unknown as Record<string, unknown>);
            if (queue.length >= BATCH_SIZE) void flush();
          },
          // PII posture: mask every input; text uses maskTextClass for
          // targeted masking (rr-block hides whole subtrees).
          maskAllInputs: true,
          blockClass: "rr-block",
          maskTextClass: "rr-mask",
          slimDOMOptions: {},
        });
        timer = setInterval(() => void flush(), FLUSH_MS);
        window.addEventListener("beforeunload", () => void flush());
      } catch {
        // rrweb failed to load — the page works fine without replay.
      }
    })();

    return () => {
      stopped.current = true;
      if (timer) clearInterval(timer);
      if (stopFn) stopFn();
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return null;
}
