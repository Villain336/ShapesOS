// ShapesOS — Phase 9 (sites): site_checkout / site_publish_draft against the
// TEST-ONLY fake Sandbox (lib/ship/__tests__/fake-sandbox.ts: a temp dir +
// real git and sh; no network, no database — site files, state, drafts and
// events are in memory). The real working-copy and DB paths are covered by
// site-revisions-db.test.ts.
// Run: npx tsx --test lib/sites/__tests__/site-tools.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import { allTools, toolGroup } from "@/lib/chat/tools";
import type { AgentRunEventInput } from "@/lib/agents/runs/types";
import { createFakeSandbox, type FakeSandbox } from "@/lib/ship/__tests__/fake-sandbox";
import { createSiteTools, readSandboxSite, siteDirName, staticServerCommand, SITE_TOOL_NAMES, type SiteRef, type SiteToolDeps } from "../tools";
import { siteFingerprint, snapshotPath, type SiteFile } from "../files";
import type { CreateSiteRevisionInput } from "../revisions";
import type { SiteRunState } from "../state";

const SITES: Record<string, SiteRef & { files: SiteFile[] }> = {
  s1: {
    id: "s1",
    name: "Acme Landing",
    projectId: "p1",
    sourceType: "file",
    files: [
      { path: "/index.html", content: "<h1>Acme</h1>\n<p>Call us</p>\n" },
      { path: "/css/site.css", content: "body { color: black; }\n" },
    ],
  },
  wp: { id: "wp", name: "Blog", projectId: "p1", sourceType: "wordpress", files: [] },
};

let sb: FakeSandbox;
const states = new Map<string, SiteRunState>();
const drafts: CreateSiteRevisionInput[] = [];
const events: Array<{ runId: string; event: AgentRunEventInput }> = [];
const exposed: number[] = [];

const deps: SiteToolDeps = {
  getSandbox: async () => sb,
  findSite: async (_ws, _project, ref) => {
    const site = Object.values(SITES).find((s) => s.id === ref || s.name.toLowerCase() === ref.toLowerCase()) ?? null;
    return { site, names: Object.values(SITES).map((s) => s.name) };
  },
  readSite: async (id) => ({ files: SITES[id]!.files, skipped: [] }),
  saveDraft: async (input) => {
    drafts.push(input);
    return {
      id: `rev-${drafts.length}`,
      siteId: input.siteId,
      number: drafts.length,
      status: input.status,
      source: input.source,
      runId: input.runId ?? null,
      summary: input.summary ?? null,
      fileCount: input.files.length,
      bytes: 0,
      patchTruncated: false,
      hasPatch: !!input.patch,
      createdBy: null,
      appliedAt: null,
      appliedBy: null,
      backupId: null,
      createdAt: new Date(),
    };
  },
  loadState: async (q) => states.get(q.runId ?? "") ?? null,
  saveState: async (_ws, runId, state) => {
    states.set(runId, structuredClone(state));
  },
  recordEvent: async (_ws, runId, event) => {
    events.push({ runId, event });
  },
  expose: async (_ctx, _sb, port) => {
    exposed.push(port);
    return { url: `/api/agent-runs/run-1/preview/${port}/` };
  },
};

const tools = new Map<string, ToolDef>(createSiteTools(deps).map((t) => [t.name, t]));
const ctx = (runId = "run-1"): ToolContext => ({
  projectId: "p1",
  workspaceId: "ws1",
  userId: "u1",
  role: "editor",
  confirmed: false,
  runId,
});
const run = (name: string, args: Record<string, unknown>, c = ctx()) => tools.get(name)!.execute(c, args);

before(() => {
  sb = createFakeSandbox();
});
after(async () => {
  await sb.destroy();
});

