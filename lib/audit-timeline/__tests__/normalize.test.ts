// ShapesOS — Phase 18.3 (WS=trust): the audit timeline's normalisers (unit).
// One per source, the actor classifier, ordering + cursor paging, filters and CSV.
// Run: npx tsx --test lib/audit-timeline/__tests__/normalize.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_HEADER,
  TIMELINE_SOURCES,
  classifyActor,
  compareEntries,
  csvRow,
  decodeCursor,
  encodeCursor,
  fromAgentRunEvent,
  fromAuthorityAuditEvent,
  fromCommandAudit,
  fromComposioActionLog,
  fromEsignAuditEvent,
  fromFileChangeLog,
  fromFlywheelAuditEvent,
  fromMediaAuditEvent,
  fromMissionEvent,
  fromOpsAuditEvent,
  fromWorkspaceLifecycleEvent,
  mergePages,
  type TimelineEntry,
} from "../normalize";
import { TIMELINE_ADAPTERS } from "../sources.server";
import { filterFromQuery } from "../query";

const T = (s: string) => new Date(`2026-10-06T${s}Z`);

describe("timeline normalisers (one per source)", () => {
  it("covers every source with exactly one adapter", () => {
    assert.deepEqual(TIMELINE_ADAPTERS.map((a) => a.source).sort(), [...TIMELINE_SOURCES].sort());
  });

  it("file_change_log: user → person (approvedBy), ai → agent, workspace path hidden", () => {
    const e = fromFileChangeLog({ id: "f1", createdAt: T("10:00:00"), actor: "user", action: "member_added", summary: "Added ada", filePath: "(workspace)", projectId: null, approvedBy: "u1" });
    assert.deepEqual(e.actor, { kind: "person", id: "u1", label: "Member" });
    assert.equal(e.action, "Member added");
    assert.equal(e.target, null);
    assert.equal(e.key, "file_change_log:f1");
    const ai = fromFileChangeLog({ id: "f2", createdAt: T("10:00:00"), actor: "ai", action: "ai_applied", summary: "x", filePath: "src/a.ts", projectId: "p1", approvedBy: null });
    assert.equal(ai.actor.kind, "agent");
    assert.equal(ai.target, "src/a.ts");
    assert.equal(ai.link, "/dashboard/projects/p1");
    assert.equal(fromFileChangeLog({ id: "f3", createdAt: T("10:00:00"), actor: "system", action: "alert_sent", summary: "", filePath: "(workspace)", projectId: null, approvedBy: null }).actor.kind, "system");
  });

  it("agent_run_event: an agent, summary only, links to the run", () => {
    const e = fromAgentRunEvent({ id: "e1", createdAt: T("10:00:00"), runId: "r1", type: "gate", summary: "Waiting for your OK: send_email", run: { agentKey: "drafter", kind: "chat", startedBy: "u1" } });
    assert.equal(e.actor.kind, "agent");
    assert.equal(e.actor.id, "drafter");
    assert.equal(e.action, "Approval gate");
    assert.equal(e.link, "/dashboard/runs/r1");
    assert.equal(e.summary, "Waiting for your OK: send_email");
    assert.ok(!("payload" in e));
  });

  it("ops, composio, command, lifecycle", () => {
    const o = fromOpsAuditEvent({ id: "o1", createdAt: T("09:00:00"), entity: "invoices", entityId: "i1", action: "payment_applied", actor: "agent:actor", summary: "paid" });
    assert.equal(o.actor.kind, "agent");
    assert.equal(o.target, "Invoices i1");
    const c = fromComposioActionLog({ id: "c1", createdAt: T("09:00:00"), appKey: "slack", toolName: "SLACK_SEND_MESSAGE", status: "success", riskTier: "high", executedBy: "u2" });
    assert.equal(c.actor.kind, "person");
    assert.equal(c.action, "Slack send message (success)");
    assert.equal(fromCommandAudit({ id: "k1", createdAt: T("09:00:00"), userId: "u3", kind: "ask", templateId: null, resultSummary: "ok" }).actor.id, "u3");
    assert.equal(fromWorkspaceLifecycleEvent({ id: "w1", createdAt: T("09:00:00"), actorUserId: "u4", action: "renamed", workspaceName: "Acme" }).action, "Workspace renamed");
  });

  it("hash-chained trails", () => {
    assert.equal(fromMissionEvent({ id: "m1", ts: T("08:00:00"), missionId: "mi1", actor: "lead", step: "plan", tool: "web.search" }).actor.kind, "agent");
    assert.equal(fromMediaAuditEvent({ id: "m2", ts: T("08:00:00"), actor: "u1", action: "pool_created", subjectType: "pool", subjectId: "p1" }).target, "Pool p1");
    assert.equal(fromAuthorityAuditEvent({ id: "m3", ts: T("08:00:00"), actor: "system", action: "approved", entityType: "listing", entityId: "l1" }).actor.kind, "system");
    assert.equal(fromFlywheelAuditEvent({ id: "m4", ts: T("08:00:00"), actor: "agent:flywheel", kind: "realloc_applied", correlationId: "c9" }).target, "c9");
    const es = fromEsignAuditEvent({ id: "m5", createdAt: T("08:00:00"), actor: "system", event: "signed", envelope: { id: "env1", title: "NDA" } });
    assert.equal(es.target, "NDA");
    assert.equal(es.link, "/dashboard/esign?envelope=env1");
  });

  it("classifies actors", () => {
    assert.equal(classifyActor("agent:inbox").kind, "agent");
    assert.equal(classifyActor("lead").kind, "agent");
    assert.equal(classifyActor("cron").kind, "system");
    assert.equal(classifyActor("system").kind, "system");
    assert.equal(classifyActor("").kind, "system");
    assert.deepEqual(classifyActor("google:123 (playbook:x)"), { kind: "person", id: "google:123", label: "Member" });
  });
});

