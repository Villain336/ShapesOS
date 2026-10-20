import { describe, expect, it } from "vitest";
import { parseTurnEvent, readSse, SseParser, type SseMessage } from "../../src/shared/sse";

// Exactly what lib/http/sse.ts writes: retry first, event + data lines, blank
// line, `: ping` heartbeats.
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ALL_EVENTS: [string, unknown][] = [
  ["turn_started", { runId: "run_1", conversationId: "conv_1" }],
  ["text_delta", { text: "Click Approvals " }],
  ["point", { screen: 0, x: 120.5, y: 300, label: "Approvals" }],
  ["point", { elementId: "nav:/dashboard/approvals", label: "Approvals" }],
  ["draw", { kind: "circle", screen: 1, points: [{ x: 10, y: 20 }], label: "here" }],
  ["draw", { kind: "arrow", screen: 0, points: [{ x: 1, y: 2 }, { x: 30, y: 40 }] }],
  ["draw", { kind: "step", screen: 0, points: [{ x: 5, y: 5 }], step: 2 }],
  [
    "proposal",
    { approvalId: "ap_1", tool: "invoices.create", summary: "Draft invoice", tier: 1, destructive: false, voiceApprovable: true, elementId: "kit:new" },
  ],
  ["dictation", { text: "Thanks, see you Monday." }],
  ["agent_started", { runId: "run_2", maxUsd: 3 }],
  ["error", { code: "vision_not_configured", message: "Vision isn't configured." }],
  ["done", { usage: { credits: 4, inputTokens: 1200, outputTokens: 80 } }],
];

describe("SseParser", () => {
  it("parses every contract event, across arbitrary chunk splits, with heartbeats", () => {
    const wire = "retry: 2000\n\n" + ALL_EVENTS.map(([e, d], i) => (i === 3 ? ": ping\n\n" : "") + frame(e, d)).join("");
    for (const size of [1, 3, 7, 64, wire.length]) {
      const p = new SseParser();
      const msgs: SseMessage[] = [];
      for (let i = 0; i < wire.length; i += size) msgs.push(...p.push(new TextEncoder().encode(wire.slice(i, i + size))));
      expect(msgs.map((m) => m.event)).toEqual(ALL_EVENTS.map(([e]) => e));
      expect(p.retryMs).toBe(2000);
      expect(p.comments).toBe(1);
    }
  });

  it("joins multi-line data, handles CRLF and ids, ignores unknown fields", () => {
    const p = new SseParser();
    const m = p.push("id: 7\r\nevent: text_delta\r\nfoo: bar\r\ndata: {\"text\":\r\ndata: \"hi\"}\r\n\r\n");
    expect(m).toEqual([{ event: "text_delta", data: '{"text":\n"hi"}', id: "7" }]);
  });

  it("splits a multi-byte UTF-8 character across chunks safely", () => {
    const p = new SseParser();
    const bytes = new TextEncoder().encode(frame("text_delta", { text: "café ✓" }));
    const out = [...p.push(bytes.slice(0, 30)), ...p.push(bytes.slice(30))];
    expect(parseTurnEvent(out[0]!)).toEqual({ type: "text_delta", text: "café ✓" });
  });
});

describe("parseTurnEvent", () => {
  it("validates every contract event", () => {
    const p = new SseParser();
    const evs = p.push(ALL_EVENTS.map(([e, d]) => frame(e, d)).join("")).map(parseTurnEvent);
    expect(evs.every(Boolean)).toBe(true);
    expect(evs.map((e) => e!.type)).toEqual(ALL_EVENTS.map(([e]) => e));
    expect(evs[3]).toEqual({ type: "point", elementId: "nav:/dashboard/approvals", label: "Approvals" });
    expect(evs[6]).toMatchObject({ kind: "step", step: 2 });
  });

  it("drops malformed events", () => {
    const bad: [string, string][] = [
      ["point", JSON.stringify({ screen: -1, x: 1, y: 1 })],
      ["point", JSON.stringify({ screen: 0, x: "1", y: 1 })],
      ["draw", JSON.stringify({ kind: "arrow", screen: 0, points: [{ x: 1, y: 1 }] })],
      ["draw", JSON.stringify({ kind: "blob", screen: 0, points: [{ x: 1, y: 1 }] })],
      ["proposal", JSON.stringify({ approvalId: "a", tool: "t", summary: "s", tier: 4, destructive: false, voiceApprovable: true })],
      ["dictation", JSON.stringify({ text: "  " })],
      ["text_delta", "not json"],
      ["mystery", JSON.stringify({})],
    ];
    for (const [event, data] of bad) expect(parseTurnEvent({ event, data, id: null })).toBeNull();
  });

  it("never lets a Tier 3 or destructive proposal be voice-approvable, whatever the server says", () => {
    const t3 = parseTurnEvent({
      event: "proposal",
      data: JSON.stringify({ approvalId: "a", tool: "payroll.run", summary: "Run payroll", tier: 3, destructive: false, voiceApprovable: true }),
      id: null,
    });
    const del = parseTurnEvent({
      event: "proposal",
      data: JSON.stringify({ approvalId: "b", tool: "contacts.remove", summary: "Remove", tier: 1, destructive: true, voiceApprovable: true }),
      id: null,
    });
    expect(t3).toMatchObject({ voiceApprovable: false });
    expect(del).toMatchObject({ voiceApprovable: false });
  });
});

describe("readSse", () => {
  it("reads a fetch body stream and cancels it when the consumer stops early", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(frame("text_delta", { text: "a" })));
        c.enqueue(enc.encode(frame("text_delta", { text: "b" })));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: string[] = [];
    for await (const m of readSse(body)) {
      seen.push(m.data);
      if (seen.length === 2) break;
    }
    expect(seen).toHaveLength(2);
    expect(cancelled).toBe(true);
  });
});
