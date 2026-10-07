// ShapesOS — Phase 19A (WS=server): the agentic cursor against real Postgres,
// through the real routes (bearer cursor tokens; no cookies needed):
//   - a cursor turn (labelled mock brain) streams turn_started / text / point
//     / proposal / done, creates ONE run of kind "cursor" (a follow-up turn
//     with conversationId stays on it) whose events are text only — the
//     screenshot's bytes are nowhere in the database;
//   - a proposal from the brain is pending; a spoken approval is refused
//     (403 voice_not_allowed) for a Tier 3 tool but works for a Tier 0–2 one
//     (through executeTool); a viewer can't approve or start agent mode;
//   - agent mode: maxUsd is validated, the run is kind "cursor" with
//     budgetMicroUsd, queued for the worker, and the loop stops at the cap
//     (fake model with a priced usage per call, the budget read from the row);
//   - talk minutes: free within the plan's included minutes, charged after;
//   - tokens: wrong workspace / tampered → 401;
//   - Phase 19A integration (the 18.3 hand-offs): a workspace's blocked app
//     (agent app permissions) is neither offered to the cursor nor proposable;
//     agent mode announces run_finished / run_failed while a spoken
//     conversation doesn't; "Undo this agent run" reverts what a cursor run
//     did; the audit timeline shows the cursor's audit rows and run steps.
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/cursor/__tests__/cursor-db.test.ts
// Listed in scripts/test/db-tests.txt.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.AUTH_SECRET = "cursor-db-test-secret-0123456789";
process.env.ALLOW_FAKE_PROVIDERS = "1";
for (const k of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "VOICESTUDIO_URL",
  "LLM_SELF_HOST",
]) delete process.env[k];

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { registerExtraTool, type ToolDef } from "@/lib/chat/tools";
import { memoryTranscriptStore } from "@/lib/agents/runs/transcript";
import { runAgentLoop } from "@/lib/agents/loop";
import { signCursorToken } from "../token";
import { cursorGrant, runCursorTurn, type CursorSseEvent } from "../brain";
import { preflightTalkMinutes, recordTalkMinutes, talkAllowance } from "../metering";
import { POST as turnPOST } from "@/app/api/cursor/turn/route";
import { POST as approvePOST } from "@/app/api/cursor/approve/route";
import { POST as agentPOST } from "@/app/api/cursor/agent/route";
import { POST as sessionPOST } from "@/app/api/cursor/session/route";
import { POST as sttPOST } from "@/app/api/cursor/transcribe-token/route";
import { POST as ttsPOST } from "@/app/api/cursor/tts/route";
import { toolGroup } from "@/lib/chat/tools";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { setAgentBlockedGroups } from "@/lib/agents/app-permissions";
import { finishAgentRun } from "@/lib/agents/runs/service";
import { executeUndo, loadUndoPlan } from "@/lib/timemachine/undo";
import { loadTimeline } from "@/lib/audit-timeline/timeline.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p19a-${RUN}`;
const OTHER = `p19a-o-${RUN}`;
const ANA = `p19a-ana-${RUN}`;
const VIC = `p19a-vic-${RUN}`;
const SECRET = process.env.AUTH_SECRET!;
/** A recognisable "screenshot" payload: its bytes must never reach the database. */
const MARKER = "U0NSRUVOU0hPVE1BUktFUjE5QQ";
const SHOT_B64 = `${MARKER}${"A".repeat(400)}`;

let noteRuns = 0;
const t_cursor_note: ToolDef = {
  name: "t_cursor_note",
  description: "Pin a short note on the workspace board.",
  kind: "publish",
  minRole: "editor",
  argsSchema: { type: "object", properties: { text: { type: "string", description: "Text." } }, required: ["text"] },
  async execute(_ctx, args) {
    noteRuns++;
    return { summary: `pinned: ${String(args.text)}` };
  },
};

const t_cursor_look: ToolDef = {
  name: "t_cursor_look",
  description: "Look something up.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    return { summary: "looked" };
  },
};

