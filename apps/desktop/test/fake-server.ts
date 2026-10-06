// FAKE ShapesOS server — TEST FIXTURE ONLY (labelled everywhere it speaks).
//
// Implements the client-facing side of p19a-contract.md with scripted,
// labelled fixtures so the Electron smoke can run without the web app, a
// database or any provider. Every response carries `X-Fake-ShapesOS: 1`;
// the page title says "FAKE ShapesOS (test fixture)". It is never shipped:
// electron-builder packs dist/** only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeState {
  needsYou: number;
  turns: { transcript: string; screenshots: number; uiMap: number; app: string | null; screenshotBytes: number }[];
  approvals: { approvalId: string; decision: string; via: string; status: number }[];
  agents: { goal: string; maxUsd: number; runId: string }[];
  proposals: Map<string, { tier: number; destructive: boolean; voiceApprovable: boolean }>;
  tts: number;
  /** What the labelled mock STT "hears" (GET /api/cursor/mock-stt). */
  mockSttTranscript: string;
  sttStreams: number;
  talkSeconds: (number | null)[];
  voice: { id: string; label: string } | null;
  notifications: { id: string; kind: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string }[];
}

const COOKIE = "fake_shapes_session=fixture-user";

// A few frames of silent MPEG-1 Layer III (128 kbps, 44.1 kHz): header + zeros.
function silentMp3(frames = 8): Buffer {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9064, 0);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>FAKE ShapesOS (test fixture)</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#F3F3F1;display:flex;height:100vh}
nav{width:240px;background:#000;color:#fff;padding:16px;box-sizing:border-box}
nav a{display:block;color:#fff;padding:10px 12px;border-radius:8px;text-decoration:none;margin-bottom:4px}
main{flex:1;padding:32px}
#palette{display:none;position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#fff;padding:16px;border-radius:14px;box-shadow:0 0 0 1px #D6D6D2}
#palette.open{display:block}
.fixture{font-size:12px;color:#5E5E5B}
</style></head>
<body>
<nav aria-label="Main">
  <a href="#" data-cursor-id="nav:/dashboard" data-cursor-label="Overview">Overview</a>
  <a href="#" data-cursor-id="nav:/dashboard/approvals" data-cursor-label="Approvals">Approvals</a>
  <a href="#" data-cursor-id="nav:/dashboard/runs" data-cursor-label="Runs">Runs</a>
</nav>
<main>
  <h1>FAKE ShapesOS</h1>
  <p class="fixture">Test fixture for the ShapesOS Desktop smoke. Not the real app.</p>
  <button data-cursor-id="kit:new-invoice" data-cursor-label="New invoice">New invoice</button>
</main>
<div id="palette" role="dialog" aria-label="Command palette">⌘K palette (fixture)</div>
<script>
window.__shapesUiMap = function () {
  return Array.from(document.querySelectorAll('[data-cursor-id]')).map(function (el) {
    var r = el.getBoundingClientRect();
    return { id: el.getAttribute('data-cursor-id'), label: el.getAttribute('data-cursor-label') || '', role: el.tagName.toLowerCase() === 'a' ? 'link' : 'button', rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }).filter(function (e) { return e.rect.w > 0 && e.rect.h > 0; });
};
window.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('palette').classList.toggle('open'); }
});
</script>
</body></html>`;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "X-Fake-ShapesOS": "1", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sse(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Fake-ShapesOS": "1",
  });
  res.write("retry: 2000\n\n");
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeServer(port = 0): Promise<{ url: string; state: FakeState; close: () => Promise<void>; server: Server }> {
  const state: FakeState = {
    needsYou: 2,
    turns: [],
    approvals: [],
    agents: [],
    proposals: new Map(),
    tts: 0,
    mockSttTranscript: "where do I approve a pay run",
    sttStreams: 0,
    talkSeconds: [],
    voice: null,
    notifications: [],
  };
  const decided = new Set<string>();
  let runSeq = 0;
  let approvalSeq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`, "X-Fake-ShapesOS": "1" });
      res.end(PAGE);
      return;
    }

    // Fixture controls (test-only).
    if (path === "/__fixture/state") {
      if (req.method === "POST") {
        const b = await readJson(req);
        if (typeof b.needsYou === "number") state.needsYou = b.needsYou;
        if (Array.isArray(b.notifications)) state.notifications = b.notifications as FakeState["notifications"];
        if (typeof b.mockSttTranscript === "string") state.mockSttTranscript = b.mockSttTranscript;
      }
      send(res, 200, { ...state, proposals: Object.fromEntries(state.proposals) });
      return;
    }

    if (path.startsWith("/api/")) {
      const authed = (req.headers.cookie ?? "").includes(COOKIE);
      if (!authed) {
        send(res, 401, { error: { code: "unauthorized", message: "Sign in (fixture)" } });
        return;
      }
    }

    if (req.method === "POST" && path === "/api/cursor/session") {
      // As the real server sends it: expiresAt in epoch ms.
      send(res, 200, {
        token: "fixture-token",
        expiresAt: Date.now() + 10 * 60_000,
        workspaceId: "ws_fixture",
        user: { id: "u_fixture", name: "Fixture Person" },
        voice: state.voice ?? { id: null, label: "Fixture voice (mock)" },
        limits: { talkMinutesIncluded: 60, talkMinutesUsed: 3, byok: false },
        providers: { stt: "mock", tts: "mock", vision: "mock" },
      });
      return;
    }

    if (req.method === "POST" && path === "/api/cursor/transcribe-token") {
      // The amended contract's mock: wsUrl is an http(s) SSE URL on this origin.
      send(res, 200, {
        provider: "mock",
        wsUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/cursor/mock-stt`,
        token: "fixture-stt-token",
        expiresAt: Date.now() + 60_000,
        sampleRate: 16000,
        encoding: "pcm_s16le",
        authVia: "query_token",
        sessionId: "stt_fixture",
      });
      return;
    }

    if (req.method === "GET" && path === "/api/cursor/mock-stt") {
      // AssemblyAI-v3-shaped messages, one per data: line, labelled mock.
      state.sttStreams += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Shapes-Mock": "1", "X-Fake-ShapesOS": "1" });
      const words = state.mockSttTranscript.split(" ");
      const msgs: Record<string, unknown>[] = [{ type: "Begin", mock: true }];
      for (let i = 1; i <= words.length; i++) msgs.push({ type: "Turn", transcript: words.slice(0, i).join(" "), end_of_turn: i === words.length, mock: true });
      msgs.push({ type: "Termination", mock: true });
      for (const m of msgs) {
        res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        await sleep(20);
      }
      res.end();
      return;
    }

    if (path === "/api/cursor/voices") {
      const voices = [
        { id: "fixture-alloy", label: "Alloy (fixture)" },
        { id: "fixture-verse", label: "Verse (fixture)" },
      ];
      if (req.method === "PUT") {
        const b = await readJson(req);
        const v = voices.find((x) => x.id === b.voiceId);
        if (!v) {
          send(res, 400, { error: { code: "tts_bad_voice", message: "That voice isn't available. Pick one from the list." } });
          return;
        }
        state.voice = v;
        send(res, 200, { selected: { provider: "mock", ...v } });
        return;
      }
      send(res, 200, { provider: "mock", voices, selected: state.voice ? { provider: "mock", ...state.voice } : null, error: null });
      return;
    }

    if (req.method === "POST" && path === "/api/cursor/turn") {
      const b = await readJson(req);
      const transcript = String(b.transcript ?? "");
      const shots = Array.isArray(b.screenshots) ? (b.screenshots as { jpegBase64?: string }[]) : [];
      const uiMap = Array.isArray(b.uiMap) ? b.uiMap : [];
      const app = b.app && typeof b.app === "object" ? String((b.app as { name?: string }).name ?? "") : null;
      state.talkSeconds.push(typeof b.talkSeconds === "number" ? b.talkSeconds : null);
      state.turns.push({
        transcript,
        screenshots: shots.length,
        uiMap: uiMap.length,
        app,
        screenshotBytes: shots.reduce((n, s) => n + (s.jpegBase64?.length ?? 0), 0),
      });
      const emit = sse(res);
      const t = transcript.toLowerCase();
      // Amended contract: conversationId is the cursor run id; mock: true under the labelled mock brain.
      emit("turn_started", { runId: "run_cursor_fixture", conversationId: "run_cursor_fixture", mock: true });
      await sleep(30);
      if (/where do i approve/.test(t)) {
        emit("text_delta", { text: "Approvals is in the sidebar. " });
        emit("point", { elementId: "nav:/dashboard/approvals", label: "Approvals" });
        emit("text_delta", { text: "Click it to see what needs you." });
      } else if (/point at|corner/.test(t)) {
        emit("text_delta", { text: "Right here. " });
        emit("point", { screen: 0, x: 400, y: 300, label: "Here" });
        emit("draw", { kind: "circle", screen: 0, points: [{ x: 400, y: 300 }], label: "this one" });
        emit("draw", { kind: "arrow", screen: 0, points: [{ x: 700, y: 520 }, { x: 440, y: 330 }] });
        emit("draw", { kind: "step", screen: 0, points: [{ x: 760, y: 540 }], step: 1, label: "First" });
        emit("text_delta", { text: "Click there first." });
      } else if (/draft an invoice/.test(t)) {
        const id = `ap_t1_${++approvalSeq}`;
        state.proposals.set(id, { tier: 1, destructive: false, voiceApprovable: true });
        emit("text_delta", { text: "I drafted it. Approve to save the draft. " });
        emit("proposal", { approvalId: id, tool: "invoices.draft", summary: "Draft an invoice for Acme for $200", tier: 1, destructive: false, voiceApprovable: true });
      } else if (/payroll|pay run/.test(t)) {
        const id = `ap_t3_${++approvalSeq}`;
        state.proposals.set(id, { tier: 3, destructive: false, voiceApprovable: false });
        emit("text_delta", { text: "This runs payroll, so it needs your click. " });
        emit("proposal", { approvalId: id, tool: "payroll.run", summary: "Run the October pay run ($48,210)", tier: 3, destructive: false, voiceApprovable: false });
      } else if (/write a reply|dictate/.test(t)) {
        emit("dictation", { text: "Thanks for the update, see you Monday." });
      } else {
        emit("text_delta", { text: "This is the fake ShapesOS fixture answering. " });
      }
      emit("done", { usage: { credits: 1, inputTokens: 100, outputTokens: 20 } });
      res.end();
      return;
    }

    if (req.method === "POST" && path === "/api/cursor/approve") {
      const b = await readJson(req);
      const id = String(b.approvalId ?? "");
      const p = state.proposals.get(id);
      const rec = { approvalId: id, decision: String(b.decision), via: String(b.via), status: 200 };
      if (!p && decided.has(id)) {
        rec.status = 409;
        state.approvals.push(rec);
        send(res, 409, { error: { code: "already_decided", message: "Already decided (fixture)" } });
        return;
      }
      if (!p) {
        rec.status = 404;
        state.approvals.push(rec);
        send(res, 404, { error: { code: "not_found", message: "No such approval (fixture)" } });
        return;
      }
      // The contract's gate: Tier 3 / destructive never by voice.
      if (b.via === "voice" && b.decision === "approve" && (p.tier === 3 || p.destructive)) {
        rec.status = 403;
        state.approvals.push(rec);
        send(res, 403, { error: { code: "voice_not_allowed", message: "Click to approve; voice can't approve this." } });
        return;
      }
      state.approvals.push(rec);
      state.proposals.delete(id);
      decided.add(id);
      if (b.decision === "approve") state.needsYou = Math.max(0, state.needsYou - 1);
      send(res, 200, {
        approvalId: id,
        status: b.decision === "approve" ? "executed" : "rejected",
        resultSummary: b.decision === "approve" ? "Done (fixture)." : null,
      });
      return;
    }

    if (req.method === "POST" && path === "/api/cursor/tts") {
      const b = await readJson(req);
      if (typeof b.text !== "string" || b.text.length > 2000) {
        send(res, 413, { error: { code: "too_long", message: "≤ 2,000 chars (fixture)" } });
        return;
      }
      state.tts += 1;
      res.writeHead(200, { "Content-Type": "audio/mpeg", "X-Shapes-TTS-Provider": "mock", "X-Shapes-Mock": "1", "X-Fake-ShapesOS": "1" });
      res.end(silentMp3());
      return;
    }

    if (req.method === "POST" && path === "/api/cursor/agent") {
      const b = await readJson(req);
      const maxUsd = Number(b.maxUsd);
      if (typeof b.goal !== "string" || !(maxUsd > 0)) {
        send(res, 400, { error: { code: "invalid", message: "goal and maxUsd > 0 (fixture)" } });
        return;
      }
      const runId = `run_agent_${++runSeq}`;
      state.agents.push({ goal: b.goal, maxUsd, runId });
      send(res, 200, { runId, maxUsd });
      return;
    }

    const watch = /^\/api\/agent-runs\/([^/]+)\/watch$/.exec(path);
    if (req.method === "GET" && watch) {
      const emit = sse(res);
      const runId = decodeURIComponent(watch[1]!);
      emit("delegation", { runId, runStatus: "running", live: true, plans: [{ line: "0 of 2 sub-agents done", tasks: [{ summary: null }, { summary: null }] }] });
      await sleep(400);
      emit("delegation", {
        runId,
        runStatus: "succeeded",
        live: false,
        plans: [{ line: "2 of 2 sub-agents done", tasks: [{ summary: "Three competitors raised prices." }, { summary: "One launched a free tier." }] }],
      });
      emit("end", { reason: "run-finished" });
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/api/approvals/count") {
      send(res, 200, { total: state.needsYou, actionable: state.needsYou });
      return;
    }

    if (req.method === "GET" && path === "/api/agents/activity") {
      const running = state.agents.map((a) => ({ key: `run:${a.runId}`, name: "Researcher", status: "running", line: a.goal, href: `/dashboard/runs/${a.runId}` }));
      send(res, 200, {
        tree: {
          lead: { key: "lead", name: "Lead agent", status: running.length ? "running" : "done", line: "Routing work", href: null },
          branches: running,
          missions: [],
          counts: { running: running.length, needs: state.needsYou, done: 0, failed: 0 },
        },
        usage: null,
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (req.method === "GET" && path === "/api/notifications") {
      send(res, 200, { notifications: state.notifications, unread: state.notifications.filter((n) => !n.readAt).length });
      return;
    }

    send(res, 404, { error: { code: "not_found", message: `No fixture for ${req.method} ${path}` } });
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    state,
    server,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
