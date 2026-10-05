// ShapesOS — Phase 8: sandboxes against Postgres (FORCE RLS, app role).
//   - one sandbox per run (concurrent callers share one create)
//   - a delegated sub-agent shares its root run's sandbox
//   - a chat thread's next run (an approved "yes") reattaches the thread's
//     live sandbox; a thread-bound sandbox survives run end, Stop destroys it
//   - a run without a thread: destroyed when it finishes
//   - an idled-out sandbox is replaced; no provider → the reason
//   - RLS: another workspace sees nothing
//   - POST /api/agent-runs/[runId]/restore authz + rules
//   - the preview route: auth, exposed ports only, no app cookies upstream
// The provider is the FakeProvider TEST DOUBLE (fakes.ts); the session is
// stubbed with node:test mock.module. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/sandbox-db.test.ts

import { describe, it, before, after, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun, finishAgentRun, markAgentRunRunning, requestAgentRunCancel, listAgentRunEvents } from "@/lib/agents/runs/service";
import { FakeProvider, type LocalDirSandbox } from "./fakes";

const RUN = randomUUID().slice(0, 8);
const WS = `p8sbx${RUN}`;
const WS_B = `p8sbxb${RUN}`;
const OWNER = `p8sbx-owner-${RUN}`;
const EDITOR = `p8sbx-editor-${RUN}`;
const VIEWER = `p8sbx-viewer-${RUN}`;
const STARTER = `p8sbx-starter-${RUN}`;
const OUTSIDER = `p8sbx-out-${RUN}`;

let actor: { id: string; email: string } | null = { id: EDITOR, email: "e@x.test" };
let currentWs = WS;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: currentWs } }),
  },
});

type SandboxMod = typeof import("../index");
type ToolsMod = typeof import("../tools");
type RestoreRoute = typeof import("@/app/api/agent-runs/[runId]/restore/route");
type PreviewRoute = typeof import("@/app/api/agent-runs/[runId]/preview/[port]/[[...path]]/route");
let sbx: SandboxMod;
let tools: ToolsMod;
let restoreRoute: RestoreRoute;
let previewRoute: PreviewRoute;
let fake: FakeProvider;
let upstream: Server;
const upstreamSeen: Array<Record<string, unknown>> = [];
const savedSecret = process.env.AUTH_SECRET;

async function newRun(opts: { threadId?: string; parentRunId?: string; startedBy?: string; ws?: string } = {}) {
  const r = await createAgentRun({ workspaceId: opts.ws ?? WS, kind: "chat", startedBy: opts.startedBy ?? OWNER, threadId: opts.threadId, parentRunId: opts.parentRunId });
  await markAgentRunRunning(opts.ws ?? WS, r.id);
  return r.id;
}

async function row(runId: string, ws = WS) {
  return withWorkspaceScope(ws, (tx) => tx.agentRunSandbox.findFirst({ where: { runId } }));
}

before(async () => {
  process.env.AUTH_SECRET = "p8-sandbox-test-secret-0123456789abcdef";
  sbx = await import("../index");
  tools = await import("../tools");
  restoreRoute = await import("@/app/api/agent-runs/[runId]/restore/route");
  previewRoute = await import("@/app/api/agent-runs/[runId]/preview/[port]/[[...path]]/route");
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: WS_B, name: WS_B, ownerUserId: OUTSIDER } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS, userId: STARTER, role: "viewer" },
      { workspaceId: WS_B, userId: OUTSIDER, role: "owner" },
    ],
  });
  upstream = createServer((req, res) => {
    upstreamSeen.push({ url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, method: req.method });
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "evil=1; Path=/" });
    res.end("<h1>preview</h1>");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
});

beforeEach(() => {
  fake = new FakeProvider();
  fake.upstream = { origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, headers: { "x-shapes-gateway-token": "tok" }, kind: "loopback" };
  sbx.setSandboxProviderForTests(fake);
  actor = { id: EDITOR, email: "e@x.test" };
  currentWs = WS;
});

