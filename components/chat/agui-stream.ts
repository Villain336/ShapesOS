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
}

/** Split an SSE byte stream into parsed `data:` frames. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<AguiFrame> {
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
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as AguiFrame;
        } catch {
          // a malformed frame is skipped
        }
      }
    }
  } finally {
    reader.releaseLock();
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
}

export function emptyStreamingTurn(): StreamingTurn {
  return { messages: [], activeTool: null, error: null, queued: false, done: false };
}

/** Fold one AG-UI frame into the streaming view (returns a new object). */
export function foldAguiEvent(turn: StreamingTurn, ev: AguiFrame): StreamingTurn {
  switch (ev.type) {
    case "TEXT_MESSAGE_START":
      if (!ev.messageId || turn.messages.some((m) => m.id === ev.messageId)) return turn;
      return { ...turn, activeTool: null, messages: [...turn.messages, { id: ev.messageId, text: "" }] };
    case "TEXT_MESSAGE_CONTENT": {
      if (!ev.messageId || !ev.delta) return turn;
      const has = turn.messages.some((m) => m.id === ev.messageId);
      const messages = has
        ? turn.messages.map((m) => (m.id === ev.messageId ? { ...m, text: m.text + ev.delta } : m))
        : [...turn.messages, { id: ev.messageId, text: ev.delta }];
      return { ...turn, messages };
    }
    case "TOOL_CALL_START":
      return { ...turn, activeTool: ev.toolCallName ?? null };
    case "TOOL_CALL_RESULT":
      return { ...turn, activeTool: null };
    case "CUSTOM":
      return ev.name === "marketr.queued" ? { ...turn, queued: true } : turn;
    case "RUN_ERROR":
      return { ...turn, error: ev.message ?? "The agent turn failed", done: true };
    case "RUN_FINISHED":
      return { ...turn, done: true, activeTool: null };
    default:
      return turn;
  }
}
