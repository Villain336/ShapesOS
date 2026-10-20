// ShapesOS — Deploy PR (WS=state): the ONE Server-Sent Events helper every
// streaming route uses (run watch, delegation view, twin live, chat).
//
// What every stream gets, so it survives load balancers, CDNs and deploys:
//
//   * `retry:` first — the browser's reconnect delay (SSE_RETRY_MS).
//   * a `: ping` comment every SSE_HEARTBEAT_MS (15 s). Proxies drop idle
//     connections: Cloudflare after ~100 s, AWS CloudFront wants a byte at
//     least every 30 s, an ALB after its idle timeout (300 s). 15 s is under
//     all of them.
//   * `id:` on events that have a natural cursor (frame seq, run-event seq),
//     and lastEventIdOf(req) to resume from it: EventSource sends the last id
//     back in the Last-Event-ID header on its own reconnects; a client that
//     reconnects by hand passes ?lastEventId=.
//   * a graceful drain (lib/runtime/shutdown.ts): on SIGTERM a stream either
//     says `event: reconnect` (with `retry:`) and closes at once — the browser
//     reconnects, to another replica, with Last-Event-ID — or, in
//     "cooperative" mode, is told it is draining (ch.draining / ch.drained)
//     so it can stop at a clean boundary and send its own reconnect payload;
//     it is force-closed with `event: reconnect` after cooperativeGraceMs.
//
// Pure apart from timers (injectable clock for tests) and the shutdown
// registry (injectable too).

import { registerStream, type DrainableStream, type DrainReason } from "@/lib/runtime/shutdown";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Heartbeat interval: below Cloudflare (~100 s), CloudFront (30 s) and ALB idle limits. */
export const SSE_HEARTBEAT_MS = 15_000;
/** Reconnect delay the browser uses after a close (sent as `retry:`). */
export const SSE_RETRY_MS = 2_000;
/** A cooperative stream is force-closed this long after the drain began. */
export const SSE_COOPERATIVE_GRACE_MS = 15_000;

export interface SseClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SseClock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SseChannel {
  /** Send one event (null = the default "message" event). False once closed. */
  send(event: string | null, data: unknown, opts?: { id?: string | null }): boolean;
  /** Send a comment line (ignored by EventSource; keeps the connection busy). */
  comment(text?: string): void;
  /** The Last-Event-ID the client resumed from (header or ?lastEventId=). */
  readonly lastEventId: string | null;
  readonly closed: boolean;
  /** True once the process started draining. */
  readonly draining: boolean;
  /** Resolves when the process starts draining. */
  readonly drained: Promise<void>;
  /** Aborted when the stream closes for any reason (client gone, drain, end). */
  readonly signal: AbortSignal;
  /** Tell the client to reconnect (optionally with data) and close. */
  reconnect(data?: unknown): void;
  close(): void;
}

export interface SseOptions {
  lastEventId?: string | null;
  /** Heartbeat interval (ms); never above SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
  retryMs?: number;
  /** "reconnect" (default): close at once on drain. "cooperative": see header. */
  drain?: "reconnect" | "cooperative";
  cooperativeGraceMs?: number;
  /** Payload of the `reconnect` event the helper sends itself. */
  reconnectData?: () => unknown;
  clock?: SseClock;
  /** Shutdown registry (tests inject one). */
  register?: (s: DrainableStream) => () => void;
}

/** Format one SSE event block (multi-line data becomes several data: lines). */
export function formatSseEvent(event: string | null, data: unknown, id?: string | null): string {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  let out = "";
  if (id !== undefined && id !== null && id !== "") out += `id: ${String(id).replace(/[\r\n]/g, "")}\n`;
  if (event) out += `event: ${event.replace(/[\r\n]/g, "")}\n`;
  for (const line of text.split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** The cursor a client resumes from: Last-Event-ID header, else ?lastEventId=. */
export function lastEventIdOf(req: Request): string | null {
  const h = req.headers.get("last-event-id");
  if (h && h.trim()) return h.trim().slice(0, 200);
  try {
    const q = new URL(req.url).searchParams.get("lastEventId");
    return q && q.trim() ? q.trim().slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** A text/event-stream body driven by `run`; closes when `run` returns. */
export function sseStream(run: (ch: SseChannel) => Promise<void> | void, opts: SseOptions = {}): ReadableStream<Uint8Array> {
  const clock = opts.clock ?? realClock;
  const heartbeatMs = Math.min(Math.max(1, opts.heartbeatMs ?? SSE_HEARTBEAT_MS), SSE_HEARTBEAT_MS);
  const retryMs = opts.retryMs ?? SSE_RETRY_MS;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let draining = false;
  let heartbeat: unknown = null;
  let forceTimer: unknown = null;
  let unregister: (() => void) | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let resolveDrained!: () => void;
  const drained = new Promise<void>((r) => (resolveDrained = r));

  const write = (chunk: string) => {
    if (closed) return false;
    try {
      controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      finish();
      return false;
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clock.clearInterval(heartbeat);
    if (forceTimer !== null) clock.clearTimeout(forceTimer);
    unregister?.();
    abort.abort();
    try {
      controller.close();
    } catch {
      // Client already gone.
    }
    resolveDone();
  };

  const reconnect = (data?: unknown) => {
    if (closed) return;
    write(`retry: ${retryMs}\n\n`);
    write(formatSseEvent("reconnect", data ?? opts.reconnectData?.() ?? { reason: "server-restart" }));
    finish();
  };

  const ch: SseChannel = {
    send: (event, data, o) => write(formatSseEvent(event, data, o?.id)),
    comment: (text = "ping") => void write(`: ${text.replace(/[\r\n]/g, " ")}\n\n`),
    lastEventId: opts.lastEventId ?? null,
    get closed() {
      return closed;
    },
    get draining() {
      return draining;
    },
    drained,
    signal: abort.signal,
    reconnect,
    close: finish,
  };

  const drainable: DrainableStream = {
    drain: (_reason: DrainReason) => {
      if (closed || draining) return;
      draining = true;
      resolveDrained();
      if (opts.drain === "cooperative") {
        forceTimer = clock.setTimeout(() => reconnect(), opts.cooperativeGraceMs ?? SSE_COOPERATIVE_GRACE_MS);
      } else {
        reconnect();
      }
    },
    done,
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      write(`retry: ${retryMs}\n\n`);
      heartbeat = clock.setInterval(() => void write(": ping\n\n"), heartbeatMs);
      unregister = (opts.register ?? registerStream)(drainable);
      void (async () => {
        try {
          await run(ch);
        } catch {
          // A failing producer ends its stream; the client reconnects or polls.
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      finish();
    },
  });
}

/** sseStream wrapped in a Response with the standard SSE headers. */
export function sseResponse(
  run: (ch: SseChannel) => Promise<void> | void,
  opts: SseOptions = {},
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(sseStream(run, opts), {
    status: init.status ?? 200,
    headers: { ...SSE_HEADERS, ...(init.headers ?? {}) },
  });
}

/** Sleep that wakes early when the stream closes (client gone / drain). */
export function sseSleep(ch: Pick<SseChannel, "signal">, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ch.signal.aborted) return resolve();
    const t = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(t);
      ch.signal.removeEventListener("abort", done);
      resolve();
    }
    ch.signal.addEventListener("abort", done, { once: true });
  });
}
