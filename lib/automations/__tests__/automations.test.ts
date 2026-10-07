// ShapesOS — Phase 18.3 (WS=flow): the Automations app's pure parts.
//   - the trigger catalogue lists every outbound webhook event, scheduler
//     event, canvas trigger and alert trigger exactly once (generated)
//   - the action catalogue lists every agent tool once with the Store's
//     tier; Tier 3 / destructive / never-auto tools "always ask"
//   - the list adapters per system: names, triggers, run states (agent-run
//     marking only for scheduled skills), next runs, and that on/off and
//     Run now point at each system's OWN route
//   - "Describe it": drafts validate against the canvas / scheduler schemas;
//     a Tier 3 auto step, autopilot schedules, unknown skills / tools /
//     node types, cycles and bad cron are rejected; the mock drafter is
//     labelled and valid; the graph body matches the nodes route's shape

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SUBSCRIBABLE_EVENT_TYPES } from "@/lib/webhooks/events";
import { EVENT_SOURCES } from "@/lib/scheduler/events";
import { NODE_CATALOG } from "@/lib/workflow/catalog";
import { TRIGGERS as ALERT_TRIGGERS } from "@/lib/alerts/triggers";
import { allTools, toolAction } from "@/lib/chat/tools";
import { agentToolTier } from "@/lib/store/catalogue";
import { NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";
import { CRON_JOBS } from "@/lib/cron/jobs";
import { actionCatalog, triggerCatalog } from "../catalog";
import {
  canUse,
  describeCron,
  filterAutomations,
  toActivepiecesItem,
  toAlertRuleItem,
  toAutopilotItem,
  toCronJobItems,
  toOpsWorkflowItems,
  toScheduleItem,
  toWorkflowItem,
} from "../list";
import { cronFromText, draftAutomation, draftPrompt, mockDraft, parseDraftJson, validateDraft, workflowGraphBody, type DraftContext } from "../describe";

const count = <T>(xs: T[], pred: (x: T) => boolean) => xs.filter(pred).length;

describe("trigger catalogue", () => {
  const cat = triggerCatalog();
  it("has every outbound webhook event, scheduler event, canvas and alert trigger exactly once", () => {
    for (const t of SUBSCRIBABLE_EVENT_TYPES) assert.equal(count(cat, (e) => e.id === `webhook_event:${t}`), 1, t);
    for (const s of EVENT_SOURCES) assert.equal(count(cat, (e) => e.id === `scheduler_event:${s}`), 1, s);
    for (const n of NODE_CATALOG.trigger) if (n.type !== "schedule") assert.equal(count(cat, (e) => e.id === `canvas:${n.type}`), 1, n.type);
    for (const a of ALERT_TRIGGERS) assert.equal(count(cat, (e) => e.id === `alert:${a.key}`), 1, a.key);
    assert.equal(count(cat, (e) => e.source === "schedule"), 1);
    assert.equal(count(cat, (e) => e.source === "inbound_mail"), 1);
    assert.equal(count(cat, (e) => e.source === "slack_mention"), 1);
    assert.equal(new Set(cat.map((e) => e.id)).size, cat.length, "ids unique");
    assert.ok(!cat.some((e) => e.key === "webhook.ping"), "the test ping is not a trigger");
    assert.ok(cat.every((e) => e.engines.length > 0 && e.label && e.description));
  });
});

describe("action catalogue", () => {
  const tools = allTools();
  const cat = actionCatalog(tools);
  it("lists every agent tool once with the Store's tier; Tier 3 / destructive always ask", () => {
    for (const t of tools) {
      const rows = cat.filter((a) => a.name === t.name);
      assert.equal(rows.length, 1, t.name);
      const want = agentToolTier(t, toolAction(t.name), NEVER_AUTO_ACTIONS);
      assert.equal(rows[0]!.tier, want.tier, `${t.name} tier`);
      assert.equal(rows[0]!.alwaysAsks, want.alwaysAsks, `${t.name} alwaysAsks`);
      if (t.kind === "safe") assert.equal(rows[0]!.tier, 0);
      if (rows[0]!.tier === 3 || t.kind === "destructive") assert.equal(rows[0]!.alwaysAsks, true, `${t.name} always asks`);
    }
    assert.ok(cat.some((a) => a.tier === 3), "the registry has Tier 3 tools and they show");
    assert.ok(cat.some((a) => a.name === "canvas:run_agent_tool" && a.engine === "workflow"));
    // A synthetic spend tool is Tier 3, always asks.
    const spend = actionCatalog([{ name: "x_purchase_ads", description: "Purchase ad inventory", kind: "spend" }])[0]!;
    assert.equal(spend.tier, 3);
    assert.equal(spend.alwaysAsks, true);
  });
});

describe("list adapters", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("workflow: triggers from its nodes, neutral run state, next run, its own routes", () => {
    const i = toWorkflowItem(
      {
        id: "wf1", name: "Weekly audit", status: "active", enabled: true, schedule: "0 9 * * 1", timezone: "UTC", createdBy: "u1",
        project: { id: "p1", name: "Site" }, nodes: [{ kind: "trigger", type: "schedule" }, { kind: "trigger", type: "rank_drop" }],
        lastRun: { startedAt: now, status: "waiting_approval" },
      },
      now,
    );
    assert.equal(i.id, "workflow:wf1");
    assert.match(i.trigger, /Cron 0 9 \* \* 1 \(UTC\) · Keyword rank drop/);
    assert.deepEqual(i.lastRun, { at: now.toISOString(), state: "needs_you", agentRun: false });
    assert.equal(i.nextRunAt, "2026-10-12T09:00:00.000Z");
    assert.equal(i.enabled, true);
    assert.deepEqual(i.toggle?.off, { method: "PATCH", url: "/api/workflows/wf1", body: { enabled: false } });
    assert.deepEqual(i.run, { method: "POST", url: "/api/workflows/wf1/run", body: {}, minRole: "editor" });
    const draft = toWorkflowItem({ id: "wf2", name: "Draft", status: "draft", enabled: true, schedule: null, timezone: "UTC", createdBy: null, project: { id: "p1", name: "Site" }, nodes: [{ kind: "trigger", type: "manual" }], lastRun: null }, now);
    assert.equal(draft.enabled, false, "a draft workflow is off");
    assert.equal(draft.nextRunAt, null);
  });

  it("scheduled skill: an AGENT run (status shape), status on/off through PATCH /api/schedules/[id]", () => {
    const i = toScheduleItem({
      id: "s1", workspaceId: "w1", status: "paused", triggerType: "event", cronExpr: null, timezone: "UTC", eventSource: "rank_drop", nextRunAt: null, createdBy: "u1",
      skill: { name: "Rank watcher" }, project: null, lastRun: { startedAt: now, status: "awaiting_approval" },
    });
    assert.equal(i.trigger, "When: Rank drop");
    assert.deepEqual(i.lastRun, { at: now.toISOString(), state: "needs_you", agentRun: true });
    assert.equal(i.enabled, false);
    assert.deepEqual(i.toggle?.on, { method: "PATCH", url: "/api/schedules/s1", body: { workspaceId: "w1", status: "active" } });
    assert.equal(i.run, null);
    assert.match(i.href, /automations\?item=scheduled_skill:s1/);
  });

  it("autopilot, alert rules, Activepieces, ops workflows, cron jobs", () => {
    const a = toAutopilotItem({ id: "r1", name: "Refresh", source: "decay", cadence: "weekly", enabled: true, project: { id: "p1", name: "Site" }, lastRun: { startedAt: now, status: "killed" } });
    assert.equal(a.trigger, "Every week");
    assert.equal(a.lastRun?.state, "cancelled");
    assert.deepEqual(a.run, { method: "POST", url: "/api/autopilot/runs", body: { projectId: "p1", ruleId: "r1" }, minRole: "editor" });
    const al = toAlertRuleItem({ id: "al1", name: "Rank alert", trigger: "rank_drop", enabled: false, lastFiredAt: null });
    assert.equal(al.trigger, "Keyword rank drop");
    assert.deepEqual(al.toggle?.on.body, { enabled: true });
    const ap = toActivepiecesItem({ id: "b1", flowId: "f1", boundBy: "u1", createdAt: now });
    assert.equal(ap.toggle, null);
    assert.equal(ap.run?.url, "/api/integrations/activepieces/flows/f1/trigger");
    const ops = toOpsWorkflowItems(new Map([["order-payment-fulfillment", { createdAt: now, status: "compensated" }]]));
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.toggle, null);
    assert.equal(ops[0]!.lastRun?.state, "cancelled");
    const cron = toCronJobItems(new Map(), now);
    assert.equal(cron.length, CRON_JOBS.length);
    assert.ok(cron.every((c) => c.readOnly && c.toggle === null && c.run === null && c.nextRunAt));
  });

  it("filters by kind, state, project and text; role hints", () => {
    const items = [
      toAlertRuleItem({ id: "1", name: "Rank alert", trigger: "rank_drop", enabled: true, lastFiredAt: null }),
      toAlertRuleItem({ id: "2", name: "Review alert", trigger: "negative_review", enabled: false, lastFiredAt: null }),
      toAutopilotItem({ id: "r1", name: "Refresh", source: "decay", cadence: "daily", enabled: true, project: { id: "p1", name: "Site" }, lastRun: null }),
    ];
    assert.equal(filterAutomations(items, { kind: "alert_rule" }).length, 2);
    assert.equal(filterAutomations(items, { state: "off" }).length, 1);
    assert.equal(filterAutomations(items, { projectId: "p1" }).length, 1);
    assert.equal(filterAutomations(items, { q: "review" }).length, 1);
    assert.equal(canUse("viewer", "editor"), false);
    assert.equal(canUse("admin", "editor"), true);
    assert.equal(describeCron(null), "Manual");
  });
});

