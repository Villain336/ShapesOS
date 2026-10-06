// ShapesOS — Phase 17 (A2/A3, WS=model): fewer tool tokens and smaller
// context, against the REAL tool registry and the real agent loop (driven by
// MockLlmProvider scripts — no network, no database rows; MOCK).
//
//   * a lead turn's loaded tool bytes ≤ 40% of the MEASURED baseline (the
//     cache probe at 29f227e: 66,617 bytes of tool definitions, 103 tools);
//   * deferred tools stay executable: server-side search (defer_loading) and
//     the client-side search_tools fallback;
//   * every registered tool is reachable by at least one role; sub-agents
//     get only their grant's tools;
//   * tool results are capped (8,000 chars) with a fetch_more handle that
//     round-trips, and no result over the cap reaches the model;
//   * the loop sends the context-editing block;
//   * shortened descriptions kept every tool's tier (pinned snapshot).
// Run: env -u DATABASE_URL npx tsx --test lib/agents/__tests__/tool-loading.test.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import "@/lib/chat/agent"; // registers every runtime tool (delegation, ship, sites, seo, documents, browser, web, apps)
import { registerCodeTools } from "@/lib/sandbox/tools";
import { allTools, registerExtraTool, toolAction, toolGroup, TOOLS, type ToolDef } from "@/lib/chat/tools";
import { AGENT_KEYS, AGENT_MAX_GROUPS, computeGrant, type AgentKey } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { buildAnthropicParams } from "@/lib/llm/anthropic";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { memoryTranscriptStore } from "@/lib/agents/runs/transcript";
import type { ChatContentBlock, ChatRequest, ChatToolResultBlock } from "@/lib/llm/types";
import { requestTools, runAgentLoop, runToolSet, initialLoopState, type LoopContext } from "../loop";
import {
  capResult,
  DEFAULT_TOOL_RESULT_CAP,
  FETCH_MORE_TOOL,
  LEAD_CORE_TOOLS,
  pruneStored,
  SEARCH_TOOLS_TOOL,
  searchTools,
  sliceResult,
  MAX_STORED_TOTAL_CHARS,
} from "../tool-loading";

/** Measured by scripts/verify/prompt-cache.mts on the pre-Phase-17 head (29f227e): tool-definition bytes of a lead turn. */
const BASELINE_LEAD_TOOL_BYTES = 66_617;

let frobRuns = 0;
const t_frobnicate: ToolDef = {
  name: "t_frobnicate",
  description: "Frobnicate the widgets in a warehouse bin (test tool).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { bin: { type: "string", description: "Bin." } } },
  async execute() {
    frobRuns++;
    return { summary: "frobnicated" };
  },
};
const BIG = "x".repeat(19_000) + "THE-END-MARKER";
const t_big: ToolDef = {
  name: "t_big_read",
  description: "Return a very large report (test tool).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: {} },
  async execute() {
    return { summary: "big report", details: { body: BIG } };
  },
};

before(() => {
  registerCodeTools();
  registerExtraTool(t_frobnicate);
  registerExtraTool(t_big);
});

function ctx(over: Partial<LoopContext> = {}): LoopContext {
  return { projectId: "p1", workspaceId: "ws-p17", userId: "u1", role: "editor", confirmed: false, agentKey: "lead", grant: null, ...over };
}

class SearchingMock extends MockLlmProvider {
  supportsToolSearch(): boolean {
    return true;
  }
}