after(async () => {
  sbx.setSandboxProviderForTests(undefined);
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  upstream.closeAllConnections?.();
  await new Promise<void>((r) => upstream.close(() => r()));
  for (const s of fake?.created ?? []) await s.destroy().catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("sandbox per run", () => {
  it("one sandbox per run: concurrent callers share one create; later calls reattach", async () => {
    fake.createDelayMs = 50;
    const runId = await newRun();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => sbx.sandboxForRun({ workspaceId: WS, runId })));
    assert.equal(fake.created.length, 1);
    assert.equal(a!.id, b!.id);
    assert.equal(b!.id, c!.id);
    const r = await row(runId);
    assert.equal(r?.sandboxId, a!.id);
    assert.equal(r?.status, "active");
    assert.equal((await sbx.sandboxForRun({ workspaceId: WS, runId, threadId: "ignored", parentRunId: "ignored" })).id, a!.id);
    assert.equal(fake.created.length, 1);
    const events = await listAgentRunEvents(WS, runId);
    assert.ok(events.some((e) => (e.payload as { kind?: string })?.kind === "sandbox.created"));
  });

  it("a run without a chat thread: its sandbox is destroyed when the run finishes", async () => {
    const runId = await newRun();
    const s = (await sbx.sandboxForRun({ workspaceId: WS, runId })) as LocalDirSandbox;
    await finishAgentRun(WS, runId, "succeeded");
    assert.equal(s.destroyed, true);
    assert.equal((await row(runId))?.status, "destroyed");
  });

  it("a delegated sub-agent shares (and creates under) its root run", async () => {
    const root = await newRun();
    const child = await newRun({ parentRunId: root });
    const fromChild = await sbx.sandboxForRun({ workspaceId: WS, runId: child });
    assert.equal((await row(root))?.sandboxId, fromChild.id, "owned by the root run");
    assert.equal(await row(child), null);
    assert.equal((await sbx.sandboxForRun({ workspaceId: WS, runId: root })).id, fromChild.id);
    // The child finishing leaves the root's sandbox alone.
    await finishAgentRun(WS, child, "succeeded");
    assert.equal((fromChild as LocalDirSandbox).destroyed, false);
    assert.equal(fake.created.length, 1);
  });

  it("a chat thread: the next run reattaches; run end keeps it; Stop destroys it", async () => {
    const thread = `thread-${RUN}`;
    const first = await newRun({ threadId: thread });
    const s = (await sbx.sandboxForRun({ workspaceId: WS, runId: first })) as LocalDirSandbox;
    await finishAgentRun(WS, first, "succeeded");
    assert.equal(s.destroyed, false, "kept for the thread's next turn");
    assert.equal((await row(first))?.status, "active");
    // The approved "yes" runs as a NEW run on the same thread.
    const second = await newRun({ threadId: thread });
    assert.equal((await sbx.sandboxForRun({ workspaceId: WS, runId: second })).id, s.id);
    assert.equal(fake.created.length, 1);
    // Stopping the run that owns it destroys it.
    const third = await newRun({ threadId: `${thread}-2` });
    const t = (await sbx.sandboxForRun({ workspaceId: WS, runId: third })) as LocalDirSandbox;
    const res = await requestAgentRunCancel(WS, third, EDITOR);
    assert.equal(res?.stopped, true);
    assert.equal(t.destroyed, true);
    assert.equal((await row(third))?.status, "destroyed");
  });

  it("an idled-out sandbox is replaced; without a provider the reason comes back", async () => {
    const runId = await newRun();
    const s = (await sbx.sandboxForRun({ workspaceId: WS, runId })) as LocalDirSandbox;
    await s.destroy(); // the provider's idle timeout
    const s2 = await sbx.sandboxForRun({ workspaceId: WS, runId });
    assert.notEqual(s2.id, s.id);
    assert.equal((await row(runId))?.sandboxId, s2.id);
    fake.ok = false;
    sbx.setSandboxProviderForTests(fake); // clears the availability cache
    const other = await newRun();
    await assert.rejects(sbx.sandboxForRun({ workspaceId: WS, runId: other }), (e: Error) => e instanceof sbx.SandboxUnavailableError && /fake provider is down/.test(e.message));
  });

  it("RLS: another workspace can't see, reuse or reach a run's sandbox", async () => {
    const runId = await newRun();
    await sbx.sandboxForRun({ workspaceId: WS, runId });
    assert.equal(await row(runId, WS_B), null);
    const all = await withWorkspaceScope(WS_B, (tx) => tx.agentRunSandbox.findMany({ where: { runId } }));
    assert.equal(all.length, 0);
    assert.equal(await sbx.liveSandboxForRun({ workspaceId: WS_B, runId }), null);
    await assert.rejects(sbx.sandboxForRun({ workspaceId: WS_B, runId }), /not found in this workspace/);
    // The unscoped connection sees nothing at all (FORCE RLS, fail-closed).
    assert.equal(await prisma.agentRunSandbox.count({ where: { runId } }), 0);
  });
});

