// ShapesOS — Deploy PR (WS=state): one resilient EventSource client for the
// dashboard's live streams (run watch, delegation plan; the twin keeps its
// own polling fallback and handles `reconnect` itself).
//
// The server side (lib/http/sse.ts) sends `retry:`, `: ping` heartbeats, and
// on a deploy `event: reconnect` before it closes. This client:
//
//   * reconnects at once (with a little jitter) on `reconnect` — the load
//     balancer sends the new connection to a live replica;
//   * reconnects with exponential backoff (0.5 s → 15 s, jittered) when the
//     connection drops, and gives up after `maxFailures` consecutive failed
//     attempts — or after `maxInitialFailures` when it never opened (the
//     stream does not exist: a 404 looks the same as a network error to
//     EventSource);
//   * resumes from the last event id it saw (?lastEventId=, which the server
//     reads alongside the Last-Event-ID header) — streams without ids simply
//     start with a fresh snapshot;
//   * stops for good on `end` unless onEnd says to reconnect.
//
// Framework-free (no React) and injectable, so it is unit-tested with a fake
// EventSource.

export type LiveStreamState = "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface LiveStreamOptions {
  /** Handlers per event name (data is the raw string). */
  events: Record<string, (data: string) => void>;
  /** `end` event: stop (default) or reconnect for a fresh stream. */
  onEnd?: (data: string) => "stop" | "reconnect";
  onState?: (state: LiveStreamState) => void;
  /** Consecutive failed attempts (after having been open) before giving up. */
  maxFailures?: number;
  /** Failed attempts before the first successful open before giving up. */
  maxInitialFailures?: number;
  /** Delay before reconnect attempt `n` (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Test seams. */
  EventSourceImpl?: new (url: string) => EventSourceLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  random?: () => number;
}

export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, fn: (ev: { data?: string; lastEventId?: string }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export function defaultBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

/** URL with the resume cursor appended (?lastEventId= / &lastEventId=). */
export function withLastEventId(url: string, lastEventId: string | null): string {
  if (!lastEventId) return url;
  return `${url}${url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(lastEventId)}`;
}

export function openLiveStream(url: string, opts: LiveStreamOptions): { close(): void; readonly lastEventId: string | null } {
  const ES = opts.EventSourceImpl ?? (globalThis as unknown as { EventSource: new (u: string) => EventSourceLike }).EventSource;
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = opts.random ?? Math.random;
  const backoff = opts.backoffMs ?? ((n: number) => defaultBackoffMs(n, random));
  const maxFailures = opts.maxFailures ?? 6;
  const maxInitial = opts.maxInitialFailures ?? 2;

  let es: EventSourceLike | null = null;
  let stopped = false;
  let openedOnce = false;
  let failures = 0;
  let timer: unknown = null;
  let lastEventId: string | null = null;

  const state = (s: LiveStreamState) => opts.onState?.(s);
  const dropCurrent = () => {
    if (es) {
      es.onerror = null;
      es.onopen = null;
      es.close();
      es = null;
    }
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearT(timer);
    timer = setT(() => {
      timer = null;
      connect();
    }, ms);
  };
  const stop = (final: LiveStreamState) => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearT(timer);
    dropCurrent();
    state(final);
  };

  function connect() {
    if (stopped) return;
    dropCurrent();
    state(openedOnce ? "reconnecting" : "connecting");
    const src = new ES(withLastEventId(url, lastEventId));
    es = src;
    src.onopen = () => {
      openedOnce = true;
      failures = 0;
      state("open");
    };
    const track = (ev: { lastEventId?: string }) => {
      if (ev.lastEventId) lastEventId = ev.lastEventId;
    };
    for (const [name, handler] of Object.entries(opts.events)) {
      src.addEventListener(name, (ev) => {
        track(ev);
        handler(ev.data ?? "");
      });
    }
    src.addEventListener("reconnect", (ev) => {
      // The server is shutting down: go to another replica right away.
      track(ev);
      dropCurrent();
      schedule(100 + Math.round(random() * 400));
    });
    src.addEventListener("end", (ev) => {
      const next = opts.onEnd?.(ev.data ?? "") ?? "stop";
      if (next === "reconnect") {
        dropCurrent();
        schedule(250);
      } else {
        stop("closed");
      }
    });
    src.onerror = () => {
      if (es !== src) return;
      dropCurrent();
      failures += 1;
      if (failures >= (openedOnce ? maxFailures : maxInitial)) {
        stop("failed");
        return;
      }
      state("reconnecting");
      schedule(backoff(failures));
    };
  }

  connect();
  return {
    close: () => stop("closed"),
    get lastEventId() {
      return lastEventId;
    },
  };
}
