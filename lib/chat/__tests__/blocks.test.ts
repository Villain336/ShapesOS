// ShapesOS — Phase 22 (chat): the transcript block model (PURE).
//
// Every AG-UI frame of a chat turn folds into one typed block list (user,
// text, thinking, tool, approval, genui, delegation, notice), and a persisted
// thread (AiChatMessage rows) maps onto the SAME block list, so a reloaded
// thread looks like the live one. Run:
//   env -u DATABASE_URL npx tsx --test lib/chat/__tests__/blocks.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blocksFromThread,
  emptyBlockFold,
  foldBlockFrame,
  foldBlockFrames,
  isProposalText,
  type ChatBlock,
  type ThreadMessageRow,
} from "../blocks";

const meta = (marketr: Record<string, unknown>) => ({ metadata: { marketr: { runId: "agui1", ...marketr } } });
const text = (id: string, delta: string) => ({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta });

function kinds(blocks: readonly ChatBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

describe("foldBlockFrame: one block per thing that happened, in order", () => {
  it("text streams into one text block per AG-UI message, closed by TEXT_MESSAGE_END", () => {
    let s = emptyBlockFold();
    s = foldBlockFrame(s, { type: "RUN_STARTED" });
    s = foldBlockFrame(s, { type: "TEXT_MESSAGE_START", messageId: "m1" });
    s = foldBlockFrame(s, text("m1", "Hello "));
    s = foldBlockFrame(s, text("m1", "world"));
    assert.deepEqual(kinds(s.blocks), ["text"]);
    const t = s.blocks[0] as Extract<ChatBlock, { kind: "text" }>;
    assert.equal(t.text, "Hello world");
    assert.equal(t.streaming, true);
    s = foldBlockFrame(s, { type: "TEXT_MESSAGE_END", messageId: "m1" });
    assert.equal((s.blocks[0] as Extract<ChatBlock, { kind: "text" }>).streaming, false);
    s = foldBlockFrame(s, { type: "RUN_FINISHED" });
    assert.equal(s.done, true);
  });

  it("a tool call is one block: START opens it, ARGS stream in, RESULT fills it (typed renderer + payload)", () => {
    const frames = [
      { type: "RUN_STARTED" },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu1", toolCallName: "get_keywords" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu1", delta: '{"limit"' },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu1", delta: ": 5}" },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu1" },
      {
        type: "TOOL_CALL_RESULT",
        toolCallId: "agui1:tool:tu1",
        content: "5 keywords",
        ...meta({ status: "executed", toolUseId: "tu1", ui: "records", payload: { rows: [{ keyword: "espresso" }] }, agentKey: "lead" }),
      },
      { type: "RUN_FINISHED" },
    ];
    const s = foldBlockFrames(emptyBlockFold(), frames);
    assert.deepEqual(kinds(s.blocks), ["tool"]);
    const b = s.blocks[0] as Extract<ChatBlock, { kind: "tool" }>;
    assert.equal(b.tool, "get_keywords");
    assert.equal(b.toolUseId, "tu1");
    assert.deepEqual(b.args, { limit: 5 });
    assert.equal(b.argsComplete, true);
    assert.equal(b.status, "executed");
    assert.equal(b.resultText, "5 keywords");
    assert.equal(b.ui, "records");
    assert.deepEqual(b.payload, { rows: [{ keyword: "espresso" }] });
    assert.equal(b.agentKey, "lead");
  });

  it("a RESULT that arrives before its START (out of order) still makes exactly one block", () => {
    const frames = [
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu2", content: "done", ...meta({ status: "executed", toolUseId: "tu2" }) },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu2", toolCallName: "get_alerts" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu2", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu2" },
    ];
    const s = foldBlockFrames(emptyBlockFold(), frames);
    assert.deepEqual(kinds(s.blocks), ["tool"]);
    const b = s.blocks[0] as Extract<ChatBlock, { kind: "tool" }>;
    assert.equal(b.tool, "get_alerts");
    assert.equal(b.status, "executed");
    assert.equal(b.resultText, "done");
  });

  it("a resumed stream that re-announces a tool call or re-sends text does not duplicate blocks", () => {
    const start = [
      { type: "RUN_STARTED" },
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      text("m1", "Looking"),
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu3", toolCallName: "get_rankings" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu3", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu3" },
    ];
    const resumed = [
      // The replica announces the same call again, then the result and the rest of the text.
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu3", toolCallName: "get_rankings" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu3", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu3" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu3", content: "3 rankings", ...meta({ status: "executed", toolUseId: "tu3" }) },
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      text("m1", " at rankings"),
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED" },
    ];
    const s = foldBlockFrames(foldBlockFrames(emptyBlockFold(), start), resumed);
    assert.deepEqual(kinds(s.blocks), ["text", "tool"]);
    assert.equal((s.blocks[0] as Extract<ChatBlock, { kind: "text" }>).text, "Looking at rankings");
    assert.equal((s.blocks[1] as Extract<ChatBlock, { kind: "tool" }>).resultText, "3 rankings");
  });

  it("a held call makes an approval block from marketr.toolProposal; several proposals of one turn share the block", () => {
    const frames = [
      { type: "RUN_STARTED" },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu4", toolCallName: "run_seo_audit" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu4", delta: '{"pages":20}' },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu4" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu4", content: "Proposed run_seo_audit (spend) — awaiting confirmation", ...meta({ status: "pending_confirmation", toolUseId: "tu4" }) },
      { type: "CUSTOM", name: "marketr.toolProposal", value: { tool: "run_seo_audit", toolCallId: "agui1:tool:tu4", toolUseId: "tu4", args: { pages: 20 }, toolKind: "spend", tier: 2, autoAction: "run_audit", agentKey: "lead", runId: "run9", needsClick: false } },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu5", toolCallName: "ops_record_payment" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu5", delta: '{"amount":100}' },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu5" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu5", content: "Proposed ops_record_payment (publish) — awaiting confirmation", ...meta({ status: "pending_confirmation", toolUseId: "tu5" }) },
      { type: "CUSTOM", name: "marketr.toolProposal", value: { tool: "ops_record_payment", toolCallId: "agui1:tool:tu5", toolUseId: "tu5", args: { amount: 100 }, toolKind: "publish", tier: 3, agentKey: "lead", runId: "run9", needsClick: true } },
      { type: "TEXT_MESSAGE_START", messageId: "m2" },
      text("m2", "2 actions are waiting for your OK:\n\n1. I'd like to run **run_seo_audit** (spend action) with pages=20.\n2. I'd like to run **ops_record_payment**.\n\nReply **yes** to confirm all 2, or send a new message to cancel."),
      { type: "TEXT_MESSAGE_END", messageId: "m2" },
      { type: "RUN_FINISHED" },
    ];
    const s = foldBlockFrames(emptyBlockFold(), frames);
    // The "reply yes" prose is the old fallback: the approval block replaces it.
    assert.deepEqual(kinds(s.blocks), ["tool", "tool", "approval"]);
    const a = s.blocks[2] as Extract<ChatBlock, { kind: "approval" }>;
    assert.equal(a.items.length, 2);
    assert.deepEqual(a.items.map((i) => [i.tool, i.toolUseId, i.tier, i.needsClick, i.autoAction ?? null]), [
      ["run_seo_audit", "tu4", 2, false, "run_audit"],
      ["ops_record_payment", "tu5", 3, true, null],
    ]);
    assert.deepEqual(a.items[0]!.args, { pages: 20 });
    assert.equal((s.blocks[0] as Extract<ChatBlock, { kind: "tool" }>).status, "pending_confirmation");
    assert.equal(s.awaiting, true);
  });

  it("a confirmed result for a held call (the decision's stream) fills the SAME tool block and settles the approval item", () => {
    const held = foldBlockFrames(emptyBlockFold(), [
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu6", toolCallName: "create_report" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu6", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu6" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu6", content: "Proposed", ...meta({ status: "pending_confirmation", toolUseId: "tu6" }) },
      { type: "CUSTOM", name: "marketr.toolProposal", value: { tool: "create_report", toolCallId: "agui1:tool:tu6", toolUseId: "tu6", args: {}, toolKind: "spend", tier: 2, needsClick: false } },
      { type: "RUN_FINISHED" },
    ]);
    // A new stream (new AG-UI run id) carries the confirmed execution of tu6.
    const s = foldBlockFrames(held, [
      { type: "RUN_STARTED" },
      { type: "TOOL_CALL_START", toolCallId: "agui2:tool:tu6", toolCallName: "create_report" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui2:tool:tu6", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "agui2:tool:tu6" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui2:tool:tu6", content: "Report ready", ...meta({ runId: "agui2", status: "executed", confirmed: true, toolUseId: "tu6", ui: "file", payload: { fileId: "f1" } }) },
      { type: "TEXT_MESSAGE_START", messageId: "m3" },
      text("m3", "Here is the report."),
      { type: "TEXT_MESSAGE_END", messageId: "m3" },
      { type: "RUN_FINISHED" },
    ]);
    assert.deepEqual(kinds(s.blocks), ["tool", "approval", "text"]);
    const t = s.blocks[0] as Extract<ChatBlock, { kind: "tool" }>;
    assert.equal(t.status, "executed");
    assert.equal(t.confirmed, true);
    assert.equal(t.resultText, "Report ready");
    assert.equal(t.ui, "file");
    const a = s.blocks[1] as Extract<ChatBlock, { kind: "approval" }>;
    assert.equal(a.items[0]!.decision, "approved");
    assert.equal(s.awaiting, false);
  });

  it("thinking, cached answers, delegation, errors and shared state each have a place", () => {
    let s = foldBlockFrames(emptyBlockFold(), [
      { type: "RUN_STARTED" },
      { type: "STATE_SNAPSHOT", snapshot: { calendar: { rows: [] } } },
      { type: "CUSTOM", name: "marketr.thinking", value: { step: 1, state: "started" } },
    ]);
    assert.deepEqual(kinds(s.blocks), ["thinking"]);
    assert.equal((s.blocks[0] as Extract<ChatBlock, { kind: "thinking" }>).active, true);
    s = foldBlockFrames(s, [
      { type: "CUSTOM", name: "marketr.thinking", value: { step: 1, state: "ended", text: "Compared the two plans." } },
      { type: "STATE_DELTA", delta: [{ op: "replace", path: "/calendar/rows", value: [{ id: "r1" }] }] },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu7", toolCallName: "delegate_tasks" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu7", delta: '{"goal":"Audit"}' },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu7" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu7", content: "Started 2 sub-agents", ...meta({ status: "executed", toolUseId: "tu7", delegation: { parentRunId: "run1", planId: "p1", tasks: 2, goal: "Audit" } }) },
      { type: "CUSTOM", name: "marketr.cached", value: { question: "q" } },
      { type: "TEXT_MESSAGE_START", messageId: "m4" },
      text("m4", "Working on it."),
      { type: "TEXT_MESSAGE_END", messageId: "m4" },
      { type: "RUN_ERROR", message: "model unavailable" },
    ]);
    assert.deepEqual(kinds(s.blocks), ["thinking", "tool", "delegation", "text", "notice"]);
    const th = s.blocks[0] as Extract<ChatBlock, { kind: "thinking" }>;
    assert.equal(th.active, false);
    assert.equal(th.text, "Compared the two plans.");
    const d = s.blocks[2] as Extract<ChatBlock, { kind: "delegation" }>;
    assert.deepEqual([d.planId, d.parentRunId, d.tasks, d.goal], ["p1", "run1", 2, "Audit"]);
    assert.equal((s.blocks[3] as Extract<ChatBlock, { kind: "text" }>).cached, true);
    const n = s.blocks[4] as Extract<ChatBlock, { kind: "notice" }>;
    assert.equal(n.tone, "error");
    assert.match(n.text, /model unavailable/);
    assert.deepEqual(s.sharedState, { calendar: { rows: [{ id: "r1" }] } });
    assert.equal(s.done, true);
  });

  it("render_ui streams its program into a genui block while the arguments arrive", () => {
    let s = foldBlockFrames(emptyBlockFold(), [
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu8", toolCallName: "render_ui" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu8", delta: '{"program":"root = Table(' },
    ]);
    assert.deepEqual(kinds(s.blocks), ["genui"]);
    let g = s.blocks[0] as Extract<ChatBlock, { kind: "genui" }>;
    assert.equal(g.program, "root = Table(");
    assert.equal(g.streaming, true);
    s = foldBlockFrames(s, [
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu8", delta: '[\\"a\\"])"}' },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu8" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu8", content: "Rendered", ...meta({ status: "executed", toolUseId: "tu8", ui: "openui", payload: { program: 'root = Table(["a"])' } }) },
    ]);
    g = s.blocks[0] as Extract<ChatBlock, { kind: "genui" }>;
    assert.equal(g.program, 'root = Table(["a"])');
    assert.equal(g.streaming, false);
    assert.equal(g.status, "executed");
  });
});