function restoreReq(runId: string, body: unknown) {
  return restoreRoute.POST(
    new Request(`http://localhost/api/agent-runs/${runId}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ runId }) },
  );
}

describe("POST /api/agent-runs/[runId]/restore", () => {
  it("authz: editor or the run's starter; viewers 403; other workspaces 404; signed out 401", async () => {
    const runId = await newRun({ startedBy: STARTER });
    const s = (await sbx.sandboxForRun({ workspaceId: WS, runId })) as LocalDirSandbox;
    const ctx = { projectId: "p", workspaceId: WS, userId: STARTER, role: "editor" as const, confirmed: true, runId };
    await s.writeFile("a.txt", "v1");
    const snap = await tools.checkpoint(ctx, s);
    assert.ok(snap);
    await s.writeFile("a.txt", "v2");

    actor = null;
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 401);
    actor = { id: VIEWER, email: "v@x.test" };
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 403);
    actor = { id: OUTSIDER, email: "o@x.test" };
    currentWs = WS_B;
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 404);
    currentWs = WS;

    actor = { id: STARTER, email: "s@x.test" };
    const ok = await restoreReq(runId, { snapshotId: snap });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { restored: true, snapshotId: snap });
    assert.equal((await s.readFile("a.txt")).toString(), "v1");

    actor = { id: EDITOR, email: "e@x.test" };
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 200);
    const events = await listAgentRunEvents(WS, runId);
    assert.ok(events.some((e) => (e.payload as { kind?: string; by?: string })?.kind === "sandbox.restored"));
  });

  it("rules: a real checkpoint id of THIS run and THIS sandbox, only while it lives", async () => {
    const runId = await newRun();
    const s = (await sbx.sandboxForRun({ workspaceId: WS, runId })) as LocalDirSandbox;
    const ctx = { projectId: "p", workspaceId: WS, userId: EDITOR, role: "editor" as const, confirmed: true, runId };
    const snap = (await tools.checkpoint(ctx, s))!;
    assert.equal((await restoreReq(runId, { snapshotId: "../../etc" })).status, 400);
    assert.equal((await restoreReq(runId, {})).status, 400);
    assert.equal((await restoreReq(runId, { snapshotId: "snap-notonthisrun1" })).status, 404);
    // Another run's checkpoint id can't be used here.
    const other = await newRun();
    const os = await sbx.sandboxForRun({ workspaceId: WS, runId: other });
    const otherSnap = (await tools.checkpoint({ ...ctx, runId: other }, os))!;
    assert.equal((await restoreReq(runId, { snapshotId: otherSnap })).status, 404);
    // After the sandbox idles out, a new one can't restore the old checkpoint…
    await s.destroy();
    await sbx.sandboxForRun({ workspaceId: WS, runId });
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 409);
    // …and once the run has ended (sandbox destroyed) nothing restores.
    await finishAgentRun(WS, runId, "succeeded");
    assert.equal((await restoreReq(runId, { snapshotId: snap })).status, 409);
  });
});

function previewReq(runId: string, port: string, path: string[], init: RequestInit = {}) {
  return previewRoute.GET(new Request(`http://localhost/api/agent-runs/${runId}/preview/${port}/${path.join("/")}`, init), {
    params: Promise.resolve({ runId, port, path }),
  });
}