describe("site_checkout", () => {
  it("copies the site's files into sites/<name> with a git baseline", async () => {
    const r = await run("site_checkout", { site: "acme landing" });
    const dir = path.join(sb.workdir, "sites", "acme-landing");
    assert.match(r.summary, /Checked out Acme Landing at .*sites\/acme-landing \(2 files\)/);
    assert.equal(await fs.readFile(path.join(dir, "index.html"), "utf8"), SITES.s1!.files[0]!.content);
    assert.equal(await fs.readFile(path.join(dir, "css/site.css"), "utf8"), SITES.s1!.files[1]!.content);
    assert.ok(existsSync(path.join(dir, ".git")));
    const st = states.get("run-1")!;
    assert.equal(st.last, "s1");
    assert.equal(st.checkouts.s1!.baseline, true);
    assert.equal(st.checkouts.s1!.baseFingerprint, siteFingerprint(SITES.s1!.files));
    assert.equal(events.at(-1)!.event.payload!.tool, "site_checkout");
  });

  it("reuses the checkout on a second call (edits are kept)", async () => {
    const dir = path.join(sb.workdir, "sites", "acme-landing");
    await fs.writeFile(path.join(dir, "keep.txt"), "x");
    const r = await run("site_checkout", { site: "s1" });
    assert.match(r.summary, /already checked out/);
    assert.ok(existsSync(path.join(dir, "keep.txt")));
    await fs.rm(path.join(dir, "keep.txt"));
  });

  it("refuses CMS sites and unknown sites; needs a run", async () => {
    await assert.rejects(run("site_checkout", { site: "Blog" }), /wordpress site/);
    await assert.rejects(run("site_checkout", { site: "nope" }), /No site "nope".*Acme Landing/);
    await assert.rejects(run("site_checkout", { site: "s1" }, { ...ctx(), runId: undefined }), /tracked agent run/);
  });

  it("preview starts a static server and returns the run's preview link", async () => {
    const r = await run("site_checkout", { site: "s1", preview: true, port: 4321 });
    assert.deepEqual(exposed, [4321]);
    assert.match(r.summary, /Preview: \/api\/agent-runs\/run-1\/preview\/4321\//);
    assert.equal(states.get("run-1")!.checkouts.s1!.previewPort, 4321);
    const started = sb.log.find((e) => e.argv[0] === "sh" && e.argv[2]?.includes("http.server 4321"));
    assert.ok(started, "the static server command ran in the sandbox");
    await assert.rejects(run("site_checkout", { site: "s1", preview: true, port: 80 }), /1024 to 65535/);
    // Stop the background server this machine actually started (by its pid file).
    await sb.exec('kill "$(cat /tmp/shapes-site-preview-4321.pid)" 2>/dev/null; rm -f /tmp/shapes-site-preview-4321.pid; true');
  });
});

describe("site_publish_draft", () => {
  it("refuses to save when nothing changed", async () => {
    const r = await run("site_publish_draft", { summary: "nothing" });
    assert.match(r.summary, /No changes/);
    assert.equal(drafts.length, 0);
  });

  it("saves the sandbox files as a draft with the diff; never the live copy", async () => {
    const dir = path.join(sb.workdir, "sites", "acme-landing");
    await fs.writeFile(path.join(dir, "index.html"), "<h1>Acme</h1>\n<p>Call us today</p>\n");
    await fs.writeFile(path.join(dir, "new.html"), "<p>new</p>\n");
    await fs.mkdir(path.join(dir, "node_modules/x"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules/x/i.js"), "x");
    await fs.writeFile(path.join(dir, ".env"), "SECRET=1");
    await fs.writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    const r = await run("site_publish_draft", { summary: "Stronger call to action" });
    assert.match(r.summary, /Saved draft #1 of Acme Landing \(2 files changed/);
    assert.match(r.summary, /NOT live/);
    assert.match(r.summary, /logo\.png \(binary\)/);
    const d = drafts[0]!;
    assert.equal(d.status, "draft");
    assert.equal(d.source, "agent");
    assert.equal(d.siteId, "s1");
    assert.equal(d.runId, "run-1");
    assert.equal(d.baseFingerprint, siteFingerprint(SITES.s1!.files));
    assert.deepEqual(d.files.map((f) => f.path), ["/css/site.css", "/index.html", "/new.html"]);
    assert.match(d.patch!, /\+<p>Call us today<\/p>/);
    assert.match(d.patch!, /new\.html/);
    assert.doesNotMatch(d.patch!, /SECRET|node_modules/);
    const ev = events.at(-1)!.event.payload!;
    assert.equal(ev.tool, "site_publish_draft");
    assert.equal(typeof ev.patch, "string", "the Changes review reads this patch");
    assert.equal(ev.revisionId, "rev-1");
    // The "live" site (the canonical store) is untouched by the tool.
    assert.equal(SITES.s1!.files[0]!.content, "<h1>Acme</h1>\n<p>Call us</p>\n");
  });

  it("needs a checkout in this task", async () => {
    await assert.rejects(run("site_publish_draft", { summary: "x" }, ctx("run-2")), /call site_checkout first/);
    await assert.rejects(run("site_publish_draft", {}), /needs a summary/);
  });
});

describe("helpers", () => {
  it("snapshot paths drop dot-segments and escapes", () => {
    assert.equal(snapshotPath("a/b.html"), "/a/b.html");
    assert.equal(snapshotPath("/.git/config"), null);
    assert.equal(snapshotPath("../x"), null);
    assert.equal(snapshotPath("/"), null);
  });

  it("fingerprints ignore order", () => {
    const a = [{ path: "/a", content: "1" }, { path: "/b", content: "2" }];
    assert.equal(siteFingerprint(a), siteFingerprint([...a].reverse()));
    assert.notEqual(siteFingerprint(a), siteFingerprint([{ path: "/a", content: "1" }]));
  });

  it("dir names and the server command quote safely", () => {
    assert.equal(siteDirName({ id: "x1", name: "Acme Landing!" }), "acme-landing");
    assert.equal(siteDirName({ id: "x1", name: "!!!" }), "x1");
    assert.match(staticServerCommand("/w/it's", 5000), /cd '\/w\/it'\\''s'/);
  });

  it("readSandboxSite skips oversize files", async () => {
    const dir = path.join(sb.workdir, "big");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "big.html"), "x".repeat(300 * 1024));
    await fs.writeFile(path.join(dir, "ok.html"), "ok");
    const { files, skipped } = await readSandboxSite(sb, dir);
    assert.deepEqual(files.map((f) => f.path), ["/ok.html"]);
    assert.equal(skipped[0]!.path, "/big.html");
  });

  it("the registered tools are in the site group", async () => {
    await import("../tools");
    for (const n of SITE_TOOL_NAMES) {
      assert.equal(toolGroup(n), "site");
      assert.ok(allTools().some((t) => t.name === n), `${n} registered`);
    }
  });
});
