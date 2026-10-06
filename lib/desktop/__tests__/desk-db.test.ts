// ShapesOS — Phase 18.1 (WS=desk) DB test, against real Postgres as the
// least-privilege app role (FORCE RLS is enforced):
//   - desktop layout / dock / recents: owner-only RLS (workspace AND member),
//     per-user isolation, fail-closed without the GUCs, WITH CHECK on writes;
//   - the Today briefing: written once per member per local day (idempotent,
//     direct and batch paths), mock models never write prose;
//   - Pause all agents: freezes the workspace (kill switch), stops every live
//     run (running → stop requested, queued / waiting → cancelled), writes the
//     audit row, refuses new runs until Resume;
//   - focus mode queues a notification instead of delivering it and delivers
//     it when focus ends (switch-off and the cron sweep).
// Run: DATABASE_URL=<app role> npx tsx --test lib/desktop/__tests__/desk-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withUserScope } from "../scope";
import { getDesk, listRecents, recordRecent, resetLayout, saveLayout, saveNav, LayoutRejected } from "../store.server";
import { defaultLayoutFor, moveBy } from "../layout";
import { deliverBriefingResult, ensureTodayBriefing, readTodayBriefing, runBriefingSweep, setBriefingOptIn, NO_MODEL_REASON } from "../briefing.server";
import { localDay } from "../briefing";
import { pauseAllAgents, resumeAgents, controlState, autoApproveSummary } from "../control.server";
import { endFocus, focusView, releaseEndedFocus, startFocus, usersInFocus } from "../focus.server";
import { getUserPreferences, setUserPreference } from "../prefs";
import { AgentsPausedError, createAgentRun, getAgentRun, markAgentRunRunning } from "@/lib/agents/runs/service";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";
import { listNotifications, unreadCount } from "@/lib/notifications/store";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { BriefingInput } from "../briefing";

const WS = "p18desk-ws";
const WS2 = "p18desk-ws2";
const OWNER = "p18desk-owner";
const ADMIN = "p18desk-admin";
const EDITOR = "p18desk-editor";
const VIEWER = "p18desk-viewer";
const USERS = [OWNER, ADMIN, EDITOR, VIEWER];

const fakeInput: BriefingInput = {
  memberName: "Ada",
  workspaceName: WS,
  day: "x",
  timeZone: "UTC",
  calendar: [],
  calendarConnected: false,
  needsYou: { count: 0, items: [] },
  overnight: { finished: 0, failed: 0, waiting: 0, running: 0, highlights: [] },
  metrics: [],
};

