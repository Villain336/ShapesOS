// Phase 21A (WS=agentweb): agent-ready changes reach a SiteBuilder site only through
// a DRAFT revision (as the app role, FORCE RLS on site_revisions):
//   1. the draft carries the annotated forms, llms.txt, robots AI section, actions;
//      the live working copy is untouched; the diff and base fingerprint are there.
//   2. another workspace sees nothing.
//   3. applying it is the human step; running again then finds nothing to do.
//   4. a site with no origin is refused.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/agentweb/__tests__/agent-ready-draft-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { readSiteWorkingCopy, writeSiteWorkingCopy } from "@/lib/sites/files";
import { getSiteRevision, listSiteRevisions } from "@/lib/sites/revisions";
import { applySiteRevision } from "@/lib/sites/apply";
import { AgentReadyError, createAgentReadyDraft, previewAgentReady } from "../site/agent-ready-draft";
import { policyOf } from "../site/robots-ai";

const RUN = `p21r-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";
let siteId = "";
const storage = mkdtempSync(path.join(tmpdir(), "shapes-agentready-"));
const savedStorage = process.env.SITE_STORAGE_DIR;

const LIVE = [
  { path: "/index.html", content: `<!doctype html><html><head><title>Acme</title></head><body><h1>Acme</h1><p>Plumbing. <a href="mailto:hi@acme.example">hi@acme.example</a></p></body></html>\n` },
  { path: "/contact.html", content: `<!doctype html><html><head><title>Contact</title></head><body><h1>Contact</h1><form action="/contact" method="post"><label for="e">Email</label><input id="e" name="email" type="email"><label for="m">Message</label><textarea id="m" name="message"></textarea><button>Send</button></form></body></html>\n` },
  { path: "/styles.css", content: "body{margin:0}\n" },
];

before(async () => {
  process.env.SITE_STORAGE_DIR = storage;
  await prisma.workspace.create({ data: { id: WS_A, name: "Acme Co", ownerUserId: USER } });
  await prisma.workspace.create({ data: { id: WS_B, name: "Other", ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "acme.example" } })).id;
  siteId = (await prisma.site.create({ data: { projectId, name: "Acme site", sourceType: "file", configEnc: "" } })).id;
  await writeSiteWorkingCopy(siteId, LIVE);
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await fs.rm(storage, { recursive: true, force: true });
  if (savedStorage === undefined) delete process.env.SITE_STORAGE_DIR;
  else process.env.SITE_STORAGE_DIR = savedStorage;
});

describe("agent readiness via site drafts", () => {
  let revisionId = "";

  it("previews without saving anything", async () => {
    const p = await previewAgentReady({ workspaceId: WS_A, projectId, siteId });
    assert.equal(p.origin, "https://acme.example");
    assert.ok(p.before.score < p.after.score);
    assert.equal(p.currentPolicy, null);
    assert.deepEqual(p.policy, { search: true, input: true, train: false });
    assert.equal((await listSiteRevisions(WS_A, siteId)).length, 0);
  });

  it("saves a draft and leaves the live working copy alone", async () => {
    const res = await createAgentReadyDraft({ workspaceId: WS_A, projectId, siteId, createdBy: USER });
    assert.ok(res.revision);
    revisionId = res.revision!.id;
    const live = await readSiteWorkingCopy(siteId);
    assert.deepEqual(live.files, [...LIVE].sort((a, b) => a.path.localeCompare(b.path)), "the live working copy is untouched");
    const rev = await getSiteRevision(WS_A, siteId, revisionId);
    assert.equal(rev?.status, "draft");
    assert.equal(rev?.source, "agent");
    assert.ok(rev?.baseFingerprint);
    assert.match(rev?.patch ?? "", /\+\+\+ b\/contact.html/);
    assert.match(rev?.patch ?? "", /\+\+\+ b\/llms.txt/);
    assert.match(rev?.summary ?? "", /Agent readiness: 4 files changed \(score \d+ to \d+\)/);
    assert.match(rev!.files.find((f) => f.path === "/contact.html")!.content, /toolname="contact_us"/);
    assert.deepEqual(policyOf(rev!.files.find((f) => f.path === "/robots.txt")!.content), { search: true, input: true, train: false });
  });

  it("is invisible to another workspace (RLS)", async () => {
    assert.equal((await listSiteRevisions(WS_B, siteId)).length, 0);
    assert.equal(await getSiteRevision(WS_B, siteId, revisionId), null);
  });

  it("goes live only when a person applies it; the next run finds nothing to do and keeps the chosen policy", async () => {
    await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId, userId: USER });
    const live = await readSiteWorkingCopy(siteId);
    assert.match(live.files.find((f) => f.path === "/contact.html")!.content, /toolname="contact_us"/);
    assert.ok(live.files.some((f) => f.path === "/llms.txt"));
    const again = await createAgentReadyDraft({ workspaceId: WS_A, projectId, siteId });
    assert.equal(again.revision, null);
    assert.deepEqual(again.preview.currentPolicy, { search: true, input: true, train: false });
  });

  it("needs an absolute origin", async () => {
    const bareProject = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "" } })).id;
    const bareSite = (await prisma.site.create({ data: { projectId: bareProject, name: "Bare", sourceType: "file", configEnc: "" } })).id;
    await writeSiteWorkingCopy(bareSite, LIVE);
    await assert.rejects(() => previewAgentReady({ workspaceId: WS_A, projectId: bareProject, siteId: bareSite }), (e) => e instanceof AgentReadyError && e.code === "no_origin");
  });
});
