// ShapesOS — Phase 9 (sites): agents edit SiteBuilder sites in the sandbox.
//
//   site group
//     site_checkout      — copy a site's current files (its working copy, the
//                          canonical store: lib/sites/files.ts) into the run's
//                          sandbox under sites/<name>, commit a git baseline,
//                          and optionally serve it as a preview (a static
//                          server + exposePort → the existing preview route)
//     site_publish_draft — take the sandbox files back as a NEW draft revision
//                          of the site (site_revisions). Never touches the
//                          live working copy: a person applies the draft
//                          (Sites → Agent drafts), and deploy / publish stay
//                          their own gated actions.
//
// Edits in between use the code tools (write_file, edit_file, bash …).
// Both tools record one run event; the draft's event carries the diff, which
// the run page's Changes review shows (lib/ship/review.ts PATCH_TOOLS).
// Without a sandbox provider the tools refuse with the reason — never faked.

import { posix as path } from "node:path";
import { TOOL_RECORDED_EVENT, registerExtraTool, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import type { Sandbox } from "@/lib/sandbox/types";
import type { AgentRunEventInput } from "@/lib/agents/runs/types";
import { appendAgentRunEvent } from "@/lib/agents/runs/service";
import { isValidPreviewPort } from "@/lib/sandbox/preview";
import { shq } from "@/lib/sandbox/paths";
import { prisma } from "@/lib/prisma";
import { GIT_AUTHOR, capPatch, parseNumstat, type NumstatEntry } from "@/lib/ship/git";
import { defaultGetSandbox, type GetSandbox, type ShipToolContext } from "@/lib/ship/tools";
import {
  SITE_FILE_MAX_BYTES,
  SITE_SNAPSHOT_MAX_FILES,
  assertSnapshotSize,
  readSiteWorkingCopy,
  siteFingerprint,
  snapshotPath,
  type SiteFile,
  type SkippedFile,
} from "./files";
import { createSiteRevision, type CreateSiteRevisionInput, type SiteRevisionSummary } from "./revisions";
import { loadSiteRunState, saveSiteRunState, type SiteCheckout, type SiteRunState } from "./state";
import type { ShipLookup } from "@/lib/ship/state";

export const SITE_TOOL_NAMES = ["site_checkout", "site_publish_draft"] as const;
export const DEFAULT_SITE_PREVIEW_PORT = 4173;
/** Sources whose files live in the working copy (WordPress / Webflow are CMS content). */
const FILE_SOURCES = new Set(["file", "github", "sftp"]);
const GIT_TIMEOUT_MS = 60_000;
const SUMMARY_PATCH_CHARS = 12_000;

export interface SiteRef {
  id: string;
  name: string;
  projectId: string;
  sourceType: string;
}

export interface SiteToolDeps {
  getSandbox: GetSandbox;
  /** A site of this workspace by id, or by exact name in the task's project. */
  findSite: (workspaceId: string, projectId: string, ref: string) => Promise<{ site: SiteRef | null; names: string[] }>;
  readSite: (siteId: string) => Promise<{ files: SiteFile[]; skipped: SkippedFile[] }>;
  saveDraft: (input: CreateSiteRevisionInput) => Promise<SiteRevisionSummary>;
  loadState: (q: ShipLookup) => Promise<SiteRunState | null>;
  saveState: (workspaceId: string, runId: string, state: SiteRunState) => Promise<void>;
  recordEvent: (workspaceId: string, runId: string, event: AgentRunEventInput) => Promise<void>;
  /** exposeForRun (lib/sandbox/tools.ts) — loaded lazily. */
  expose: (ctx: ShipToolContext, sb: Sandbox, port: number) => Promise<{ url: string }>;
}

async function findSiteDefault(workspaceId: string, projectId: string, ref: string) {
  const select = { id: true, name: true, projectId: true, sourceType: true } as const;
  const byId = await prisma.site.findFirst({ where: { id: ref, project: { workspaceId } }, select });
  if (byId) return { site: { ...byId, sourceType: String(byId.sourceType) }, names: [] };
  const inProject = await prisma.site.findMany({
    where: { projectId, project: { workspaceId } },
    select,
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const hits = inProject.filter((s) => s.name.trim().toLowerCase() === ref.trim().toLowerCase());
  return {
    site: hits.length === 1 ? { ...hits[0]!, sourceType: String(hits[0]!.sourceType) } : null,
    names: inProject.map((s) => s.name),
  };
}

export const defaultSiteToolDeps: SiteToolDeps = {
  getSandbox: (ctx) => defaultGetSandbox(ctx),
  findSite: findSiteDefault,
  readSite: (siteId) => readSiteWorkingCopy(siteId),
  saveDraft: createSiteRevision,
  loadState: loadSiteRunState,
  saveState: saveSiteRunState,
  recordEvent: async (ws, runId, event) => {
    await appendAgentRunEvent(ws, runId, event);
  },
  expose: async (ctx, sb, port) => {
    const { exposeForRun } = await import("@/lib/sandbox/tools");
    return exposeForRun(ctx, sb, port);
  },
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function needRun(ctx: ShipToolContext): string {
  if (!ctx.runId) throw new Error("Site tools work inside a tracked agent run; start this as a task.");
  return ctx.runId;
}

function threadOf(ctx: ShipToolContext): string | undefined {
  return typeof ctx.threadId === "string" && ctx.threadId ? ctx.threadId : undefined;
}

/** sites/<slug> directory name for a site (falls back to its id). */
export function siteDirName(site: { id: string; name: string }): string {
  const slug = site.name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || site.id;
}

async function record(deps: SiteToolDeps, ctx: ShipToolContext, summary: string, payload: Record<string, unknown>) {
  if (!ctx.runId) return;
  await deps.recordEvent(ctx.workspaceId, ctx.runId, { type: "agui", summary: summary.slice(0, 500), payload }).catch(() => undefined);
}

function done(summary: string, details: Record<string, unknown>): ToolResult {
  return { summary, details: { ...details, [TOOL_RECORDED_EVENT]: true } };
}

async function exists(sb: Sandbox, ctx: ShipToolContext, p: string): Promise<boolean> {
  return (await sb.exec(["test", "-e", p], { timeoutMs: 15_000, signal: ctx.signal })).exitCode === 0;
}

async function gitIn(sb: Sandbox, ctx: ShipToolContext, dir: string, ...args: string[]) {
  return sb.exec(["git", "-C", dir, "-c", `user.name=${GIT_AUTHOR.name}`, "-c", `user.email=${GIT_AUTHOR.email}`, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    signal: ctx.signal,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}

/** Start a static file server for `dir` on `port` (background; survives the exec). */
export function staticServerCommand(dir: string, port: number): string {
  const log = `/tmp/shapes-site-preview-${port}.log`;
  const d = shq(dir);
  return [
    `cd ${d} || exit 1`,
    `if command -v python3 >/dev/null 2>&1; then nohup python3 -m http.server ${port} --bind 0.0.0.0 >${log} 2>&1 &`,
    `elif command -v busybox >/dev/null 2>&1; then nohup busybox httpd -f -p ${port} -h ${d} >${log} 2>&1 &`,
    `else nohup npx --yes http-server ${d} -p ${port} -s -c-1 >${log} 2>&1 &`,
    "fi",
    "sleep 1",
    "echo started",
  ].join("\n");
}

/** Files under dir as a snapshot: text only, no dot-paths / node_modules, capped. */
export async function readSandboxSite(
  sb: Sandbox,
  dir: string,
): Promise<{ files: SiteFile[]; skipped: SkippedFile[] }> {
  const entries = await sb.listFiles(dir, { recursive: true, maxEntries: SITE_SNAPSHOT_MAX_FILES + 2000 });
  const files: SiteFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const e of entries) {
    if (e.type !== "file") continue;
    const rel = e.path.replace(/^\.\/+/, "");
    if (rel.split("/").some((seg) => seg === "node_modules")) continue;
    const p = snapshotPath(rel);
    if (!p) continue; // dotfiles / .git
    if ((e.size ?? 0) > SITE_FILE_MAX_BYTES) {
      skipped.push({ path: p, reason: `over ${SITE_FILE_MAX_BYTES / 1024} KB` });
      continue;
    }
    const buf = await sb.readFile(path.join(dir, p));
    if (buf.length > SITE_FILE_MAX_BYTES) {
      skipped.push({ path: p, reason: `over ${SITE_FILE_MAX_BYTES / 1024} KB` });
      continue;
    }
    if (buf.includes(0)) {
      skipped.push({ path: p, reason: "binary" });
      continue;
    }
    files.push({ path: p, content: buf.toString("utf8") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

function pickCheckout(state: SiteRunState | null, ref: string | undefined): SiteCheckout | null {
  if (!state) return null;
  const all = Object.values(state.checkouts);
  if (ref) {
    const r = ref.toLowerCase();
    return all.find((c) => c.siteId === ref) ?? all.find((c) => c.siteName.toLowerCase() === r) ?? null;
  }
  return (state.last ? state.checkouts[state.last] : null) ?? (all.length === 1 ? all[0]! : null);
}

function skippedNote(skipped: SkippedFile[]): string {
  if (!skipped.length) return "";
  const list = skipped.slice(0, 8).map((s) => `${s.path} (${s.reason})`).join(", ");
  return ` Left out ${skipped.length} file${skipped.length === 1 ? "" : "s"}: ${list}${skipped.length > 8 ? " …" : ""}.`;
}

/** Build the site tools against a set of dependencies (tests inject fakes). */
export function createSiteTools(deps: SiteToolDeps = defaultSiteToolDeps): ToolDef[] {
  const site_checkout: ToolDef = {
    name: "site_checkout",
    description:
      "Copy a website from Sites (a SiteBuilder / IDE site, by id or exact name) into this task's code sandbox so you can edit it with the code tools. Set preview to serve it and get a preview link. When you are done, save the work with site_publish_draft — the live site never changes from here.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        site: { type: "string", description: "The site's id, or its exact name in this project (required)." },
        preview: { type: "boolean", description: "Also start a static preview server and return its link." },
        port: { type: "number", description: `Preview port (default ${DEFAULT_SITE_PREVIEW_PORT}).` },
        fresh: { type: "boolean", description: "Throw away an earlier checkout of this site in this task and copy it again." },
      },
      required: ["site"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const ref = str(args.site);
      if (!ref) throw new Error("Name the site to check out (its id or exact name).");
      const { site, names } = await deps.findSite(ctx.workspaceId, ctx.projectId, ref);
      if (!site) {
        throw new Error(
          names.length
            ? `No site "${ref}" in this project. Sites here: ${names.slice(0, 20).join(", ")}.`
            : `No site "${ref}" in this project (it has no sites yet).`,
        );
      }
      if (!FILE_SOURCES.has(site.sourceType)) {
        throw new Error(`${site.name} is a ${site.sourceType} site — its pages live in the CMS, not in files; edit it through the CMS tools.`);
      }
      const state = (await deps.loadState({ workspaceId: ctx.workspaceId, runId, threadId: threadOf(ctx) })) ?? { checkouts: {} };
      const sb = await deps.getSandbox(ctx);
      const fresh = args.fresh === true || args.fresh === "true";

      let checkout = state.checkouts[site.id] ?? null;
      let reused = false;
      if (checkout && !fresh && (await exists(sb, ctx, checkout.dir))) {
        reused = true;
      } else {
        const { files, skipped } = await deps.readSite(site.id);
        let dir = checkout?.dir ?? path.join(sb.workdir, "sites", siteDirName(site));
        if (checkout && fresh) {
          await sb.exec(["rm", "-rf", "--", dir], { timeoutMs: 60_000, signal: ctx.signal });
        } else {
          for (let i = 2; (await exists(sb, ctx, dir)) && i < 50; i++) dir = path.join(sb.workdir, "sites", `${siteDirName(site)}-${i}`);
        }
        await sb.exec(["mkdir", "-p", dir], { timeoutMs: 15_000, signal: ctx.signal });
        for (const f of files) await sb.writeFile(path.join(dir, f.path), f.content);
        // A git baseline, so the draft carries a reviewable diff.
        let baseline = false;
        const init = await gitIn(sb, ctx, dir, "init", "-q");
        if (init.exitCode === 0) {
          await sb.writeFile(path.join(dir, ".git", "info", "exclude"), "node_modules/\n.*\n!.gitignore\n");
          const add = await gitIn(sb, ctx, dir, "add", "-A");
          const commit = await gitIn(sb, ctx, dir, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "site checkout");
          baseline = add.exitCode === 0 && commit.exitCode === 0;
        }
        checkout = {
          siteId: site.id,
          siteName: site.name,
          projectId: site.projectId,
          dir,
          baseFingerprint: siteFingerprint(files),
          fileCount: files.length,
          baseline,
          checkoutRunId: runId,
          checkedOutAt: new Date().toISOString(),
        };
        if (skipped.length) {
          await record(deps, ctx, `Left ${skipped.length} unreadable file(s) of ${site.name} out of the checkout`, {
            tool: "site_checkout",
            siteId: site.id,
            skipped: skipped.slice(0, 50),
          });
        }
      }

      let previewNote = "";
      if (args.preview === true || args.preview === "true") {
        const port = typeof args.port === "number" ? args.port : Number(args.port ?? DEFAULT_SITE_PREVIEW_PORT);
        if (!isValidPreviewPort(port)) throw new Error("The preview port must be a whole number from 1024 to 65535.");
        const started = await sb.exec(staticServerCommand(checkout.dir, port), { timeoutMs: 120_000, signal: ctx.signal });
        if (started.exitCode !== 0) {
          previewNote = ` Could not start a preview server: ${(started.stderr || started.stdout).trim().slice(0, 300)}`;
        } else {
          const { url } = await deps.expose(ctx, sb, port);
          checkout = { ...checkout, previewPort: port, previewUrl: url };
          previewNote = ` Preview: ${url} (a static server; links that start with "/" resolve against the preview root).`;
        }
      }

      const next: SiteRunState = { checkouts: { ...state.checkouts, [site.id]: checkout }, last: site.id };
      await deps.saveState(ctx.workspaceId, runId, next);
      await record(deps, ctx, `${reused ? "Using" : "Checked out"} ${site.name} (${checkout.fileCount} files)`, {
        tool: "site_checkout",
        siteId: site.id,
        siteName: site.name,
        dir: checkout.dir,
        fileCount: checkout.fileCount,
        reused,
        preview: checkout.previewUrl ?? null,
      });
      return done(
        `${reused ? `${site.name} is already checked out` : `Checked out ${site.name}`} at ${checkout.dir} (${checkout.fileCount} files). Edit it with the code tools, then call site_publish_draft to save a draft — the live site does not change.${previewNote}`,
        { siteId: site.id, dir: checkout.dir, fileCount: checkout.fileCount, preview: checkout.previewUrl ?? null },
      );
    },
  };

  const site_publish_draft: ToolDef = {
    name: "site_publish_draft",
    description:
      "Save the checked-out site's files from the sandbox as a NEW draft revision of that site, with a summary of what changed. Does not change the live site: a person reviews and applies the draft, then deploys or publishes it as usual.",
    kind: "safe",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What changed and why (required)." },
        site: { type: "string", description: "Which checkout (id or name) when this task checked out more than one site." },
      },
      required: ["summary"],
    },
    async execute(rawCtx, args) {
      const ctx = rawCtx as ShipToolContext;
      const runId = needRun(ctx);
      const summary = str(args.summary);
      if (!summary) throw new Error("A draft needs a summary of what changed.");
      const state = await deps.loadState({ workspaceId: ctx.workspaceId, runId, threadId: threadOf(ctx) });
      const checkout = pickCheckout(state, str(args.site));
      if (!checkout) {
        throw new Error(
          state && Object.keys(state.checkouts).length > 1
            ? `Say which site: ${Object.values(state.checkouts).map((c) => c.siteName).join(", ")}.`
            : "Nothing is checked out in this task yet — call site_checkout first.",
        );
      }
      const sb = await deps.getSandbox(ctx);
      if (!(await exists(sb, ctx, checkout.dir))) {
        throw new Error(`The checkout of ${checkout.siteName} is gone (the sandbox was replaced). Check it out again; earlier edits were not saved.`);
      }
      const { files, skipped } = await readSandboxSite(sb, checkout.dir);
      if (!files.length) throw new Error(`${checkout.dir} has no files to save.`);
      assertSnapshotSize(files);
      if (siteFingerprint(files) === checkout.baseFingerprint) {
        await record(deps, ctx, `No changes to ${checkout.siteName}`, { tool: "site_publish_draft", siteId: checkout.siteId, saved: false });
        return done(`No changes to ${checkout.siteName} since it was checked out — nothing saved.`, { saved: false });
      }

      // The diff against the checkout baseline (new files included).
      let patch: string | null = null;
      let truncated = false;
      let changed: NumstatEntry[] = [];
      if (checkout.baseline) {
        await gitIn(sb, ctx, checkout.dir, "add", "-A", "-N");
        const common = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "HEAD"];
        const [p, n] = await Promise.all([gitIn(sb, ctx, checkout.dir, ...common), gitIn(sb, ctx, checkout.dir, ...common, "--numstat")]);
        if (p.exitCode === 0) {
          const capped = capPatch(p.stdout);
          patch = capped.patch;
          truncated = capped.truncated;
          changed = parseNumstat(n.stdout);
        }
      }
      const additions = changed.reduce((s, f) => s + (f.additions ?? 0), 0);
      const deletions = changed.reduce((s, f) => s + (f.deletions ?? 0), 0);

      const revision = await deps.saveDraft({
        workspaceId: ctx.workspaceId,
        siteId: checkout.siteId,
        status: "draft",
        source: "agent",
        files,
        runId,
        summary,
        patch,
        patchTruncated: truncated,
        baseFingerprint: checkout.baseFingerprint,
        createdBy: ctx.userId,
      });
      const headline = changed.length
        ? `${changed.length} file${changed.length === 1 ? "" : "s"} changed (+${additions} −${deletions})`
        : `${files.length} files`;
      await record(deps, ctx, `Saved draft #${revision.number} of ${checkout.siteName}: ${headline}`, {
        tool: "site_publish_draft",
        siteId: checkout.siteId,
        siteName: checkout.siteName,
        revisionId: revision.id,
        number: revision.number,
        patch: patch ?? undefined,
        truncated,
        files: changed,
        additions,
        deletions,
        skipped: skipped.slice(0, 50),
      });
      const forModel = patch && patch.length > SUMMARY_PATCH_CHARS ? `${patch.slice(0, SUMMARY_PATCH_CHARS)}\n… (diff cut here)` : patch;
      return done(
        `Saved draft #${revision.number} of ${checkout.siteName} (${headline}). It is NOT live: a person applies it from Sites → Agent drafts, then deploys or publishes as usual.${skippedNote(skipped)}${forModel ? `\n${forModel}` : ""}`,
        { saved: true, revisionId: revision.id, number: revision.number, files: changed, skipped },
      );
    },
  };

  return [site_checkout, site_publish_draft];
}

let registered = false;

/** Register the site tools with the chat tool registry (idempotent). */
export function registerSiteTools(deps: SiteToolDeps = defaultSiteToolDeps): void {
  if (registered) return;
  registered = true;
  for (const t of createSiteTools(deps)) registerExtraTool(t);
}

registerSiteTools();
