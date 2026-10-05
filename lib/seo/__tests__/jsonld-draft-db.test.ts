// ShapesOS Phase 11 (seotools): JSON-LD goes into a SiteBuilder site only
// through a DRAFT revision (as the app role, FORCE RLS on site_revisions):
//   1. add_structured_data saves a draft; the live working copy is untouched;
//      the draft carries a diff and the base fingerprint.
//   2. Applying the draft (the human step) writes the JSON-LD; running the
//      tool again finds nothing to change.
//   3. Invalid agent-supplied blocks are refused before anything is saved.
//   4. RLS: another workspace sees no revision; no origin → refused.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/seo/__tests__/jsonld-draft-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import type { ToolContext } from "@/lib/chat/tools";
import { readSiteWorkingCopy, writeSiteWorkingCopy } from "@/lib/sites/files";
import { getSiteRevision, listSiteRevisions } from "@/lib/sites/revisions";
import { applySiteRevision } from "@/lib/sites/apply";
import { add_structured_data } from "../tools";
import { createJsonLdDraft, JsonLdDraftError } from "../jsonld-draft";
import { injectedJsonLd } from "../jsonld";

const RUN = `p11j-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let projectId = "";
let siteId = "";
const storage = mkdtempSync(path.join(tmpdir(), "shapes-jsonld-"));
const savedStorage = process.env.SITE_STORAGE_DIR;

const LIVE = [
  { path: "/index.html", content: "<!doctype html><html><head><title>Acme</title></head><body><h1>Acme</h1></body></html>\n" },
  { path: "/products/widget.html", content: "<html><head><title>Widget</title></head><body><h1>Widget</h1><details><summary>Warranty?</summary>Two years.</details></body></html>\n" },
  { path: "/styles.css", content: "body{margin:0}\n" },
];

const ctx = (): ToolContext => ({ projectId, workspaceId: WS_A, userId: USER, role: "editor", confirmed: false });

before(async () => {
  process.env.SITE_STORAGE_DIR = storage;
  await prisma.workspace.create({ data: { id: WS_A, name: "Acme Co", ownerUserId: USER, whiteLabelLogoUrl: "https://cdn.acme.example/logo.png" } });
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

describe("JSON-LD via site drafts", () => {
  let revisionId = "";

  it("refuses invalid agent blocks before saving anything", async () => {
    const res = await add_structured_data.execute(ctx(), {
      blocks: JSON.stringify([{ path: "/products/widget.html", type: "Product", data: { name: "Widget" } }]),
    });
    assert.match(res.summary, /invalid: .*offers/);
    assert.equal((await listSiteRevisions(WS_A, siteId)).length, 0);
  });

  it("saves a draft and leaves the live working copy alone", async () => {
    const res = await add_structured_data.execute(ctx(), {
      blocks: JSON.stringify([
        { path: "/products/widget.html", type: "Product", data: { name: "Widget", image: "https://acme.example/w.png", offers: { price: 49, priceCurrency: "USD", availability: "InStock" } } },
      ]),
    });
    const d = res.details as { saved: boolean; revisionId: string; origin: string; pages: { path: string; types: string[] }[] };
    assert.equal(d.saved, true, res.summary);
    assert.equal(d.origin, "https://acme.example");
    assert.deepEqual(
      d.pages.map((p) => [p.path, p.types.join("+")]),
      [
        ["/index.html", "Organization+WebSite"],
        ["/products/widget.html", "BreadcrumbList+FAQPage+Product"],
      ],
    );
    revisionId = d.revisionId;

    const live = await readSiteWorkingCopy(siteId);
    assert.deepEqual(live.files, [...LIVE].sort((a, b) => a.path.localeCompare(b.path)), "the live working copy is untouched");

    const rev = await getSiteRevision(WS_A, siteId, revisionId);
    assert.equal(rev?.status, "draft");
    assert.equal(rev?.source, "agent");
    assert.ok(rev?.baseFingerprint);
    assert.match(rev?.patch ?? "", /\+\+\+ b\/products\/widget.html/);
    assert.match(rev?.summary ?? "", /Structured data \(.*Product.*\) on 2 pages/);
    const home = rev!.files.find((f) => f.path === "/index.html")!;
    const org = injectedJsonLd(home.content).find((b) => b["@type"] === "Organization")!;
    assert.equal(org.name, "Acme Co");
    assert.equal(org.logo, "https://cdn.acme.example/logo.png");
    assert.equal(rev!.files.find((f) => f.path === "/styles.css")?.content, "body{margin:0}\n");
  });

  it("is invisible to another workspace (RLS)", async () => {
    assert.equal((await listSiteRevisions(WS_B, siteId)).length, 0);
    assert.equal(await getSiteRevision(WS_B, siteId, revisionId), null);
  });

  it("goes live only when a person applies it; a second run finds nothing to do", async () => {
    await applySiteRevision({ workspaceId: WS_A, projectId, siteId, revisionId, userId: USER });
    const live = await readSiteWorkingCopy(siteId);
    const widget = live.files.find((f) => f.path === "/products/widget.html")!;
    assert.deepEqual(injectedJsonLd(widget.content).map((b) => b["@type"]), ["BreadcrumbList", "FAQPage", "Product"]);
    // Same derived blocks on the home page → nothing to draft.
    const again = await createJsonLdDraft({
      workspaceId: WS_A,
      projectId,
      siteId,
      paths: ["/index.html"],
    });
    assert.equal(again.revision, null);
    assert.equal(again.pages[0].changed, false);
    // Re-running without the agent's Product block keeps it (re-runs only add/update).
    const keep = await createJsonLdDraft({ workspaceId: WS_A, projectId, siteId });
    assert.equal(keep.revision, null);
    assert.deepEqual(keep.pages.find((p) => p.path === "/products/widget.html")?.types, ["BreadcrumbList", "FAQPage", "Product"]);
  });

  it("needs an absolute origin", async () => {
    const p2 = (await prisma.project.create({ data: { workspaceId: WS_A, domain: "" } })).id;
    const s2 = (await prisma.site.create({ data: { projectId: p2, name: "No URL", sourceType: "file", configEnc: "" } })).id;
    await assert.rejects(createJsonLdDraft({ workspaceId: WS_A, projectId: p2, siteId: s2 }), (e: unknown) => e instanceof JsonLdDraftError && e.code === "no_origin");
  });
});