describe("describe it", () => {
  const ctx: DraftContext = { workspaceId: "w1", projects: [{ id: "p1", name: "Site" }], skills: [{ id: "sk1", name: "Ticket digest", description: "Summarise new tickets" }], timezone: "Europe/Madrid" };
  const tools = allTools();
  const tier3 = actionCatalog(tools).find((a) => a.engine === "agent_tool" && a.alwaysAsks)!;
  const flow = (nodes: unknown[], edges: unknown[] = []) => ({ format: "workflow", name: "x", why: "y", workflow: { projectId: "p1", timezone: "UTC", nodes, edges } });
  const trig = { key: "t", kind: "trigger", type: "schedule", label: "S", config: { cron: "0 9 * * 1" } };

  it("cron from words", () => {
    assert.equal(cronFromText("every Monday, summarise new tickets"), "0 9 * * 1");
    assert.equal(cronFromText("daily at 7:30 pm"), "30 19 * * *");
    assert.equal(cronFromText("cada viernes a las 8"), "0 8 * * 5");
    assert.equal(cronFromText("hourly"), "0 * * * *");
    assert.equal(cronFromText("whenever"), null);
  });

  it("a schedule draft validates; always supervised; unknown skill / autopilot / bad cron rejected", () => {
    const ok = validateDraft({ format: "schedule", name: "Digest", why: "w", schedule: { skillId: "sk1", triggerType: "cron", cronExpr: "0 9 * * 1", timezone: "Europe/Madrid" } }, ctx, tools);
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.draft.format === "schedule" && ok.draft.schedule.approvalMode, "supervised");
    const auto = validateDraft({ format: "schedule", schedule: { skillId: "sk1", triggerType: "cron", cronExpr: "0 9 * * 1", approvalMode: "autopilot" } }, ctx, tools);
    assert.equal(auto.ok, false);
    assert.match((auto as { problems: string[] }).problems.join(), /always supervised/);
    assert.equal(validateDraft({ format: "schedule", schedule: { skillId: "nope", triggerType: "cron", cronExpr: "0 9 * * 1" } }, ctx, tools).ok, false);
    assert.equal(validateDraft({ format: "schedule", schedule: { skillId: "sk1", triggerType: "cron", cronExpr: "99 9 * * 1" } }, ctx, tools).ok, false);
    assert.equal(validateDraft({ format: "schedule", schedule: { skillId: "sk1", triggerType: "event", eventSource: "moon_phase" } }, ctx, tools).ok, false);
    assert.ok(validateDraft({ format: "schedule", schedule: { skillId: "sk1", triggerType: "event", eventSource: "rank_drop" } }, ctx, tools).ok);
  });

  it("a workflow draft can't include a step that would auto-run a Tier 3 tool", () => {
    const bad = validateDraft(flow([trig, { key: "a", kind: "action", type: "run_agent_tool", label: "Pay", config: { tool: tier3.name } }], [{ from: "t", to: "a" }]), ctx, tools);
    assert.equal(bad.ok, false);
    assert.match((bad as { problems: string[] }).problems.join(), /always asks a person/);
    const good = validateDraft(flow([trig, { key: "a", kind: "action", type: "run_agent_tool", label: "Search", config: { tool: "search_workspace", args: { query: "tickets" } } }], [{ from: "t", to: "a" }]), ctx, tools);
    assert.ok(good.ok, JSON.stringify(good));
    assert.equal(good.ok && good.draft.format === "workflow" && typeof good.draft.workflow.nodes[1]!.config.args, "string", "args stored as the canvas's JSON text");
    assert.equal(validateDraft(flow([trig, { key: "a", kind: "action", type: "run_agent_tool", label: "?", config: { tool: "no_such_tool" } }]), ctx, tools).ok, false);
  });

  it("rejects unknown node types, missing triggers / fields, bad edges and cycles", () => {
    assert.equal(validateDraft(flow([{ key: "a", kind: "action", type: "teleport", label: "x" }]), ctx, tools).ok, false);
    assert.equal(validateDraft(flow([{ key: "a", kind: "action", type: "send_alert", label: "x", config: { title: "t" } }]), ctx, tools).ok, false, "no trigger");
    assert.equal(validateDraft(flow([trig, { key: "a", kind: "action", type: "send_alert", label: "x", config: {} }], [{ from: "t", to: "a" }]), ctx, tools).ok, false, "missing required title");
    assert.equal(validateDraft(flow([trig], [{ from: "t", to: "ghost" }]), ctx, tools).ok, false);
    const a = { key: "a", kind: "action", type: "send_alert", label: "x", config: { title: "t" } };
    const b = { key: "b", kind: "action", type: "send_alert", label: "y", config: { title: "t" } };
    assert.equal(validateDraft(flow([trig, a, b], [{ from: "t", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" }]), ctx, tools).ok, false, "cycle");
    assert.equal(validateDraft({ ...flow([trig]), workflow: { projectId: "other-ws-project", nodes: [trig] } }, ctx, tools).ok, false, "another workspace's project");
    assert.equal(validateDraft({ format: "lambda" }, ctx, tools).ok, false);
  });

  it("the mock drafter is labelled, valid, and picks a schedule when a skill fits; a workflow otherwise", async () => {
    const llm = { isLive: false, generate: async () => assert.fail("the mock never calls a model") };
    const r = await draftAutomation("every Monday, summarise new tickets and post to #support", ctx, { llm, tools });
    assert.equal(r.mock, true);
    assert.equal(r.draft?.format, "schedule");
    assert.match(r.draft!.why, /^Mock draft/);
    const noSkills = { ...ctx, skills: [] };
    const w = mockDraft("every day at 8 check new leads", noSkills);
    assert.equal(w.format, "workflow");
    assert.ok(validateDraft(w, noSkills, tools).ok);
    const empty = await draftAutomation("   ", ctx, { llm, tools });
    assert.equal(empty.draft, null);
  });

  it("a live model's answer is parsed and validated (never trusted as is)", async () => {
    const llm = { isLive: true, generate: async (p: string) => { assert.match(p, /never include a step that spends money/i); return "Sure! ```json\n" + JSON.stringify({ format: "schedule", name: "D", why: "skill fits", schedule: { skillId: "sk1", triggerType: "cron", cronExpr: "0 9 * * 1", timezone: "UTC", approvalMode: "autopilot" } }) + "\n```"; } };
    const r = await draftAutomation("weekly digest", ctx, { llm, tools });
    assert.equal(r.draft, null, "an autopilot schedule from the model is refused");
    assert.equal(r.mock, false);
    assert.equal(parseDraftJson("no json"), null);
    assert.doesNotMatch(draftPrompt("x", ctx, tools), new RegExp(`- ${tier3.name} \\(`), "Tier 3 tools are not offered to the model");
  });

  it("the graph body matches PUT /api/workflows/[id]/nodes (tmp ids, numeric positions, edge ids)", () => {
    const w = mockDraft("every day check leads", { ...ctx, skills: [] });
    assert.equal(w.format, "workflow");
    const body = workflowGraphBody((w as Extract<typeof w, { format: "workflow" }>).workflow);
    assert.ok(body.nodes.every((n) => String(n.id).startsWith("tmp-") && typeof n.positionX === "number" && typeof n.positionY === "number"));
    assert.ok(body.edges.every((e) => body.nodes.some((n) => n.id === e.sourceNodeId) && body.nodes.some((n) => n.id === e.targetNodeId)));
  });
});
