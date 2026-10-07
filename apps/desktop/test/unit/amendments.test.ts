// The WS=server contract amendments (p19a-contract.md, "Additions by
// WS=server (2026-10-06)") as the desktop client sees them: cookie-only
// sessions, epoch-ms expiries, the mock STT over SSE, the Deepgram header
// socket from main, turn_started.mock, the approve/agent response shapes.
import { describe, expect, it } from "vitest";
import { expiryMs, type CursorSession } from "../../src/shared/contract";
import { parseTurnEvent } from "../../src/shared/sse";
import { ApiError, ShapesApi, type FetchLike } from "../../src/main/api";
import { SpeechIn, type MainSocketFactory } from "../../src/main/speech";

const BASE = "https://app.example.com";

function session(over: Partial<CursorSession> = {}): CursorSession {
  return {
    token: "tok",
    expiresAt: Date.now() + 10 * 60_000,
    workspaceId: "ws",
    user: { id: "u", name: null },
    voice: { id: null, label: "Default" },
    limits: { talkMinutesIncluded: null, talkMinutesUsed: 0, byok: false },
    providers: { stt: "mock", tts: "mock", vision: "openai" },
    ...over,
  };
}

function recorder(routes: Record<string, () => Response>): { fetch: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const r = routes[path];
      return r ? r() : new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
    },
  };
}