describe("timeline paging, filters and CSV", () => {
  const mk = (key: string, at: string, kind: "person" | "agent" | "system" = "person"): TimelineEntry => ({
    key,
    at: T(at).toISOString(),
    actor: { kind, id: null, label: kind },
    action: "a",
    target: null,
    source: key.split(":")[0] as TimelineEntry["source"],
    link: null,
    summary: null,
  });

  it("merges sources newest first and pages with a stable cursor (ties by key)", () => {
    const a = [mk("file_change_log:3", "10:00:00"), mk("file_change_log:1", "08:00:00")];
    const b = [mk("ops_audit_event:2", "10:00:00"), mk("ops_audit_event:0", "07:00:00")];
    const p1 = mergePages([a, b], null, 2);
    assert.deepEqual(p1.entries.map((e) => e.key), ["ops_audit_event:2", "file_change_log:3"]);
    assert.ok(p1.next);
    const c = decodeCursor(p1.next)!;
    assert.equal(c.key, "file_change_log:3");
    const p2 = mergePages([a, b], c, 2);
    assert.deepEqual(p2.entries.map((e) => e.key), ["file_change_log:1", "ops_audit_event:0"]);
    assert.equal(p2.next, null);
    assert.ok(compareEntries(p1.entries[0]!, p1.entries[1]!) < 0);
    assert.equal(decodeCursor(encodeCursor({ at: "2026-10-06T10:00:00.000Z", key: "x:1" }))?.key, "x:1");
    assert.equal(decodeCursor("garbage"), null);
  });

  it("filters by actor kind, source and dates", () => {
    const rows = [mk("file_change_log:1", "10:00:00", "person"), mk("agent_run_event:2", "09:00:00", "agent"), mk("ops_audit_event:3", "08:00:00", "system")];
    assert.deepEqual(mergePages([rows], null, 10, { actorKind: "agent" }).entries.map((e) => e.key), ["agent_run_event:2"]);
    assert.deepEqual(mergePages([rows], null, 10, { sources: ["ops_audit_event"] }).entries.map((e) => e.key), ["ops_audit_event:3"]);
    assert.deepEqual(mergePages([rows], null, 10, { from: T("08:30:00"), to: T("09:30:00") }).entries.map((e) => e.key), ["agent_run_event:2"]);
    const f = filterFromQuery(new URLSearchParams("actor=agent&source=mission_event,bogus&from=2026-10-01&to=2026-10-02"));
    assert.equal(f.actorKind, "agent");
    assert.deepEqual(f.sources, ["mission_event"]);
    assert.equal(f.to?.toISOString(), "2026-10-02T23:59:59.999Z");
    assert.equal(filterFromQuery(new URLSearchParams("actor=robot")).actorKind, null);
  });

  it("CSV is quoted and formula-safe", () => {
    const e = { ...mk("file_change_log:1", "10:00:00"), summary: '=HYPERLINK("x")', target: 'a "quoted" b' };
    assert.equal(CSV_HEADER.split(",").length, csvRow(e).split('","').length);
    assert.match(csvRow(e), /"'=HYPERLINK\(""x""\)"/);
    assert.match(csvRow(e), /"a ""quoted"" b"/);
  });
});