const toolUse = (name: string, input: Record<string, unknown> = {}, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`): ChatContentBlock => ({ type: "tool_use", id, name, input });
const lastResults = (req: ChatRequest): ChatToolResultBlock[] => {
  const m = req.messages[req.messages.length - 1];
  return typeof m.content === "string" ? [] : (m.content.filter((b) => b.type === "tool_result") as ChatToolResultBlock[]);
};

function run(provider: MockLlmProvider, over: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return runAgentLoop({
    ctx: ctx(),
    system: "You are a test agent.",
    messages: [{ role: "user", content: "do the thing" }],
    ...over,
    deps: { provider, store: memoryTranscriptStore(), persistEvents: false },
  });
}

describe("A2 — tool bytes on a lead turn", () => {
  it(`loaded tool bytes ≤ 40% of the measured baseline (${BASELINE_LEAD_TOOL_BYTES} bytes)`, () => {
    const set = runToolSet(ctx(), { mode: "default" }, {});
    const offer = requestTools(set, {}, new SearchingMock());
    assert.equal(offer.mode, "server");
    const built = buildAnthropicParams(
      "claude-opus-5-5",
      { system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, tools: offer.tools, toolSearch: true, serverTools: set.serverTools, cache: true, cacheTtl: "1h" },
      { stream: true },
    );
    const tools = (built.params as unknown as { tools: Array<Record<string, unknown>> }).tools;
    const loaded = tools.filter((t) => t.defer_loading !== true);
    const loadedBytes = Buffer.byteLength(JSON.stringify(loaded), "utf8");
    const allBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    console.log(`# lead turn: ${loaded.length} loaded tools = ${loadedBytes} bytes (${Math.round((loadedBytes / BASELINE_LEAD_TOOL_BYTES) * 100)}% of baseline); ${tools.length - loaded.length} deferred; request tools ${allBytes} bytes`);
    assert.ok(loadedBytes <= 0.4 * BASELINE_LEAD_TOOL_BYTES, `${loadedBytes} > 40% of ${BASELINE_LEAD_TOOL_BYTES}`);
    assert.ok(loaded.length <= 22, `about 15 core tools stay loaded (got ${loaded.length})`);
    for (const name of LEAD_CORE_TOOLS) assert.ok(loaded.some((t) => t.name === name), `${name} is loaded`);
    assert.ok(loaded.some((t) => t.name === FETCH_MORE_TOOL));
    for (const prefix of ["ops_", "twin_", "app_"]) {
      assert.ok(tools.filter((t) => String(t.name).startsWith(prefix)).every((t) => t.defer_loading === true || LEAD_CORE_TOOLS.has(String(t.name))), `${prefix}* deferred`);
    }
  });

  it("the client-side path (no server search) offers the loaded tools plus search_tools", () => {
    const set = runToolSet(ctx(), { mode: "default" }, {});
    const offer = requestTools(set, {}, new MockLlmProvider());
    assert.equal(offer.mode, "client");
    const names = offer.tools!.map((t) => t.name);
    assert.ok(names.includes(SEARCH_TOOLS_TOOL));
    assert.equal(offer.tools!.some((t) => t.deferLoading), false);
    assert.ok(!names.includes("ops_send_invoice"));
    const after = requestTools(set, { activatedTools: ["ops_send_invoice"] }, new MockLlmProvider());
    assert.ok(after.tools!.some((t) => t.name === "ops_send_invoice" && !t.deferLoading), "a surfaced tool stays offered");
  });

  it("build mode keeps the code + ship tools loaded; a small tool set loads everything", () => {
    const build = runToolSet(ctx({ agentKey: "actor", grant: ["workspace", "code", "ship"] }), { mode: "build" }, {});
    for (const n of ["read_file", "edit_file", "run_checks", "git_commit", "open_pull_request"]) {
      assert.equal(build.defs.find((d) => d.name === n)?.deferLoading, undefined, n);
    }
    const skill = runToolSet(ctx(), { mode: "default" }, {}, (c) => c === "get_keywords" || c === "ops_list_invoices");
    assert.equal(skill.defs.some((d) => d.deferLoading), false, "a scheduled skill's declared tools all load");
  });
});

describe("A2 — every tool reachable; sub-agents only get their grant", () => {
  it("every registered tool is offered (loaded or deferred) to at least one role", () => {
    const sets = new Map<AgentKey, Set<string>>();
    for (const a of AGENT_KEYS) {
      const grant = computeGrant({ agentKey: a }).groups;
      sets.set(a, new Set(runToolSet(ctx({ agentKey: a, grant }), { mode: "default" }, {}).canonical));
    }
    for (const t of allTools()) {
      const reachable = [...sets.values()].some((s) => s.has(t.name));
      assert.ok(reachable, `${t.name} (group ${toolGroup(t.name)}) is reachable by some role`);
    }
  });

  it("a sub-agent's tool set is inside its grant (plus the loop's fetch_more)", () => {
    for (const a of AGENT_KEYS.filter((k) => k !== "lead")) {
      const grant = computeGrant({ agentKey: a }).groups;
      const set = runToolSet(ctx({ agentKey: a, grant }), { mode: "default" }, {});
      for (const c of set.canonical) {
        if (c === FETCH_MORE_TOOL) continue;
        assert.ok((grant as readonly string[]).includes(toolGroup(c)), `${a}: ${c} (${toolGroup(c)}) outside ${grant.join(",")}`);
      }
      assert.ok(set.canonical.every((c) => AGENT_MAX_GROUPS[a].includes(toolGroup(c)) || c === FETCH_MORE_TOOL));
    }
  });
});