describe("blocksFromThread: a persisted thread renders from the same block model", () => {
  const row = (id: string, role: string, content: string, toolCalls: unknown[] | null = null): ThreadMessageRow => ({
    id,
    role,
    content,
    toolCalls: toolCalls as ThreadMessageRow["toolCalls"],
    createdAt: "2026-10-20T10:00:00.000Z",
  });

  it("maps user, tool and assistant rows to blocks in order, with the user's text first", () => {
    const blocks = blocksFromThread([
      row("u1", "user", "What ranks?"),
      row("t1", "tool", "3 rankings", [{ tool: "get_rankings", args: {}, status: "executed", resultSummary: "3 rankings", toolUseId: "tu1", ui: "records", payload: { rows: [] } }]),
      row("a1", "assistant", "Three pages rank.", [{ tool: "get_rankings", args: {}, status: "executed", resultSummary: "3 rankings", toolUseId: "tu1" }]),
    ]);
    assert.deepEqual(kinds(blocks), ["user", "tool", "text"]);
    assert.equal((blocks[0] as Extract<ChatBlock, { kind: "user" }>).text, "What ranks?");
    const t = blocks[1] as Extract<ChatBlock, { kind: "tool" }>;
    assert.equal(t.ui, "records");
    assert.equal(t.status, "executed");
    assert.equal((blocks[2] as Extract<ChatBlock, { kind: "text" }>).text, "Three pages rank.");
  });

  it("REGRESSION: a confirmed call saved as a tool row AND leading the reply's toolCalls renders once", () => {
    const exec = { tool: "run_seo_audit", args: { pages: 20 }, status: "executed", resultSummary: "Audit done", confirmed: true, agentKey: "lead", toolUseId: "tu4" };
    const blocks = blocksFromThread([
      row("u1", "user", "yes"),
      row("t1", "tool", "Audit done", [exec]),
      row("a1", "assistant", "Done. Audit done", [exec]),
    ]);
    assert.deepEqual(kinds(blocks), ["user", "tool", "text"]);
    // The old rows (before Phase 22) carried no toolUseId on the reply's copy: still one block.
    const legacy = blocksFromThread([
      row("u1", "user", "yes"),
      row("t1", "tool", "Audit done", [{ ...exec, toolUseId: undefined }]),
      row("a1", "assistant", "Done. Audit done", [{ ...exec, toolUseId: undefined }]),
    ]);
    assert.deepEqual(kinds(legacy), ["user", "tool", "text"]);
  });

  it("a pending proposal on the last assistant row is an approval block, and the 'reply yes' prose is hidden", () => {
    const pending = { tool: "create_report", args: { period: "Sep" }, status: "pending_confirmation", resultSummary: "Proposed create_report (spend) — awaiting confirmation", toolUseId: "tu9", runId: "run9", autoAction: "create_report", tier: 2, toolKind: "spend" };
    const blocks = blocksFromThread([
      row("u1", "user", "Make the report"),
      row("a1", "assistant", "I'd like to run **create_report** (spend action) with period=\"Sep\".\nBuilds a PDF.\nReply **yes** to confirm, or send a new message to cancel.", [pending]),
    ]);
    assert.deepEqual(kinds(blocks), ["user", "tool", "approval"]);
    const a = blocks[2] as Extract<ChatBlock, { kind: "approval" }>;
    assert.equal(a.items[0]!.tool, "create_report");
    assert.equal(a.items[0]!.decision, "pending");
    assert.equal(a.items[0]!.needsClick, false);
    assert.equal(a.items[0]!.runId, "run9");
  });

  it("the block list of a persisted turn equals the block list folded live from its frames", () => {
    const live = foldBlockFrames(emptyBlockFold(), [
      { type: "RUN_STARTED" },
      { type: "TOOL_CALL_START", toolCallId: "agui1:tool:tu1", toolCallName: "get_keywords" },
      { type: "TOOL_CALL_ARGS", toolCallId: "agui1:tool:tu1", delta: '{"limit":5}' },
      { type: "TOOL_CALL_END", toolCallId: "agui1:tool:tu1" },
      { type: "TOOL_CALL_RESULT", toolCallId: "agui1:tool:tu1", content: "5 keywords", ...meta({ status: "executed", toolUseId: "tu1", ui: "records", payload: { rows: [{ k: 1 }] }, agentKey: "lead" }) },
      { type: "TEXT_MESSAGE_START", messageId: "m1" },
      text("m1", "Five keywords matter."),
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED" },
    ]);
    const persisted = blocksFromThread([
      row("t1", "tool", "5 keywords", [{ tool: "get_keywords", args: { limit: 5 }, status: "executed", resultSummary: "5 keywords", toolUseId: "tu1", ui: "records", payload: { rows: [{ k: 1 }] }, agentKey: "lead" }]),
      row("a1", "assistant", "Five keywords matter.", [{ tool: "get_keywords", args: { limit: 5 }, status: "executed", resultSummary: "5 keywords", toolUseId: "tu1", agentKey: "lead" }]),
    ]);
    const strip = (b: ChatBlock) => {
      const { id: _id, ...rest } = b as ChatBlock & { id: string };
      return JSON.parse(JSON.stringify(rest, (k, v) => (k === "toolCallId" || k === "messageId" || k === "createdAt" ? undefined : v)));
    };
    assert.deepEqual(live.blocks.map(strip), persisted.map(strip));
  });

  it("a decision row (approve / deny from the block) is a notice, not a user bubble", () => {
    const blocks = blocksFromThread([
      row("u2", "user", "Approved run_seo_audit", [{ tool: "chat_decision", args: { decision: "approve", tool: "run_seo_audit" }, status: "executed" }]),
    ]);
    assert.deepEqual(kinds(blocks), ["notice"]);
    assert.equal((blocks[0] as Extract<ChatBlock, { kind: "notice" }>).tone, "decision");
  });
});

describe("isProposalText", () => {
  it("recognises the pre-Phase-22 confirmation prose and nothing else", () => {
    assert.equal(isProposalText("I'd like to run **create_report** (spend action).\nReply **yes** to confirm, or send a new message to cancel."), true);
    assert.equal(isProposalText("3 actions are waiting for your OK:\n\n1. …"), true);
    assert.equal(isProposalText("The Writer sub-agent would like to run **create_content_draft** (spend action) with topic=\"x\"."), true);
    assert.equal(isProposalText("Here are your rankings."), false);
  });
});