const tok = (userId: string, ws = WS) => signCursorToken({ userId, workspaceId: ws }, SECRET).token;
const req = (path: string, token: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

async function sse(res: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text();
  const out: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}

before(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA, plan: "starter" } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: `p19a-x-${RUN}` } });
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: VIC, role: "viewer", name: "Vic" } });
  await prisma.project.create({ data: { workspaceId: WS, domain: `p19a-${RUN}.example.com` } });
  registerExtraTool(t_cursor_note);
  registerExtraTool(t_cursor_look);
});

after(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

async function markerCount(): Promise<number> {
  const like = `%${MARKER}%`;
  const rows = await withWorkspaceScope(WS, (tx) =>
    tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT (
        (SELECT count(*) FROM agent_run_events WHERE workspace_id = ${WS} AND (summary LIKE ${like} OR coalesce(payload::text, '') LIKE ${like}))
      + (SELECT count(*) FROM agent_run_transcripts t JOIN agent_runs r ON r.id = t.run_id WHERE r.workspace_id = ${WS} AND t::text LIKE ${like})
      + (SELECT count(*) FROM cursor_proposals WHERE workspace_id = ${WS} AND (args::text LIKE ${like} OR summary LIKE ${like}))
      + (SELECT count(*) FROM agent_runs WHERE workspace_id = ${WS} AND coalesce(agent_state::text, '') LIKE ${like})
      ) AS n`,
  );
  const audit = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM authority_audit_events WHERE workspace_id = ${WS} AND coalesce(detail::text, '') LIKE ${like}`;
  const usage = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM usage_events WHERE workspace_id = ${WS} AND coalesce(evidence_ref, '') LIKE ${like}`;
  return Number(rows[0]!.n) + Number(audit[0]!.n) + Number(usage[0]!.n);
}

describe("cursor turn (DB, labelled mock brain)", () => {
  let runId = "";
  it("streams the contract's events and creates one cursor run with text-only events", async () => {
    const res = await turnPOST(
      req("/api/cursor/turn", tok(ANA), {
        transcript: "Please draft a post about lanterns",
        screenshots: [{ screen: 0, width: 400, height: 200, scaleFactor: 2, primary: true, jpegBase64: SHOT_B64 }],
        uiMap: [{ id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 0, y: 100, w: 200, h: 40 } }],
        app: { name: "ShapesOS", title: "Home", isShapesOS: true },
      }),
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await sse(res);
    const names = events.map((e) => e.event);
    assert.equal(names[0], "turn_started");
    assert.equal(names[names.length - 1], "done");
    const started = events[0]!.data;
    assert.equal(started.mock, true, "the mock brain is labelled");
    runId = String(started.runId);
    assert.equal(started.conversationId, runId);
    const text = events.filter((e) => e.event === "text_delta").map((e) => e.data.text).join("");
    assert.match(text, /^Mock cursor:/);
    assert.ok(!/\[|\]/.test(text), "spoken text has no tags");
    assert.deepEqual(events.find((e) => e.event === "point")?.data, { elementId: "nav:/dashboard/approvals", label: "Approvals" });
    const proposal = events.find((e) => e.event === "proposal")?.data;
    assert.ok(proposal, "a proposal event");
    assert.equal(proposal!.tool, "create_content_draft");
    assert.equal(proposal!.voiceApprovable, true);
    assert.equal(proposal!.elementId, "nav:/dashboard/approvals");

    const run = await withWorkspaceScope(WS, (tx) => tx.agentRun.findFirst({ where: { id: runId, workspaceId: WS } }));
    assert.equal(run?.kind, "cursor");
    assert.equal(run?.startedBy, ANA);
    const evs = await withWorkspaceScope(WS, (tx) => tx.agentRunEvent.findMany({ where: { runId, workspaceId: WS }, orderBy: { seq: "asc" } }));
    const kinds = evs.map((e) => (e.payload as { kind?: string } | null)?.kind);
    assert.ok(kinds.includes("cursor_utterance") && kinds.includes("cursor_reply") && kinds.includes("cursor_proposal"));
    const utter = evs.find((e) => (e.payload as { kind?: string }).kind === "cursor_utterance")!;
    const screen = (utter.payload as { screen: string }).screen;
    assert.ok(screen.length <= 200);
    const pending = await withWorkspaceScope(WS, (tx) => tx.cursorProposal.findMany({ where: { runId, workspaceId: WS } }));
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.status, "pending");
  });

  it("a follow-up with conversationId stays on the same run", async () => {
    const res = await turnPOST(req("/api/cursor/turn", tok(ANA), { conversationId: runId, transcript: "and where are approvals?", screenshots: [] }));
    const events = await sse(res);
    assert.equal(events[0]!.data.runId, runId);
    const runs = await withWorkspaceScope(WS, (tx) => tx.agentRun.count({ where: { workspaceId: WS, kind: "cursor", startedBy: ANA, agentState: { path: ["mode"], equals: "conversation" } } }));
    assert.equal(runs, 1);
  });

  it("no screenshot bytes are stored anywhere", async () => {
    assert.equal(await markerCount(), 0);
  });

  it("someone else's conversation is not found; a viewer gets answers but no tools", async () => {
    const res = await turnPOST(req("/api/cursor/turn", tok(VIC), { conversationId: runId, transcript: "hi", screenshots: [] }));
    const ev = await sse(res);
    assert.ok(ev.some((e) => e.event === "error" && e.data.code === "conversation_not_found"));
    const res2 = await turnPOST(req("/api/cursor/turn", tok(VIC), { transcript: "Please draft something", screenshots: [] }));
    const ev2 = await sse(res2);
    assert.ok(ev2.some((e) => e.event === "text_delta"));
    assert.ok(!ev2.some((e) => e.event === "proposal"), "a viewer is offered no tools");
  });

  it("limits: > 4 screenshots → 413", async () => {
    const shot = (n: number) => ({ screen: n, width: 10, height: 10, scaleFactor: 1, primary: n === 0, jpegBase64: "QUJD" });
    const res = await turnPOST(req("/api/cursor/turn", tok(ANA), { transcript: "x", screenshots: [0, 1, 2, 3, 4].map(shot) }));
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "too_large");
  });
});

describe("proposals and the spoken-approval gate (DB)", () => {
  let invoiceId = "";
  let noteId = "";
  it("the brain's tool calls go through executeTool and wait as proposals", async () => {
    const script: MockChatStep[] = [
      {
        content: [
          { type: "text", text: "I set both up for you to approve [POINT:#nav:/dashboard/approvals:Approvals]." },
          { type: "tool_use", id: "tu_inv", name: "ops_send_invoice", input: { invoiceId: "inv-1" } },
          { type: "tool_use", id: "tu_note", name: "t_cursor_note", input: { text: "standup at 10" } },
        ],
      },
      { content: [{ type: "text", text: "They are waiting on the cards." }] },
    ];
    const events: CursorSseEvent[] = [];
    await runCursorTurn(
      { userId: ANA, workspaceId: WS, role: "owner" },
      { transcript: "send the invoice and pin a note", screenshots: [], uiMap: [{ id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 0, y: 0, w: 1, h: 1 } }] },
      (e) => events.push(e),
      { provider: new MockLlmProvider({ chatScript: script }) },
    );
    const props = events.filter((e): e is Extract<CursorSseEvent, { event: "proposal" }> => e.event === "proposal").map((e) => e.data);
    const inv = props.find((p) => p.tool === "ops_send_invoice")!;
    const note = props.find((p) => p.tool === "t_cursor_note")!;
    assert.equal(inv.tier, 3);
    assert.equal(inv.voiceApprovable, false);
    assert.ok(note.tier < 3);
    assert.equal(note.voiceApprovable, true);
    assert.equal(noteRuns, 0, "nothing ran before the OK");
    invoiceId = inv.approvalId;
    noteId = note.approvalId;
  });

  it("a viewer can't approve (403)", async () => {
    const res = await approvePOST(req("/api/cursor/approve", tok(VIC), { approvalId: noteId, decision: "approve", via: "click" }));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "forbidden");
  });

  it("a spoken yes is refused for the Tier 3 tool (403 voice_not_allowed) and nothing runs", async () => {
    const res = await approvePOST(req("/api/cursor/approve", tok(ANA), { approvalId: invoiceId, decision: "approve", via: "voice" }));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "voice_not_allowed");
    const row = await withWorkspaceScope(WS, (tx) => tx.cursorProposal.findFirst({ where: { id: invoiceId } }));
    assert.equal(row?.status, "pending", "still waiting for a click");
    const refused = await prisma.authorityAuditEvent.count({ where: { workspaceId: WS, action: "cursor.voice_refused" } });
    assert.equal(refused, 1);
  });

  it("a spoken no is fine for it", async () => {
    const res = await approvePOST(req("/api/cursor/approve", tok(ANA), { approvalId: invoiceId, decision: "reject", via: "voice" }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "rejected");
  });

  it("a spoken yes works for the Tier 0–2 tool and runs it through executeTool, once", async () => {
    const res = await approvePOST(req("/api/cursor/approve", tok(ANA), { approvalId: noteId, decision: "approve", via: "voice" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; resultSummary: string };
    assert.equal(body.status, "executed");
    assert.match(body.resultSummary, /pinned: standup at 10/);
    assert.equal(noteRuns, 1);
    const again = await approvePOST(req("/api/cursor/approve", tok(ANA), { approvalId: noteId, decision: "approve", via: "click" }));
    assert.equal(again.status, 409);
    assert.equal(noteRuns, 1);
    const chain = await prisma.authorityAuditEvent.findMany({ where: { workspaceId: WS, entityType: "cursor_run" }, orderBy: { ts: "asc" } });
    assert.ok(chain.some((e) => e.action === "cursor.approve"));
    for (let i = 1; i < chain.length; i++) assert.equal(chain[i]!.prevHash, chain[i - 1]!.eventHash, "hash-chained");
  });
});

describe("agent mode (DB)", () => {
  it("validates maxUsd and refuses a viewer", async () => {
    assert.equal((await agentPOST(req("/api/cursor/agent", tok(VIC), { goal: "research", maxUsd: 1 }))).status, 403);
    const tooMuch = await agentPOST(req("/api/cursor/agent", tok(ANA), { goal: "research", maxUsd: 100 }));
    assert.equal(tooMuch.status, 400);
    assert.equal(((await tooMuch.json()) as { error: { code: string } }).error.code, "invalid_max_usd");
    assert.equal((await agentPOST(req("/api/cursor/agent", tok(ANA), { goal: "research", maxUsd: 0 }))).status, 400);
  });

  it("starts a capped cursor run on the worker, and the loop stops at the cap", async () => {
    const res = await agentPOST(req("/api/cursor/agent", tok(ANA), { goal: "Research our competitors", maxUsd: 0.01 }));
    assert.equal(res.status, 200);
    const { runId, maxUsd } = (await res.json()) as { runId: string; maxUsd: number };
    assert.equal(maxUsd, 0.01);
    const run = await withWorkspaceScope(WS, (tx) => tx.agentRun.findFirst({ where: { id: runId } }));
    assert.equal(run?.kind, "cursor");
    assert.equal(run?.budgetMicroUsd, 10_000);
    const jobs = await withWorkspaceScope(WS, (tx) => tx.agentJob.count({ where: { runId, kind: "chat_turn" } }));
    assert.equal(jobs, 1, "handed to the agent worker");

    // The worker's loop on that run, with a fake model priced $0.003 a call:
    // the cap is read from the row; 3 calls fit, the 4th would cross $0.01.
    let n = 0;
    const provider = new MockLlmProvider({
      chatScript: [() => ({ content: [{ type: "tool_use", id: `tu_${++n}`, name: "t_cursor_look", input: {} }], costMicroUsd: 3_000 })],
    });
    const out = await runAgentLoop({
      ctx: { projectId: "", workspaceId: WS, userId: ANA, role: "owner", confirmed: false, agentKey: "lead", grant: null, runId },
      system: "test",
      messages: [{ role: "user", content: "go" }],
      deps: { provider, store: memoryTranscriptStore(), persistEvents: false },
    });
    assert.equal(out.status, "capped");
    assert.equal(out.cap, "cost");
    assert.equal(provider.chatCalls.length, 3);
    assert.ok(out.state.costMicroUsd <= 10_000);
  });

  it("a turn in agent mode reads the spoken limit; a viewer gets 403", async () => {
    const res = await turnPOST(req("/api/cursor/turn", tok(ANA), { transcript: "Research pricing pages in the background, max $1", screenshots: [], mode: "agent" }));
    const ev = await sse(res);
    const started = ev.find((e) => e.event === "agent_started")?.data;
    assert.ok(started, "agent_started");
    assert.equal(started!.maxUsd, 1);
    const viewer = await turnPOST(req("/api/cursor/turn", tok(VIC), { transcript: "x max $1", screenshots: [], mode: "agent" }));
    assert.equal(viewer.status, 403);
  });
});

describe("talk minutes and speech (DB)", () => {
  it("free within the plan's included minutes, charged after (starter: 60)", async () => {
    const before = await talkAllowance(WS);
    assert.equal(before.included, 60);
    // 59 minutes already spoken this period.
    await prisma.usageEvent.createMany({
      data: Array.from({ length: 59 - before.used }, (_, i) => ({ workspaceId: WS, action: "cursor_talk_minute", credits: 0, idempotencyKey: `seed-${RUN}-${i}` })),
    });
    const charges = await preflightTalkMinutes(WS, 3, "deepgram");
    assert.deepEqual(charges, [0, 4, 4]);
    const r = await recordTalkMinutes({ workspaceId: WS, actorId: ANA, sessionKey: `s-${RUN}`, fromMinute: 1, charges, provider: "deepgram" });
    assert.equal(r.charged, 8);
    // Idempotent per session + minute.
    const again = await recordTalkMinutes({ workspaceId: WS, actorId: ANA, sessionKey: `s-${RUN}`, fromMinute: 1, charges, provider: "deepgram" });
    assert.equal((await talkAllowance(WS)).used, 62);
    assert.ok(again.charged === 0 || again.charged === 8);
  });

  it("session returns a token, limits and labelled providers; transcribe-token and tts use the labelled mocks", async () => {
    const s = await sessionPOST(req("/api/cursor/session", tok(ANA), {}));
    assert.equal(s.status, 200);
    const body = (await s.json()) as { token: string; workspaceId: string; limits: { talkMinutesIncluded: number; talkMinutesUsed: number }; providers: Record<string, string> };
    assert.match(body.token, /^cur1\./);
    assert.equal(body.workspaceId, WS);
    assert.equal(body.limits.talkMinutesIncluded, 60);
    assert.ok(body.limits.talkMinutesUsed >= 62);
    assert.deepEqual(body.providers, { stt: "mock", tts: "mock", vision: "mock" });
    const stt = await sttPOST(req("/api/cursor/transcribe-token", body.token, {}));
    assert.equal(stt.status, 200);
    assert.equal(stt.headers.get("x-shapes-mock"), "1");
    const sb = (await stt.json()) as { provider: string; sampleRate: number; encoding: string };
    assert.deepEqual([sb.provider, sb.sampleRate, sb.encoding], ["mock", 16000, "pcm_s16le"]);
    const tts = await ttsPOST(req("/api/cursor/tts", body.token, { text: "Hello there" }));
    assert.equal(tts.status, 200);
    assert.equal(tts.headers.get("content-type"), "audio/mpeg");
    assert.equal(tts.headers.get("x-shapes-tts-provider"), "mock");
    assert.equal(tts.headers.get("x-shapes-mock"), "1");
    assert.ok((await tts.arrayBuffer()).byteLength > 0);
  });

  it("tokens: another workspace's or a tampered token → 401", async () => {
    const wrong = await sessionPOST(req("/api/cursor/session", tok(ANA, OTHER), {}));
    assert.equal(wrong.status, 401);
    const t = tok(ANA);
    const bad = await sessionPOST(req("/api/cursor/session", `${t.slice(0, -2)}xx`, {}));
    assert.equal(bad.status, 401);
  });
});

describe("Phase 19A integration: the 18.3 hand-offs (DB)", () => {
  const owner = { userId: ANA, workspaceId: WS, role: "owner" as const };

  it("a blocked app's tools are not offered to the cursor and can't be proposed (executeTool refuses them)", async () => {
    const invoiceGroup = toolGroup("ops_send_invoice");
    assert.notEqual(invoiceGroup, toolGroup("t_cursor_note"), "the two tools sit in different apps");
    await setAgentBlockedGroups(WS, [invoiceGroup], ANA);
    try {
      let offered: string[] = [];
      let invoiceResult: { text: string; isError: boolean } | null = null;
      const script: MockChatStep[] = [
        (r) => {
          offered = (r.tools ?? []).map((t) => t.name);
          return {
            content: [
              { type: "text", text: "Sending it and pinning a note." },
              { type: "tool_use", id: "tu_blk_inv", name: "ops_send_invoice", input: { invoiceId: "inv-blocked" } },
              { type: "tool_use", id: "tu_blk_note", name: "t_cursor_note", input: { text: "blocked check" } },
            ],
          };
        },
        (r) => {
          const last = r.messages[r.messages.length - 1]?.content;
          for (const b of Array.isArray(last) ? last : []) if (b.type === "tool_result" && b.toolUseId === "tu_blk_inv") invoiceResult = { text: String(b.content), isError: !!b.isError };
          return { content: [{ type: "text", text: "Done asking." }] };
        },
      ];
      const events: CursorSseEvent[] = [];
      const out = await runCursorTurn(owner, { transcript: "send the invoice and pin a note", screenshots: [] }, (e) => events.push(e), {
        provider: new MockLlmProvider({ chatScript: script }),
      });
      assert.ok(offered.length > 0, "tools were offered");
      assert.ok(!offered.includes("ops_send_invoice"), "the blocked app's tool is not offered");
      assert.ok(offered.includes("t_cursor_note"));
      const props = events.filter((e): e is Extract<CursorSseEvent, { event: "proposal" }> => e.event === "proposal").map((e) => e.data.tool);
      assert.deepEqual(props, ["t_cursor_note"], "only the allowed tool became a proposal");
      const rows = await withWorkspaceScope(WS, (tx) => tx.cursorProposal.count({ where: { runId: out.runId, tool: "ops_send_invoice" } }));
      assert.equal(rows, 0);
      assert.ok(invoiceResult?.isError, `the model was told it can't: ${invoiceResult?.text}`);
      // A proposal made before the block, approved after it: executeTool's
      // 18.3 backstop refuses it (whatever grant the call carries).
      const call: ChatToolCall = { tool: "ops_send_invoice", args: { invoiceId: "inv-blocked" }, status: "error", runId: out.runId, confirmed: true };
      await executeTool({ projectId: "", workspaceId: WS, userId: ANA, role: "owner", confirmed: true, agentKey: "lead", grant: cursorGrant(), runId: out.runId }, "ops_send_invoice", call.args, call);
      assert.equal(call.status, "denied");
      assert.match(call.resultSummary ?? "", /Agents may not use/);
      const refused = await withWorkspaceScope(WS, (tx) =>
        tx.agentRunEvent.count({ where: { runId: out.runId, type: "gate", payload: { path: ["reason"], equals: "app_blocked" } } }),
      );
      assert.equal(refused, 1, "the refusal is on the cursor run's timeline");
      const run = await withWorkspaceScope(WS, (tx) => tx.agentRun.findFirst({ where: { id: out.runId }, select: { allowedTools: true } }));
      assert.ok(!run?.allowedTools.includes(invoiceGroup), "the run's recorded grant leaves the blocked app out");
    } finally {
      await setAgentBlockedGroups(WS, [], ANA);
    }
  });

  it("notifications: cursor agent mode announces run_finished and run_failed; a spoken conversation doesn't", async () => {
    const count = (where: Record<string, unknown>) => prisma.notification.count({ where: { workspaceId: WS, userId: ANA, ...where } });
    // A spoken conversation (no spend cap): finished at the end of the turn, silently.
    const events: CursorSseEvent[] = [];
    const convo = await runCursorTurn(owner, { transcript: "where is billing", screenshots: [] }, (e) => events.push(e), {
      provider: new MockLlmProvider({ chatScript: [{ content: [{ type: "text", text: "Top right." }] }] }),
    });
    assert.equal(await count({ kind: "run_finished", sourceId: convo.runId }), 0, "the person heard the answer live");
    // Agent mode: a capped background run.
    for (const outcome of ["succeeded", "failed"] as const) {
      const res = await agentPOST(req("/api/cursor/agent", tok(ANA), { goal: `Background ${outcome}`, maxUsd: 1 }));
      assert.equal(res.status, 200);
      const { runId } = (await res.json()) as { runId: string };
      await finishAgentRun(WS, runId, outcome);
      const kind = outcome === "succeeded" ? "run_finished" : "run_failed";
      assert.equal(await count({ kind, sourceId: runId }), 1, `${kind} for the agent-mode run`);
      const n = await prisma.notification.findFirst({ where: { workspaceId: WS, kind, sourceId: runId }, select: { title: true, href: true } });
      assert.match(n!.title, /^Cursor run (finished|failed)$/);
      assert.equal(n!.href, `/dashboard/runs/${runId}`);
    }
  });

  it("Undo this agent run reverts what a cursor run did (a note approved by voice)", async () => {
    const title = `Cursor undo ${RUN}`;
    const events: CursorSseEvent[] = [];
    const out = await runCursorTurn(owner, { transcript: "write that down as a note", screenshots: [] }, (e) => events.push(e), {
      provider: new MockLlmProvider({
        chatScript: [
          { content: [{ type: "tool_use", id: "tu_undo_note", name: "create_note", input: { title, body: "from the cursor" } }] },
          { content: [{ type: "text", text: "It's on the card." }] },
        ],
      }),
    });
    const prop = events.find((e): e is Extract<CursorSseEvent, { event: "proposal" }> => e.event === "proposal")?.data;
    assert.ok(prop, "create_note waits for an OK");
    const res = await approvePOST(req("/api/cursor/approve", tok(ANA), { approvalId: prop!.approvalId, decision: "approve", via: prop!.voiceApprovable ? "voice" : "click" }));
    assert.equal(((await res.json()) as { status: string }).status, "executed");
    const notes = () => withWorkspaceScope(WS, (tx) => tx.univerDoc.count({ where: { workspaceId: WS, kind: "note", title } }));
    assert.equal(await notes(), 1);

    const actor = { workspaceId: WS, userId: ANA, role: "owner" as const };
    const plan = await loadUndoPlan(actor, out.runId);
    assert.ok(plan.canUndo);
    const item = plan.items.find((i) => i.kind === "note");
    assert.ok(item?.revertible, "the note the cursor made is revertible");
    const { outcomes } = await executeUndo(actor, out.runId, { confirmed: true });
    assert.ok(outcomes.some((o) => o.kind === "note" && o.result === "reverted"), JSON.stringify(outcomes));
    assert.equal(await notes(), 0, "the note is gone");
  });

  it("the audit timeline shows the cursor's audit rows and its run steps", async () => {
    const page = await loadTimeline(WS, {}, null, 200);
    const authority = page.entries.filter((e) => e.source === "authority_audit_event" && /^Cursor /.test(e.action));
    assert.ok(authority.some((e) => e.action === "Cursor proposal"), authority.map((e) => e.action).join(", "));
    assert.ok(authority.some((e) => e.action === "Cursor approve"));
    assert.ok(authority.every((e) => e.target?.startsWith("Cursor run ")));
    const steps = page.entries.filter((e) => e.source === "agent_run_event" && e.target === "Cursor run");
    assert.ok(steps.length > 0, "the cursor run's steps (summaries only)");
    assert.ok(steps.every((e) => !(e.summary ?? "").includes(MARKER)), "never the screenshot");
  });
});
