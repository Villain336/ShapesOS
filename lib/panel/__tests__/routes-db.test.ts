// Phase 19B (WS=panel) — the /api/rehearsal routes against real Postgres (app
// role). The session is stubbed with node:test mock.module; the panel's
// system boundaries use testPanelDeps (labelled FAKE model + FAKE embedder).
//   - the gate: a starter workspace gets 403 upgrade_required, a viewer can't
//     change anything, signed out is 401;
//   - interviews in through the route: a JSON paste and a multipart VTT upload;
//   - a run never starts unconfirmed;
//   - screenshots are served only from this workspace's rehearsal blobs.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/panel/__tests__/routes-db.test.ts

import "dotenv/config";
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { blobPut, resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { lexicalTestEmbedder } from "../memory";
import { setPanelDepsForTests, testPanelDeps } from "../deps.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p19brt-${RUN}`;
const WS_STARTER = `p19brts-${RUN}`;
const ED = `p19brt-ed-${RUN}`;
const VIEWER = `p19brt-v-${RUN}`;
const BLOB_DIR = mkdtempSync(join(tmpdir(), "p19b-rt-blobs-"));

let user: { id: string; email: string } | null = { id: ED, email: "ed@example.test" };
let currentWs = WS;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => user,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: currentWs } }),
  },
});

let runs: typeof import("@/app/api/rehearsal/runs/route");
let interviews: typeof import("@/app/api/rehearsal/interviews/route");
let artifacts: typeof import("@/app/api/rehearsal/artifacts/route");

const json = (body: unknown) => new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  runs = await import("@/app/api/rehearsal/runs/route");
  interviews = await import("@/app/api/rehearsal/interviews/route");
  artifacts = await import("@/app/api/rehearsal/artifacts/route");
  process.env.MARKETR_BLOB_DIR = BLOB_DIR;
  resetStorageAdapterForTests();
  setPanelDepsForTests(testPanelDeps({ embed: lexicalTestEmbedder }));
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Routes ${RUN}`, ownerUserId: ED, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS_STARTER, name: `Starter ${RUN}`, ownerUserId: ED, plan: "starter" } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` },
      { workspaceId: WS, userId: VIEWER, role: "viewer", email: `v-${RUN}@example.test` },
      { workspaceId: WS_STARTER, userId: ED, role: "editor", email: `ed-${RUN}@example.test` },
    ],
  });
});

after(async () => {
  setPanelDepsForTests(null);
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.$disconnect();
  rmSync(BLOB_DIR, { recursive: true, force: true });
});

describe("/api/rehearsal gate", () => {
  it("signed out is 401; below Pro is 403 upgrade_required; a viewer can read but not start", async () => {
    user = null;
    assert.equal((await runs.GET(new Request("http://x/api/rehearsal/runs"))).status, 401);
    user = { id: ED, email: "ed@example.test" };
    currentWs = WS_STARTER;
    const res = await runs.GET(new Request("http://x/api/rehearsal/runs"));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "upgrade_required");
    currentWs = WS;
    user = { id: VIEWER, email: "v@example.test" };
    assert.equal((await runs.GET(new Request("http://x/api/rehearsal/runs"))).status, 200);
    assert.equal((await runs.POST(json({ target: { kind: "url", url: "https://example.com" }, personaIds: ["x"], capCredits: 10, confirmed: true }))).status, 403);
    user = { id: ED, email: "ed@example.test" };
  });
});

describe("/api/rehearsal/interviews", () => {
  it("a JSON paste and a multipart VTT upload are stored", async () => {
    const pasted = await interviews.POST(json({ title: "Pasted call", text: "Interviewer: Hi\nAna: The price is too high for us." }));
    assert.equal(pasted.status, 201);
    const form = new FormData();
    form.set("file", new File(["WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana>Annual billing is a non-starter.\n"], "ana.vtt", { type: "text/vtt" }));
    const uploaded = await interviews.POST(new Request("http://x/api", { method: "POST", body: form }));
    assert.equal(uploaded.status, 201);
    const list = (await (await interviews.GET(new Request("http://x/api"))).json()) as { interviews: Array<{ title: string }> };
    assert.deepEqual(list.interviews.map((i) => i.title).sort(), ["Pasted call", "ana.vtt"]);
  });

  it("an unsupported file is a 400 that says what to upload", async () => {
    const form = new FormData();
    form.set("file", new File(["ID3"], "call.mp3"));
    const res = await interviews.POST(new Request("http://x/api", { method: "POST", body: form }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Upload a .txt, .md, .vtt, .srt or .docx/);
  });
});

describe("/api/rehearsal/runs", () => {
  it("never starts unconfirmed", async () => {
    const res = await runs.POST(json({ target: { kind: "url", url: "https://example.com" }, personaIds: ["x"], capCredits: 10, confirmed: false }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Confirm the credit cap/);
  });
});

describe("/api/rehearsal/artifacts", () => {
  it("serves this workspace's rehearsal screenshots, nothing else", async () => {
    const mine = await blobPut("rehearsal", `${WS}/run1/p1/step-0-read.png`, Buffer.from("89504e47", "hex"), "image/png");
    const theirs = await blobPut("rehearsal", `${WS_STARTER}/run1/p1/step-0-read.png`, Buffer.from("89504e47", "hex"), "image/png");
    const get = (ref: string) => artifacts.GET(new Request(`http://x/api/rehearsal/artifacts?ref=${encodeURIComponent(ref)}`));
    const ok = await get(mine);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal((await get(theirs)).status, 404);
    assert.equal((await get(`blob:reports/${WS}/x.pdf`)).status, 404);
    assert.equal((await get("../../etc/passwd")).status, 404);
  });
});

describe("agent tools go through the same gates", () => {
  it("list_rehearsal_runs reads; start_page_walk refuses unknown personas and below-Pro workspaces", async () => {
    const { list_rehearsal_runs, start_page_walk } = await import("../tools");
    const ctx = { workspaceId: WS, userId: ED, role: "editor" } as never;
    assert.equal((await list_rehearsal_runs.execute(ctx, {})).summary, "No Dress Rehearsal runs yet.");
    const unknown = await start_page_walk.execute(ctx, { target: "https://example.com", personaIds: ["nope"], capCredits: 50 });
    assert.match(unknown.summary, /Couldn't start the page walk: One of those personas wasn't found/);
    const starter = await start_page_walk.execute({ workspaceId: WS_STARTER, userId: ED, role: "editor" } as never, { target: "https://example.com", personaIds: ["x"], capCredits: 50 });
    assert.match(starter.summary, /Dress rehearsal isn't included in your plan/);
  });
});
