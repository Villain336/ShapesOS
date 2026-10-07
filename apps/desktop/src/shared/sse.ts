// ShapesOS Desktop: a small, strict Server-Sent Events client.
//
// The server writes events with lib/http/sse.ts: `retry:` first, `event:` +
// one or more `data:` lines per event, a blank line between events, `: ping`
// comments every 15 s, and possibly `event: reconnect` when a replica drains.
// SseParser turns arbitrary byte chunks into whole messages (WHATWG
// "event stream interpretation"); parseTurnEvent validates one message
// against the /api/cursor/turn contract and drops anything malformed, so
// the rest of the app never sees an unchecked shape.

import type { Point2, TurnEvent } from "./contract";

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private lastId: string | null = null;
  private decoder = new TextDecoder("utf-8");
  /** The most recent `retry:` value the server sent (ms). */
  retryMs: number | null = null;
  /** Count of `:` comment lines (heartbeats) seen. */
  comments = 0;

  /** Feed a chunk; returns every message completed by it. */
  push(chunk: Uint8Array | string): SseMessage[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone "\r" at the very end may be the first half of "\r\n".
      if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  /** Flush at end of stream: a final event without its blank line is dropped (per spec). */
  end(): SseMessage[] {
    this.buffer = "";
    this.dataLines = [];
    this.eventName = "";
    return [];
  }

  private line(line: string): SseMessage | null {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventName = "";
        return null;
      }
      const msg: SseMessage = {
        event: this.eventName || "message",
        data: this.dataLines.join("\n"),
        id: this.lastId,
      };
      this.eventName = "";
      this.dataLines = [];
      return msg;
    }
    if (line.startsWith(":")) {
      this.comments += 1;
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break; // unknown fields are ignored (spec)
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";

function points(v: unknown): Point2[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 32) return null;
  const out: Point2[] = [];
  for (const p of v) {
    if (!isRec(p) || !num(p.x) || !num(p.y)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Validate one SSE message from /api/cursor/turn. Unknown or malformed → null. */
export function parseTurnEvent(msg: SseMessage): TurnEvent | null {
  let d: unknown;
  try {
    d = JSON.parse(msg.data);
  } catch {
    return null;
  }
  if (!isRec(d)) return null;
  switch (msg.event) {
    case "turn_started":
      if (!str(d.runId) || !str(d.conversationId)) return null;
      return d.mock === true
        ? { type: "turn_started", runId: d.runId, conversationId: d.conversationId, mock: true }
        : { type: "turn_started", runId: d.runId, conversationId: d.conversationId };
    case "text_delta":
      return str(d.text) ? { type: "text_delta", text: d.text } : null;
    case "point": {
      const label = str(d.label) ? d.label : "";
      if (str(d.elementId) && d.elementId) return { type: "point", elementId: d.elementId, label };
      if (num(d.screen) && Number.isInteger(d.screen) && d.screen >= 0 && num(d.x) && num(d.y)) {
        return { type: "point", screen: d.screen, x: d.x, y: d.y, label };
      }
      return null;
    }
    case "draw": {
      const kind = d.kind;
      if (kind !== "circle" && kind !== "arrow" && kind !== "step") return null;
      if (!num(d.screen) || !Number.isInteger(d.screen) || d.screen < 0) return null;
      const pts = points(d.points);
      if (!pts) return null;
      if (kind === "arrow" && pts.length < 2) return null;
      const ev: TurnEvent = { type: "draw", kind, screen: d.screen, points: pts };
      if (num(d.step)) ev.step = d.step;
      if (str(d.label)) ev.label = d.label;
      return ev;
    }
    case "proposal": {
      if (!str(d.approvalId) || !str(d.tool) || !str(d.summary)) return null;
      if (d.tier !== 0 && d.tier !== 1 && d.tier !== 2 && d.tier !== 3) return null;
      if (!bool(d.destructive) || !bool(d.voiceApprovable)) return null;
      const ev: TurnEvent = {
        type: "proposal",
        approvalId: d.approvalId,
        tool: d.tool,
        summary: d.summary,
        tier: d.tier,
        destructive: d.destructive,
        // Defence in depth: the client never trusts a voiceApprovable=true
        // for Tier 3 or destructive work, whatever the server says.
        voiceApprovable: d.voiceApprovable && d.tier !== 3 && !d.destructive,
      };
      if (str(d.elementId)) ev.elementId = d.elementId;
      return ev;
    }
    case "dictation":
      return str(d.text) && d.text.trim() ? { type: "dictation", text: d.text } : null;
    case "agent_started":
      return str(d.runId) && num(d.maxUsd) ? { type: "agent_started", runId: d.runId, maxUsd: d.maxUsd } : null;
    case "error":
      return {
        type: "error",
        code: str(d.code) ? d.code : "unknown",
        message: str(d.message) ? d.message : "Something went wrong.",
      };
    case "done": {
      const u = isRec(d.usage) ? d.usage : {};
      return {
        type: "done",
        usage: {
          credits: num(u.credits) ? u.credits : 0,
          inputTokens: num(u.inputTokens) ? u.inputTokens : 0,
          outputTokens: num(u.outputTokens) ? u.outputTokens : 0,
        },
      };
    }
    default:
      return null;
  }
}

/** Read a fetch Response body as SSE messages. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      for (const m of parser.push(value)) yield m;
    }
  } finally {
    // The consumer stopped early (stop key, abort): close the connection.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