const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const sseBody = (msgs: unknown[]) => () =>
  new Response(msgs.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

describe("session amendments", () => {
  it("reads epoch-ms and ISO expiries", () => {
    const t = Date.UTC(2026, 9, 6, 12);
    expect(expiryMs(t)).toBe(t);
    expect(expiryMs(new Date(t).toISOString())).toBe(t);
    expect(expiryMs(String(t))).toBe(t);
    expect(expiryMs(null)).toBeNaN();
    expect(expiryMs("garbage")).toBeNaN();
  });

  it("sends the bearer token while valid (epoch-ms expiry) and caches the session", async () => {
    const r = recorder({ "/api/cursor/session": json(session()), "/api/approvals/count": json({ total: 1, actionable: 1 }) });
    const api = new ShapesApi(() => BASE, r.fetch);
    await api.ensureSession();
    await api.ensureSession();
    await api.approvalCounts();
    expect(r.calls.filter((c) => c.url.endsWith("/api/cursor/session"))).toHaveLength(1);
    const h = r.calls.at(-1)!.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
  });

  it("a cookie-only session (token null) sends no Authorization and is still cached", async () => {
    const r = recorder({ "/api/cursor/session": json(session({ token: null, expiresAt: null })), "/api/approvals/count": json({ total: 0, actionable: 0 }) });
    const api = new ShapesApi(() => BASE, r.fetch);
    await api.ensureSession();
    await api.ensureSession();
    await api.approvalCounts();
    expect(r.calls.filter((c) => c.url.endsWith("/api/cursor/session"))).toHaveLength(1);
    expect((r.calls.at(-1)!.init!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("surfaces approve/agent errors with their codes", async () => {
    const r = recorder({
      "/api/cursor/approve": json({ error: { code: "already_decided", message: "Already decided." } }, 409),
      "/api/cursor/agent": json({ error: { code: "invalid_max_usd", message: "Max is $5 on Starter." } }, 400),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    await expect(api.approve({ approvalId: "a", decision: "approve", via: "click" })).rejects.toMatchObject({ status: 409, code: "already_decided" });
    await expect(api.agent({ goal: "x", maxUsd: 30 })).rejects.toMatchObject({ status: 400, code: "invalid_max_usd", message: "Max is $5 on Starter." });
  });

  it("parses the approve and agent 200 shapes", async () => {
    const r = recorder({
      "/api/cursor/approve": json({ approvalId: "a", status: "failed", resultSummary: "The invoice API refused it." }),
      "/api/cursor/agent": json({ runId: "run_9", maxUsd: 3 }),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    expect(await api.approve({ approvalId: "a", decision: "approve", via: "click" })).toMatchObject({ status: "failed" });
    expect(await api.agent({ goal: "x", maxUsd: 3 })).toEqual({ runId: "run_9", maxUsd: 3 });
  });

  it("turn_started carries mock: true under the labelled mock brain", () => {
    expect(parseTurnEvent({ event: "turn_started", data: JSON.stringify({ runId: "r", conversationId: "r", mock: true }), id: null })).toEqual({
      type: "turn_started",
      runId: "r",
      conversationId: "r",
      mock: true,
    });
    expect(parseTurnEvent({ event: "turn_started", data: JSON.stringify({ runId: "r", conversationId: "r" }), id: null })).not.toHaveProperty("mock");
  });
});

describe("speech in transports", () => {
  const mockTurns = [
    { type: "Begin", mock: true },
    { type: "Turn", transcript: "where do", end_of_turn: false, mock: true },
    { type: "Turn", transcript: "where do I approve", end_of_turn: true, mock: true },
    { type: "Termination", mock: true },
  ];

  it("mock: reads the SSE transcript on the ShapesOS origin, no microphone", async () => {
    const r = recorder({
      "/api/cursor/transcribe-token": json({ provider: "mock", wsUrl: `${BASE}/api/cursor/mock-stt`, token: "t", expiresAt: Date.now() + 60_000, sampleRate: 16000, encoding: "pcm_s16le", authVia: "query_token", sessionId: "s" }),
      "/api/cursor/mock-stt": sseBody(mockTurns),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    const sent: string[] = [];
    const audioWin = { isDestroyed: () => false, webContents: { send: (ch: string) => sent.push(ch) } };
    const live: string[] = [];
    const s = new SpeechIn(api, () => audioWin as never);
    s.onLive = (t) => live.push(t);
    expect(await s.start()).toBe(true);
    expect(s.currentTransport).toBe("main-sse");
    expect(await s.stop(500)).toBe("where do I approve");
    expect(live).toContain("where do");
    expect(sent).toEqual([]); // the audio window (microphone) was never asked to start
    expect(s.lastMock).toBe(true);
  });

  it("mock: refuses an SSE URL on another origin (the cookie never leaves ShapesOS)", async () => {
    const r = recorder({
      "/api/cursor/transcribe-token": json({ provider: "mock", wsUrl: "https://evil.example.net/api/cursor/mock-stt", token: "t", expiresAt: Date.now() + 60_000, sampleRate: 16000, encoding: "pcm_s16le" }),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    const s = new SpeechIn(api, () => null);
    await s.start();
    expect(await s.stop(300)).toBe("");
    expect(s.error).toMatch(/another site/);
    expect(r.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });

  it("deepgram: main opens the socket with the Authorization header and relays PCM", async () => {
    const r = recorder({
      "/api/cursor/transcribe-token": json({ provider: "deepgram", wsUrl: "wss://api.deepgram.com/v1/listen", token: "jwt", expiresAt: Date.now() + 60_000, sampleRate: 16000, encoding: "pcm_s16le", authVia: "bearer_header" }),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    const opened: { url: string; headers: Record<string, string> }[] = [];
    const sentOnSocket: unknown[] = [];
    type Sock = ReturnType<MainSocketFactory>;
    let sock!: Sock;
    const factory: MainSocketFactory = (url, headers) => {
      opened.push({ url, headers });
      sock = {
        readyState: 0,
        binaryType: "blob",
        send: (d: unknown) => void sentOnSocket.push(d),
        close: () => undefined,
        onmessage: null,
        onclose: null,
        onerror: null,
        onopen: null,
      } as unknown as Sock;
      return sock;
    };
    const toAudio: { ch: string; p: unknown }[] = [];
    const audioWin = { isDestroyed: () => false, webContents: { send: (ch: string, p: unknown) => toAudio.push({ ch, p }) } };
    const s = new SpeechIn(api, () => audioWin as never, factory);
    expect(await s.start()).toBe(true);
    expect(s.currentTransport).toBe("main-ws");
    expect(opened[0]!.headers).toEqual({ Authorization: "Bearer jwt" });
    expect(opened[0]!.url).not.toContain("jwt");
    expect(toAudio[0]).toMatchObject({ ch: "audio:stt-start", p: { mode: "relay" } });
    // PCM before open is queued, then flushed on open.
    s.pcm(new Uint8Array([1, 2]));
    (sock as unknown as { readyState: number }).readyState = 1;
    sock.onopen?.();
    s.pcm(new Uint8Array([3, 4]));
    expect(sentOnSocket).toHaveLength(2);
    sock.onmessage?.({ data: JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript: "hello there" }] }, is_final: true }) });
    const out = s.stop(300);
    expect(sentOnSocket.at(-1)).toBe('{"type":"CloseStream"}');
    sock.onclose?.();
    expect(await out).toBe("hello there");
  });

  it("assemblyai: the audio window opens the socket with the token in the query", async () => {
    const r = recorder({
      "/api/cursor/transcribe-token": json({ provider: "assemblyai", wsUrl: "wss://streaming.assemblyai.com/v3/ws", token: "tmp", expiresAt: Date.now() + 60_000, sampleRate: 16000, encoding: "pcm_s16le", authVia: "query_token" }),
    });
    const api = new ShapesApi(() => BASE, r.fetch);
    const toAudio: { ch: string; p: { mode?: string; url?: string } }[] = [];
    const audioWin = { isDestroyed: () => false, webContents: { send: (ch: string, p: { mode?: string; url?: string }) => toAudio.push({ ch, p }) } };
    const s = new SpeechIn(api, () => audioWin as never);
    expect(await s.start()).toBe(true);
    expect(toAudio[0]!.p.mode).toBe("socket");
    expect(toAudio[0]!.p.url).toContain("token=tmp");
  });

  it("a 402 cap_reached from transcribe-token is an ApiError the controller can say", async () => {
    const r = recorder({ "/api/cursor/transcribe-token": json({ error: { code: "cap_reached", message: "You've used this month's talk minutes." } }, 402) });
    const api = new ShapesApi(() => BASE, r.fetch);
    const s = new SpeechIn(api, () => null);
    await expect(s.start()).rejects.toBeInstanceOf(ApiError);
  });
});