describe("preview route", () => {
  it("members see exposed ports only; app credentials never reach the sandbox; the page is sandboxed", async () => {
    const runId = await newRun({ startedBy: STARTER });
    const s = await sbx.sandboxForRun({ workspaceId: WS, runId });
    const ctx = { projectId: "p", workspaceId: WS, userId: STARTER, role: "editor" as const, confirmed: true, runId };
    const { url } = await tools.exposeForRun(ctx, s, 3000);
    assert.equal(url, `/api/agent-runs/${runId}/preview/3000/`);

    actor = { id: VIEWER, email: "v@x.test" };
    upstreamSeen.length = 0;
    const res = await previewReq(runId, "3000", ["index.html"], { headers: { cookie: "authjs.session-token=SECRET", authorization: "Bearer SECRET" } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<h1>preview</h1>");
    assert.equal(upstreamSeen[0]!.url, `/api/agent-runs/${runId}/preview/3000/index.html`);
    assert.equal(upstreamSeen[0]!.cookie, undefined);
    assert.equal(upstreamSeen[0]!.authorization, undefined);
    assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.doesNotMatch(setCookie, /evil=1/, "the sandbox can't set cookies on the app");
    assert.match(setCookie, new RegExp(`^shapes_preview=[^;]+; Path=/api/agent-runs/${runId}/preview/; Max-Age=3600; HttpOnly; Secure; SameSite=None$`));

    // Unexposed port, bad port, foreign workspace, signed out.
    assert.equal((await previewReq(runId, "5432", [])).status, 404);
    assert.equal((await previewReq(runId, "80", [])).status, 404);
    actor = { id: OUTSIDER, email: "o@x.test" };
    currentWs = WS_B;
    assert.equal((await previewReq(runId, "3000", [])).status, 404, "another workspace's run reads as not found");
    currentWs = WS;

    // The opaque-origin page's own requests carry only the preview cookie.
    actor = null;
    const token = decodeURIComponent(setCookie.split(";")[0]!.split("=").slice(1).join("="));
    const sub = await previewReq(runId, "3000", ["app.js"], { headers: { cookie: `shapes_preview=${encodeURIComponent(token)}` } });
    assert.equal(sub.status, 200);
    assert.equal(sub.headers.get("set-cookie"), null, "no fresh cookie without a session");
    assert.equal((await previewReq(runId, "3000", ["app.js"])).status, 401);
    const otherRun = await newRun();
    assert.equal((await previewReq(otherRun, "3000", [], { headers: { cookie: `shapes_preview=${encodeURIComponent(token)}` } })).status, 401, "the cookie opens one run only");

    // Writes to a preview: editor+ or the starter only.
    actor = { id: VIEWER, email: "v@x.test" };
    const post = (who: typeof actor) => {
      actor = who;
      return previewRoute.POST(new Request(`http://localhost/api/agent-runs/${runId}/preview/3000/api`, { method: "POST", body: "x" }), {
        params: Promise.resolve({ runId, port: "3000", path: ["api"] }),
      });
    };
    assert.equal((await post({ id: VIEWER, email: "v@x.test" })).status, 403);
    assert.equal((await post({ id: STARTER, email: "s@x.test" })).status, 200);

    // Once the sandbox is gone, so is the preview.
    await finishAgentRun(WS, runId, "succeeded");
    actor = { id: VIEWER, email: "v@x.test" };
    assert.equal((await previewReq(runId, "3000", [])).status, 409);
  });
});