describe("A2 — deferred tools stay executable", () => {
  it("server-side search: deferred tools are sent with deferLoading + toolSearch, and a discovered one runs", async () => {
    frobRuns = 0;
    const provider = new SearchingMock({
      chatScript: [
        (req) => {
          assert.equal(req.toolSearch, true);
          const def = req.tools!.find((t) => t.name === "t_frobnicate");
          assert.equal(def?.deferLoading, true, "deferred, still in the request");
          return { content: [toolUse("t_frobnicate", { bin: "A1" })] };
        },
        { content: [{ type: "text", text: "Done." }] },
      ],
    });
    const out = await run(provider);
    assert.equal(out.status, "done");
    assert.equal(frobRuns, 1);
  });

  it("client-side search_tools surfaces a deferred tool, which is offered and runs on the next step", async () => {
    frobRuns = 0;
    const provider = new MockLlmProvider({
      chatScript: [
        (req) => {
          assert.ok(!req.tools!.some((t) => t.name === "t_frobnicate"), "hidden until searched");
          return { content: [toolUse(SEARCH_TOOLS_TOOL, { query: "frobnicate warehouse widgets" })] };
        },
        (req) => {
          const r = lastResults(req)[0];
          assert.match(String(r.content), /t_frobnicate/);
          assert.ok(req.tools!.some((t) => t.name === "t_frobnicate"), "offered after search");
          return { content: [toolUse("t_frobnicate", { bin: "B2" })] };
        },
        (req) => {
          assert.ok(req.tools!.some((t) => t.name === "t_frobnicate"), "still offered for the rest of the run");
          return { content: [{ type: "text", text: "Frobnicated." }] };
        },
      ],
    });
    const out = await run(provider);
    assert.equal(out.status, "done");
    assert.equal(frobRuns, 1);
    assert.ok(out.state.activatedTools?.includes("t_frobnicate"), String(out.state.activatedTools));
  });

  it("searchTools ranks by name, description and argument names; deterministic", () => {
    const set = runToolSet(ctx(), { mode: "default" }, {});
    const pool = set.defs.filter((d) => d.deferLoading);
    const inv = searchTools(pool, "send an invoice", 5).map((d) => d.name);
    assert.ok(inv.includes("ops_send_invoice"), inv.join(","));
    assert.deepEqual(searchTools(pool, "send an invoice", 5).map((d) => d.name), inv);
    assert.deepEqual(searchTools(pool, "   ", 5), []);
  });
});

describe("A3 — tool results capped with fetch_more", () => {
  it("cap + fetch_more round-trip; no tool result over the cap reaches the model", async () => {
    const seenResults: string[] = [];
    let handle = "";
    const provider = new MockLlmProvider({
      chatScript: [
        { content: [toolUse("t_big_read", {}, "tu_big")] },
        (req) => {
          const r = String(lastResults(req)[0].content);
          seenResults.push(r);
          const m = r.match(/handle "([^"]+)" and offset (\d+)/);
          assert.ok(m, "the cut-off note names the handle and offset");
          handle = m![1];
          return { content: [toolUse(FETCH_MORE_TOOL, { handle, offset: Number(m![2]) })] };
        },
        (req) => {
          const r = String(lastResults(req)[0].content);
          seenResults.push(r);
          const m = r.match(/offset (\d+)/);
          return { content: [toolUse(FETCH_MORE_TOOL, { handle, offset: Number(m![1]) })] };
        },
        (req) => {
          seenResults.push(String(lastResults(req)[0].content));
          return { content: [{ type: "text", text: "Read it all." }] };
        },
      ],
    });
    const out = await run(provider);
    assert.equal(out.status, "done");
    assert.equal(handle, "tu_big");
    for (const r of seenResults) assert.ok(r.length <= DEFAULT_TOOL_RESULT_CAP + 200, `a result of ${r.length} chars reached the model`);
    assert.ok(seenResults.at(-1)!.includes("THE-END-MARKER"), "the last slice carries the end of the result");
    assert.ok(out.state.storedResults?.tu_big, "the full text is in the saved transcript (not process memory)");
  });

  it("capResult / sliceResult / pruneStored", () => {
    assert.deepEqual(capResult("h", "short", 10), { shown: "short", stored: null });
    const c = capResult("h", "a".repeat(25), 10);
    assert.equal(c.stored, "a".repeat(25));
    assert.match(c.shown, /^a{10}\n…\[cut off: 15 more characters\. Call fetch_more with handle "h" and offset 10/);
    assert.match(sliceResult(c.stored!, "h", 10, 10).text, /offset 20/);
    assert.equal(sliceResult(c.stored!, "h", 20, 10).text, "aaaaa");
    assert.equal(sliceResult(undefined, "nope", 0, 10).ok, false);
    const big = { a: "x".repeat(MAX_STORED_TOTAL_CHARS), b: "y".repeat(10) };
    assert.deepEqual(Object.keys(pruneStored(big)), ["b"], "oldest dropped first");
  });
});

