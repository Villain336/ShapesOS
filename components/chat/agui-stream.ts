// ShapesOS — Phase 8: read the AG-UI SSE stream of a chat turn (PURE, no React).
//
// POST /api/agents/chat answers text/event-stream, one `data: <json>` frame
// per AG-UI event, as the run works. The chat panel (ChatContext) feeds the
// frames through foldAguiEvent to show the assistant's text while it
// arrives, then re-reads the thread for the authoritative rows.

export interface AguiFrame {
  type: string;
  messageId?: string;
  delta?: string;
  message?: string;
  toolCallName?: string;
  name?: string;
  /** CUSTOM events' payload (marketr.thinking { step, state }, marketr.cached { question }). */
  value?: unknown;
}

/** One SSE event block as it arrived (comments and `retry:` lines dropped). */
export interface SseEventBlock {
  event: string | null;
  id: string | null;
  data: string;
}

/** Split an SSE byte stream into event blocks (event name, id, joined data). */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEventBlock> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: RegExpExecArray | null;
      while ((sep = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, sep.index);
        buf = buf.slice(sep.index + sep[0].length);
        let event: string | null = null;
        let id: string | null = null;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
        }
        if (!data.length) continue;
        yield { event, id, data: data.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Split an SSE byte stream into parsed AG-UI `data:` frames (default events only). */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<AguiFrame> {
  for await (const block of readSseEvents(body)) {
    if (block.event && block.event !== "message") continue;
    try {
      yield JSON.parse(block.data) as AguiFrame;
    } catch {
      // a malformed frame is skipped
    }
  }
}

/** Where a cut chat stream resumes (the server's `reconnect` payload). */
export interface ChatResumePoint {
  runId: string;
  after: number;
  aguiRunId: string;
}

/** GET /api/agents/chat/stream for a resume point (Last-Event-ID carries the cursor too). */
export function chatResumeUrl(p: ChatResumePoint): string {
  const q = new URLSearchParams({ runId: p.runId, aguiRunId: p.aguiRunId, after: String(p.after) });
  return `/api/agents/chat/stream?${q.toString()}`;
}

/**
 * Deploy PR: the frames of one chat turn, across server restarts. Reads the
 * POST response; when the server says `event: reconnect` (it is shutting
 * down; the turn went to the worker) — or the stream is cut before
 * RUN_FINISHED / RUN_ERROR after the run id is known — it resumes on
 * GET /api/agents/chat/stream (any replica) from the last event id, with
 * backoff, at most `maxResumes` times in a row without progress.
 */
export async function* streamChatFrames(
  body: ReadableStream<Uint8Array>,
  opts: {
    fetchResume: (url: string, lastEventId: string | null) => Promise<Response>;
    maxResumes?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): AsyncGenerator<AguiFrame> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxResumes = opts.maxResumes ?? 5;
  let current: ReadableStream<Uint8Array> | null = body;
  let lastId: string | null = null;
  let aguiRunId: string | null = null;
  let resume: ChatResumePoint | null = null;
  let failures = 0;
  for (;;) {
    let finished = false;
    let progressed = false;
    resume = null;
    if (current) {
      for await (const block of readSseEvents(current)) {
        if (block.event === "reconnect") {
          try {
            const p = JSON.parse(block.data) as Partial<ChatResumePoint>;
            if (typeof p.runId === "string" && p.runId) {
              resume = { runId: p.runId, after: typeof p.after === "number" ? p.after : -1, aguiRunId: String(p.aguiRunId ?? aguiRunId ?? "") };
            }
          } catch {
            // fall back to the last id below
          }
          break;
        }
        if (block.event && block.event !== "message") continue;
        if (block.id) lastId = block.id;
        let frame: AguiFrame & { metadata?: { marketr?: { runId?: unknown } } };
        try {
          frame = JSON.parse(block.data);
        } catch {
          continue;
        }
        progressed = true;
        const meta = frame.metadata?.marketr?.runId;
        if (!aguiRunId && typeof meta === "string") aguiRunId = meta;
        if (frame.type === "RUN_FINISHED" || frame.type === "RUN_ERROR") finished = true;
        yield frame;
      }
    }
    if (finished) return;
    if (!resume && lastId && aguiRunId) {
      // Cut without a goodbye (crash, proxy timeout): resume from the last id.
      const m = /^(.+):(-?\d+)$/.exec(lastId);
      if (m) resume = { runId: m[1]!, after: Number(m[2]), aguiRunId };
    }
    if (resume && !aguiRunId && resume.aguiRunId) aguiRunId = resume.aguiRunId;
    if (!resume || !resume.aguiRunId) return;
    if (resume.after >= 0) lastId = `${resume.runId}:${resume.after}`;
    failures = progressed ? 0 : failures + 1;
    if (failures >= maxResumes) return;
    // A deploy's reconnect goes at once; repeated failures back off.
    if (failures > 0) await sleep(Math.min(8_000, 500 * 2 ** (failures - 1)));
    let res: Response | null = null;
    try {
      res = await opts.fetchResume(chatResumeUrl(resume), lastId);
    } catch {
      res = null;
    }
    if (res && res.status === 404) return;
    current = res && res.ok && res.body ? res.body : null;
  }
}

/** The live view of one streaming turn. */
export interface StreamingTurn {
  /** Assistant text per AG-UI message, in arrival order. */
  messages: Array<{ id: string; text: string }>;
  /** The tool currently running (shown while no text arrives). */
  activeTool: string | null;
  error: string | null;
  queued: boolean;
  done: boolean;
  /** Phase 17: the first frame (RUN_STARTED) arrived — the server took the turn. */
  started: boolean;
  /** Phase 17: the model is reasoning before it writes (marketr.thinking). */
  thinking: boolean;
  /** Phase 17: the answer was reused from the answer cache (marketr.cached). */
  cached: boolean;
}

export function emptyStreamingTurn(): StreamingTurn {
  return { messages: [], activeTool: null, error: null, queued: false, done: false, started: false, thinking: false, cached: false };
}

/** Fold one AG-UI frame into the streaming view (returns a new object). */
export function foldAguiEvent(turn: StreamingTurn, ev: AguiFrame): StreamingTurn {
  switch (ev.type) {
    case "RUN_STARTED":
      return turn.started ? turn : { ...turn, started: true };
    case "TEXT_MESSAGE_START":
      if (!ev.messageId || turn.messages.some((m) => m.id === ev.messageId)) return turn;
      return { ...turn, activeTool: null, thinking: false, messages: [...turn.messages, { id: ev.messageId, text: "" }] };
    case "TEXT_MESSAGE_CONTENT": {
      if (!ev.messageId || !ev.delta) return turn;
      const has = turn.messages.some((m) => m.id === ev.messageId);
      const messages = has
        ? turn.messages.map((m) => (m.id === ev.messageId ? { ...m, text: m.text + ev.delta } : m))
        : [...turn.messages, { id: ev.messageId, text: ev.delta }];
      return { ...turn, messages, thinking: false };
    }
    case "TOOL_CALL_START":
      return { ...turn, activeTool: ev.toolCallName ?? null, thinking: false };
    case "TOOL_CALL_RESULT":
      return { ...turn, activeTool: null };
    case "CUSTOM": {
      if (ev.name === "marketr.queued") return { ...turn, queued: true };
      if (ev.name === "marketr.thinking") {
        const state = (ev.value as { state?: unknown } | null)?.state;
        return { ...turn, thinking: state === "started" };
      }
      if (ev.name === "marketr.cached") return { ...turn, cached: true };
      return turn;
    }
    case "RUN_ERROR":
      return { ...turn, error: ev.message ?? "The agent turn failed", done: true, thinking: false };
    case "RUN_FINISHED":
      return { ...turn, done: true, activeTool: null, thinking: false };
    default:
      return turn;
  }
}

// ── Phase 17: the optimistic turn (PURE; ChatContext applies it) ────────────

/** The chat panel's message shape (mirrors ChatContext's ChatMessage). */
export interface TurnMessage {
  id: string;
  role: string;
  content: string;
  toolCalls: readonly unknown[] | null;
  createdAt: string;
}

/** The sent text shows at once (an optimistic user row); nothing waits for the network. */
export function optimisticSend<M extends TurnMessage>(messages: readonly M[], text: string, opts: { id?: string; now?: () => number } = {}): { messages: M[]; optimisticId: string } {
  const now = opts.now ?? Date.now;
  const optimisticId = opts.id ?? `tmp-${now()}`;
  const row = { id: optimisticId, role: "user", content: text, toolCalls: null, createdAt: new Date(now()).toISOString() } as M;
  return { messages: [...messages.filter((m) => m.id !== optimisticId), row], optimisticId };
}

/** The live assistant bubbles of a streaming turn, replacing the previous live ones. */
export function reconcileLive<M extends TurnMessage>(messages: readonly M[], turn: StreamingTurn, startedAt: string): M[] {
  const bubbles = turn.messages
    .filter((m) => m.text.trim())
    .map((m) => ({ id: `live-${m.id}`, role: "assistant", content: m.text, toolCalls: null, createdAt: startedAt }) as M);
  return [...messages.filter((m) => !m.id.startsWith("live-")), ...bubbles];
}

/**
 * The muted status line under the transcript while a turn is in flight —
 * agent states only (running), never decoration. Null once the turn is over
 * or text is streaming (the text itself is the feedback).
 *   sending   the request left the composer; no frame yet
 *   working   the server took the turn (RUN_STARTED)
 *   thinking  the model reasons before it writes
 *   tool      a tool runs ("Running get_keywords")
 *   queued    handed to the worker; the stream keeps following it
 *   cached    reused a recent answer
 */
export function liveStatusLine(turn: StreamingTurn | null, sending: boolean): { label: string; live: boolean } | null {
  if (!sending) return null;
  const t = turn ?? emptyStreamingTurn();
  if (t.done) return null;
  if (t.cached) return { label: "Reusing a recent answer", live: true };
  if (t.activeTool) return { label: `Running ${t.activeTool.replace(/^connector__/, "").replace(/_/g, " ")}`, live: true };
  if (t.thinking) return { label: "Thinking", live: true };
  if (t.messages.some((m) => m.text.trim())) return null;
  if (t.queued) return { label: "Working in the background", live: true };
  if (t.started) return { label: "Working", live: true };
  return { label: "Sending", live: true };
}