async function cleanup() {
  for (const id of [WS, WS2]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.userDeskState.deleteMany({ where: { userId: { in: USERS } } });
}

before(async () => {
  await cleanup();
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: WS2, name: WS2, ownerUserId: OWNER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: ADMIN, role: "admin" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS2, userId: OWNER, role: "owner" },
    ],
  });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("desktop layout + dock: owner-only RLS", () => {
  it("each member reads and writes only their own desk, per workspace", async () => {
    const mine = moveBy(defaultLayoutFor("editor"), "agents", 0, 2);
    await saveLayout(WS, EDITOR, "editor", mine);
    const editorDesk = await getDesk(WS, EDITOR, "editor");
    assert.equal(editorDesk.customized, true);
    assert.deepEqual(editorDesk.layout, mine);

    // Another member of the same workspace: their own default, not the editor's.
    const viewerDesk = await getDesk(WS, VIEWER, "viewer");
    assert.equal(viewerDesk.customized, false);
    assert.deepEqual(viewerDesk.layout, defaultLayoutFor("viewer"));

    // The same person in another workspace: a separate desk.
    assert.equal((await getDesk(WS2, EDITOR, "editor")).customized, false);
  });

  it("fail-closed: without both GUCs the rows are invisible, even to a workspace scope", async () => {
    assert.ok((await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM user_desktop_layouts`))[0]!.n === 0);
    const wsOnly = await withWorkspaceScope(WS, (tx) => tx.userDesktopLayout.count());
    assert.equal(wsOnly, 0, "the tenant GUC alone does not expose members' desks");
    const own = await withUserScope(WS, EDITOR, (tx) => tx.userDesktopLayout.count());
    assert.equal(own, 1);
    const otherWs = await withUserScope(WS2, EDITOR, (tx) => tx.userDesktopLayout.count({ where: { workspaceId: WS } }));
    assert.equal(otherWs, 0);
  });

  it("WITH CHECK: a scope cannot write a row for another member or workspace", async () => {
    await assert.rejects(
      withUserScope(WS, EDITOR, (tx) => tx.userDesktopLayout.create({ data: { workspaceId: WS, userId: VIEWER, layout: {} } })),
      /row-level security|violates/i,
    );
    await assert.rejects(
      withUserScope(WS, EDITOR, (tx) => tx.userRecentItem.create({ data: { workspaceId: WS2, userId: EDITOR, href: "/dashboard/crm", title: "CRM" } })),
      /row-level security|violates/i,
    );
  });

  it("an invalid layout is refused and nothing is stored; reset clears it", async () => {
    const bad = { version: 1, widgets: [{ id: "a", widget: "agents", x: 0, y: 0, w: 8, h: 5 }, { id: "b", widget: "running", x: 6, y: 1, w: 4, h: 5 }] };
    await assert.rejects(saveLayout(WS, EDITOR, "editor", bad), LayoutRejected);
    const stillMine = await getDesk(WS, EDITOR, "editor");
    assert.notDeepEqual(stillMine.layout.widgets.map((w) => w.id), ["a", "b"]);
    // A viewer cannot place a widget above their role… every widget is viewer+ today, so role gating is exercised via validateLayout unit tests.
    const back = await resetLayout(WS, EDITOR, "editor");
    assert.deepEqual(back, defaultLayoutFor("editor"));
    assert.equal((await getDesk(WS, EDITOR, "editor")).customized, false);
  });

  it("dock pins: unknown hrefs dropped, role-gated items stay gated, order kept", async () => {
    const saved = await saveNav(WS, VIEWER, "viewer", { pinned: ["/dashboard/files", "/dashboard/billing", "/dashboard/retired", "/dashboard/crm"] });
    assert.deepEqual(saved.pinned, ["/dashboard/files", "/dashboard/crm"]);
    assert.deepEqual((await getDesk(WS, VIEWER, "viewer")).nav.pinned, ["/dashboard/files", "/dashboard/crm"]);
    // Pinned as an admin, then demoted: the gated item disappears on read.
    await saveNav(WS, ADMIN, "admin", { pinned: ["/dashboard/billing", "/dashboard/crm"] });
    assert.deepEqual((await getDesk(WS, ADMIN, "viewer")).nav.pinned, ["/dashboard/crm"]);
    assert.deepEqual((await getDesk(WS, ADMIN, "admin")).nav.pinned, ["/dashboard/billing", "/dashboard/crm"]);
  });

  it("recents: per member, newest first, deduped, pruned, only dashboard pages", async () => {
    const t0 = Date.parse("2026-10-06T08:00:00Z");
    await recordRecent(WS, EDITOR, { href: "/dashboard/crm", title: "CRM — ShapesOS" }, new Date(t0));
    await recordRecent(WS, EDITOR, { href: "/dashboard/projects/abc?tab=x", title: "acme.com — ShapesOS" }, new Date(t0 + 1000));
    await recordRecent(WS, EDITOR, { href: "/dashboard/crm", title: "CRM — ShapesOS" }, new Date(t0 + 2000));
    assert.equal(await recordRecent(WS, EDITOR, { href: "https://evil.test/x" }), null);
    assert.equal(await recordRecent(WS, EDITOR, { href: "/dashboard/split?left=/dashboard" }), null);
    const list = await listRecents(WS, EDITOR);
    assert.deepEqual(list.map((r) => r.href), ["/dashboard/crm", "/dashboard/projects/abc"]);
    assert.equal(list[1]!.title, "acme.com");
    assert.equal(list[1]!.kind, "record");
    assert.deepEqual(await listRecents(WS, VIEWER), [], "never another member's");
    for (let i = 0; i < 40; i++) await recordRecent(WS, EDITOR, { href: `/dashboard/projects/p${i}` }, new Date(t0 + 10_000 + i));
    const n = await withUserScope(WS, EDITOR, (tx) => tx.userRecentItem.count({ where: { workspaceId: WS, userId: EDITOR } }));
    assert.equal(n, 30, "pruned to RECENTS_KEEP");
  });
});

describe("the Today briefing", () => {
  const now = new Date("2026-10-06T07:00:00Z");

  it("is written once per member per local day (direct path), never on read", async () => {
    let calls = 0;
    const deps = {
      batch: false,
      gather: async () => fakeInput,
      generate: async () => {
        calls++;
        return { text: "## Today\nTwo things need you.\n* Approve the newsletter", model: "fake-model", live: true };
      },
    };
    const first = await ensureTodayBriefing(WS, EDITOR, { now, timeZone: "UTC", deps });
    const second = await ensureTodayBriefing(WS, EDITOR, { now, timeZone: "UTC", deps });
    assert.equal(first.status, "ready");
    assert.equal(second.status, "exists");
    assert.equal(calls, 1, "one model call");
    const rows = await withUserScope(WS, EDITOR, (tx) => tx.desktopBriefing.findMany({ where: { workspaceId: WS, userId: EDITOR } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.day, "2026-10-06");
    assert.equal(rows[0]!.body, "Today\nTwo things need you.\n- Approve the newsletter");
    // Reading never writes.
    const view = await readTodayBriefing(WS, EDITOR, "UTC", now);
    assert.equal(view.status, "ready");
    assert.equal(calls, 1);
    // A new local day is a new briefing.
    const tomorrow = await ensureTodayBriefing(WS, EDITOR, { now: new Date("2026-10-07T07:00:00Z"), timeZone: "UTC", deps });
    assert.equal(tomorrow.status, "ready");
    assert.equal(calls, 2);
    // Another member's briefing is invisible.
    assert.equal((await readTodayBriefing(WS, VIEWER, "UTC", now)).status, "off");
  });

  it("concurrent calls still write one row and one model call", async () => {
    let calls = 0;
    const deps = { batch: false, gather: async () => fakeInput, generate: async () => (calls++, { text: "One line.", model: "m", live: true }) };
    const day = new Date("2026-10-08T09:00:00Z");
    const outs = await Promise.all([1, 2, 3].map(() => ensureTodayBriefing(WS, ADMIN, { now: day, timeZone: "UTC", deps })));
    assert.equal(outs.filter((o) => o.status === "ready").length, 1);
    assert.equal(calls, 1);
  });

  it("no live model: marked failed with the reason, no prose written", async () => {
    const out = await ensureTodayBriefing(WS, VIEWER, {
      now,
      timeZone: "UTC",
      deps: { batch: false, gather: async () => fakeInput, generate: async () => ({ text: "MOCK TEXT", model: "mock", live: false }) },
    });
    assert.equal(out.status, "failed");
    const view = await readTodayBriefing(WS, VIEWER, "UTC", now);
    assert.equal(view.status, "failed");
    assert.equal(view.body, null);
    assert.equal(view.error, NO_MODEL_REASON);
  });

  it("batch path: submitted once, delivered once into the member's row", async () => {
    const submitted: string[] = [];
    const deps = { batch: true, gather: async () => fakeInput, submitBatch: async (i: { key: string }) => void submitted.push(i.key) };
    const day = new Date("2026-10-09T07:00:00Z");
    assert.equal((await ensureTodayBriefing(WS, OWNER, { now: day, timeZone: "UTC", deps })).status, "submitted");
    assert.equal((await ensureTodayBriefing(WS, OWNER, { now: day, timeZone: "UTC", deps })).status, "exists");
    assert.deepEqual(submitted, ["desktop_briefing:2026-10-09:p18desk-owner"]);
    assert.equal((await readTodayBriefing(WS, OWNER, "UTC", day)).status, "pending");
    await deliverBriefingResult(WS, { userId: OWNER, day: "2026-10-09" }, { text: "Quiet day.\n- Nothing waiting" }, "claude-batch");
    await deliverBriefingResult(WS, { userId: OWNER, day: "2026-10-09" }, { text: "SECOND DELIVERY" }, "claude-batch");
    const view = await readTodayBriefing(WS, OWNER, "UTC", day);
    assert.equal(view.status, "ready");
    assert.equal(view.body, "Quiet day.\n- Nothing waiting", "a second delivery changes nothing");
  });

  it("the sweep writes only for opted-in members whose morning has come", async () => {
    let calls = 0;
    const deps = { batch: false, gather: async () => fakeInput, generate: async () => (calls++, { text: "Hi.", model: "m", live: true }) };
    await setBriefingOptIn(WS, EDITOR, true, { timeZone: "UTC", deps });
    const afterOptIn = calls; // opting in writes today's once
    const early = await runBriefingSweep({ workspaceId: WS, now: new Date("2026-10-10T05:00:00Z"), deps });
    assert.equal(early.written, 0);
    assert.equal(early.skipped >= 1, true, "before 06:00 local nothing is written");
    const morning = await runBriefingSweep({ workspaceId: WS, now: new Date("2026-10-10T06:30:00Z"), deps });
    assert.equal(morning.written, 1, "only the opted-in editor");
    const again = await runBriefingSweep({ workspaceId: WS, now: new Date("2026-10-10T09:30:00Z"), deps });
    assert.equal(again.written, 0, "idempotent per day");
    assert.equal(calls, afterOptIn + 1);
    assert.equal(localDay(new Date("2026-10-10T06:30:00Z"), "UTC"), "2026-10-10");
  });
});

describe("Control Center: pause all agents", () => {
  it("freezes the workspace, stops every live run, writes the audit row, refuses new runs until resumed", async () => {
    const running = await createAgentRun({ workspaceId: WS, kind: "playbook", startedBy: "scheduler" });
    await markAgentRunRunning(WS, running.id);
    const child = await createAgentRun({ workspaceId: WS, kind: "playbook", startedBy: "scheduler", parentRunId: running.id });
    await markAgentRunRunning(WS, child.id);
    const queued = await createAgentRun({ workspaceId: WS, kind: "playbook", startedBy: "scheduler" });
    const waiting = await createAgentRun({ workspaceId: WS, kind: "playbook", startedBy: "scheduler" });
    await withWorkspaceScope(WS, (tx) => tx.agentRun.update({ where: { id: waiting.id }, data: { status: "awaiting_confirmation" } }));
    const otherWs = await createAgentRun({ workspaceId: WS2, kind: "playbook", startedBy: "scheduler" });
    await markAgentRunRunning(WS2, otherWs.id);

    const res = await pauseAllAgents(WS, ADMIN);
    assert.equal(res.paused, true);
    assert.deepEqual(new Set(res.stopped), new Set([running.id, child.id, queued.id, waiting.id]));

    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: WS }, select: { frozenAt: true } });
    assert.ok(ws.frozenAt, "kill switch: workspace frozen");
    const r = await getAgentRun(WS, running.id);
    assert.ok(r?.cancelRequestedAt, "the running run is asked to stop (it ends at its next step)");
    assert.equal(r?.cancelRequestedBy, ADMIN);
    assert.ok((await getAgentRun(WS, child.id))?.cancelRequestedAt, "its sub-agent too");
    assert.equal((await getAgentRun(WS, queued.id))?.status, "cancelled");
    assert.equal((await getAgentRun(WS, waiting.id))?.status, "cancelled");
    assert.equal((await getAgentRun(WS2, otherWs.id))?.cancelRequestedAt, null, "another workspace is untouched");

    const audit = await withWorkspaceScope(WS, (tx) => tx.commandAudit.findMany({ where: { workspaceId: WS }, orderBy: { createdAt: "asc" } }));
    assert.ok(audit.some((a) => a.userId === ADMIN && /workspace frozen: Paused from Control Center/.test(a.resultSummary ?? "")));
    assert.ok(audit.some((a) => a.userId === ADMIN && /pause all agents: workspace frozen, 4 run\(s\) asked to stop/.test(a.resultSummary ?? "")));

    await assert.rejects(createAgentRun({ workspaceId: WS, kind: "chat", startedBy: EDITOR }), AgentsPausedError);
    const state = await controlState(WS, ADMIN, "admin");
    assert.ok(state.paused);
    assert.equal(state.canPause, true);
    assert.equal((await controlState(WS, EDITOR, "editor")).canPause, false);

    await resumeAgents(WS, ADMIN);
    assert.equal((await prisma.workspace.findUniqueOrThrow({ where: { id: WS }, select: { frozenAt: true } })).frozenAt, null);
    const fresh = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: EDITOR });
    assert.equal(fresh.status, "queued");
    const audit2 = await withWorkspaceScope(WS, (tx) => tx.commandAudit.count({ where: { workspaceId: WS, resultSummary: "resume agents: workspace unfrozen" } }));
    assert.equal(audit2, 1);
  });

  it("the auto-approve summary never reports a locked (money / irreversible) action as auto", async () => {
    // Even a forged every-agent "auto" row for a Tier 3 action reads as "ask".
    await withWorkspaceScope(WS, (tx) => tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "*", action: "spend_budget", behavior: "auto" } })).catch(() => undefined);
    const s = await autoApproveSummary(WS);
    assert.ok(s.locked > 0);
    assert.ok(s.ask + s.auto + s.never > 0);
    const { KNOWN_ACTIONS } = await import("@/lib/automation/policy");
    assert.equal(s.auto + s.ask + s.never, KNOWN_ACTIONS.length);
    assert.ok(s.auto <= KNOWN_ACTIONS.filter((a) => a.autoAllowed).length);
  });
});

describe("focus mode", () => {
  it("queues a notification instead of delivering it; delivers it when focus ends", async () => {
    await startFocus(EDITOR, { minutes: 60 });
    assert.ok((await usersInFocus([EDITOR, OWNER])).has(EDITOR));
    const created = await notifyApprovalNeeded({ workspaceId: WS, source: "cad", sourceId: "p18desk-cad-1", title: "Thicken the wall" }, prisma);
    assert.ok(created >= 2, "owner, admin and editor are deciders");
    const editorRow = await prisma.notification.findFirstOrThrow({ where: { userId: EDITOR, sourceId: "p18desk-cad-1" } });
    assert.ok(editorRow.heldAt, "queued (held), not dropped");
    const ownerRow = await prisma.notification.findFirstOrThrow({ where: { userId: OWNER, sourceId: "p18desk-cad-1" } });
    assert.equal(ownerRow.heldAt, null, "someone not in focus gets it now");
    // Not delivered while focus is on: the bell neither lists nor counts it.
    assert.equal((await listNotifications(prisma, { userId: EDITOR, workspaceId: WS })).some((n) => n.id === editorRow.id), false);
    assert.equal(await unreadCount(prisma, { userId: EDITOR, workspaceId: WS }), 0);
    assert.equal((await focusView(EDITOR)).queued, 1);

    const ended = await endFocus(EDITOR);
    assert.equal(ended.on, false);
    assert.equal(ended.released, 1);
    const list = await listNotifications(prisma, { userId: EDITOR, workspaceId: WS });
    assert.ok(list.some((n) => n.id === editorRow.id), "delivered once focus ends");
    assert.equal(await unreadCount(prisma, { userId: EDITOR, workspaceId: WS }), 1);
  });

  it("an expired focus is released by the sweep; an active one is not", async () => {
    await startFocus(ADMIN, { minutes: 30 }, new Date(Date.now() - 2 * 3600_000)); // ended 90 minutes ago
    await startFocus(VIEWER, { minutes: 120 });
    await prisma.notification.createMany({
      data: [
        { workspaceId: WS, userId: ADMIN, kind: "alert_fired", title: "held for admin", dedupKey: "p18desk-h1", heldAt: new Date() },
        { workspaceId: WS, userId: VIEWER, kind: "alert_fired", title: "held for viewer", dedupKey: "p18desk-h2", heldAt: new Date() },
      ],
    });
    const sweep = await releaseEndedFocus();
    assert.ok(sweep.released >= 1);
    assert.equal((await prisma.notification.findFirstOrThrow({ where: { dedupKey: "p18desk-h1" } })).heldAt, null);
    assert.ok((await prisma.notification.findFirstOrThrow({ where: { dedupKey: "p18desk-h2" } })).heldAt, "still in focus: still waiting");
    await endFocus(VIEWER);
  });

  it("focus always has an end within 24 hours", async () => {
    await assert.rejects(startFocus(EDITOR, { until: new Date(Date.now() + 25 * 3600_000) }), RangeError);
    await assert.rejects(startFocus(EDITOR, { until: new Date(Date.now() - 1000) }), RangeError);
  });
});

describe("the UserPrefs seam (voice, shortcuts)", () => {
  it("stores voice and validated shortcut overrides in WS=find's format", async () => {
    let p = await setUserPreference(EDITOR, "voice", { enabled: true });
    assert.deepEqual(p.voice, { enabled: true });
    p = await setUserPreference(EDITOR, "shortcuts", { "task.new": "mod+shift+y", "split.focus_left": "ctrl+alt+left" });
    assert.deepEqual(p.shortcuts, { "task.new": "mod+shift+y", "split.focus_left": "ctrl+alt+left" });
    assert.deepEqual((await getUserPreferences(EDITOR)).shortcuts, p.shortcuts);
    await assert.rejects(setUserPreference(EDITOR, "shortcuts", { "task.new": "mod+k" }), /clash|unknown|fixed/);
    await assert.rejects(setUserPreference(EDITOR, "shortcuts", { "Bad-Id": "f1" }), /not a shortcut id/);
    assert.deepEqual((await getUserPreferences(EDITOR)).shortcuts, p.shortcuts, "a refused write changes nothing");
    assert.deepEqual((await getUserPreferences(VIEWER)).shortcuts, {});
  });
});