describe("A3 — server-side context editing on every loop call", () => {
  it("the loop asks for clear_tool_uses at 100k input tokens, keeping the last 6, clearing at least 20k", async () => {
    const provider = new MockLlmProvider({ chatScript: [{ content: [{ type: "text", text: "ok" }] }] });
    await run(provider);
    assert.deepEqual(provider.chatCalls[0].contextEditing, { triggerInputTokens: 100_000, keepToolUses: 6, clearAtLeastTokens: 20_000 });
    assert.equal(provider.chatCalls[0].cacheTtl, "1h", "lead → 1-hour TTL");
    assert.equal(provider.chatCalls[0].serviceTier, undefined, "lead → API default tier");
    const sub = new MockLlmProvider({ chatScript: [{ content: [{ type: "text", text: "ok" }] }] });
    await run(sub, { ctx: ctx({ agentKey: "researcher", grant: ["workspace", "web"] }) });
    assert.equal(sub.chatCalls[0].cacheTtl, "5m");
    assert.equal(sub.chatCalls[0].serviceTier, "standard_only");
  });

  it("initialLoopState carries no Phase-17 fields until they are used (old transcripts resume unchanged)", () => {
    const s = initialLoopState({ system: "s", messages: [], workload: "lead" });
    assert.equal(s.activatedTools, undefined);
    assert.equal(s.storedResults, undefined);
  });
});

describe("A2 — shortened descriptions keep every tool's tier (Phase 14 tier trap)", () => {
  // Snapshot of evaluateTier({kind: toolAction(name), description: "<name>: <description>"},
  // {automationAllows: true}) for every catalog tool, taken BEFORE any
  // Phase 17 description was shortened (2026-10-06).
  const PINNED: Record<string, number> = {"approve_autopilot_item":2,"ask_business_data":2,"automation_flow_status":2,"create_content_draft":0,"create_report":0,"design_qr_code":3,"generate_image":0,"get_alerts":2,"get_competitors":2,"get_content":2,"get_keywords":2,"get_rankings":2,"get_visibility_score":2,"get_workflows":2,"load_skill":2,"ops_accounting_report":2,"ops_approve_leave":2,"ops_close_pos_session":3,"ops_close_ticket":2,"ops_complete_manufacturing_order":3,"ops_confirm_manufacturing_order":2,"ops_convert_lead":2,"ops_convert_quote":2,"ops_create_company":2,"ops_create_contact":2,"ops_create_deal":2,"ops_create_manufacturing_order":0,"ops_create_project":2,"ops_create_task":2,"ops_create_ticket":2,"ops_create_transfer":3,"ops_draft_invoice":0,"ops_draft_purchase_order":0,"ops_draft_quote":0,"ops_draft_vendor_bill":3,"ops_events_create_event":2,"ops_events_overview":2,"ops_events_register":3,"ops_launch_workflow":2,"ops_list_companies":2,"ops_list_contacts":2,"ops_list_deals":2,"ops_list_invoices":2,"ops_list_manufacturing_orders":2,"ops_list_products":2,"ops_list_projects":2,"ops_list_purchase_orders":3,"ops_list_stock_by_location":2,"ops_list_team":2,"ops_list_tickets":2,"ops_list_workflow_runs":2,"ops_log_time":2,"ops_log_work_time":2,"ops_mark_invoice_paid":3,"ops_move_deal_stage":2,"ops_operations_summary":2,"ops_payroll_draft_run":0,"ops_payroll_overview":2,"ops_payroll_request_approval":3,"ops_payroll_request_posting":3,"ops_pos_overview":2,"ops_post_journal_entry":3,"ops_record_payment":3,"ops_reply_ticket":2,"ops_request_leave":2,"ops_send_invoice":3,"ops_set_reorder_rule":3,"ops_store_list_product":2,"ops_store_overview":2,"ops_submit_expense_claim":2,"research_keywords":0,"research_question":0,"run_seo_audit":0,"run_workflow":2,"search_workspace":0,"trigger_automation_flow":2,"twin_assign_equipment":1,"twin_book_dock":1,"twin_draft_layout":0,"twin_find":2,"twin_site_state":2,
    // Phase 18.2 (WS=content): the core apps' tools, pinned at their first appearance (read-only = 0;
    // create_note = write_internal_note, Tier 1; share_file_link = share_file_externally, Tier 2).
    "read_note":0,"create_note":1,"list_file_versions":0,"share_file_link":2,"list_processes":0,"list_store_items":0};

  it("every catalog tool evaluates to the same tier as before", () => {
    assert.equal(Object.keys(PINNED).length, TOOLS.length, "the snapshot covers the whole catalog");
    for (const t of TOOLS) {
      const tier = evaluateTier({ kind: toolAction(t.name), description: `${t.name}: ${t.description}` }, { automationAllows: true, smallActionThresholdCents: 10_000 });
      assert.equal(tier, PINNED[t.name], t.name);
    }
  });
});
