// ShapesOS Phase 11 (seotools): put JSON-LD into a SiteBuilder site — as a
// DRAFT revision, never straight to the live working copy.
//
// Reads the working copy (lib/sites/files), works out each page's blocks
// (suggestJsonLdForPage from the site's own data, plus any blocks the caller
// supplies — e.g. Product / Article / LocalBusiness from the agent), checks
// every block with the validator (an invalid block is refused, never
// written), injects them (lib/seo/jsonld injectJsonLd — idempotent, only our
// own blocks are replaced; ones of other types from earlier runs are kept)
// and saves the whole snapshot as a Phase 9 draft
// (lib/sites/revisions createSiteRevision, source "agent"). A person reviews
// the diff and applies it in Site drafts; deploying stays a separate step.

import { createTwoFilesPatch } from "diff";
import { prisma } from "@/lib/prisma";
import type { WorkingCopyProvider } from "@/lib/connectors/local";
import { assertSnapshotSize, readSiteWorkingCopy, siteFingerprint, type SiteFile } from "@/lib/sites/files";
import { createSiteRevision, type SiteRevisionSummary } from "@/lib/sites/revisions";
import { capPatch } from "@/lib/ship/git";
// Phase 21A (WS=agentweb): keep the actions/contactPoint the agent-ready flow added to a block.
import { carryOverAgentFields } from "@/lib/agentweb/site/actions";
import { resolveLiveAuditUrl } from "@/lib/audit/project-audit";
import {
  injectJsonLd,
  injectedJsonLd,
  suggestJsonLdForPage,
  validateJsonLd,
  type JsonLd,
  type JsonLdIssue,
  type SiteIdentity,
} from "./jsonld";

export class JsonLdDraftError extends Error {
  constructor(
    readonly code: "no_origin" | "invalid_block" | "no_pages" | "unreadable_files",
    message: string,
    readonly issues: JsonLdIssue[] = [],
  ) {
    super(message);
    this.name = "JsonLdDraftError";
  }
}

export interface PagePlan {
  path: string;
  types: string[];
  changed: boolean;
}

export interface JsonLdPlan {
  identity: SiteIdentity;
  pages: PagePlan[];
  files: SiteFile[];
  baseFiles: SiteFile[];
}

export interface JsonLdDraftInput {
  workspaceId: string;
  projectId: string;
  siteId: string;
  /** Pages to touch (working-copy paths); default every HTML page. */
  paths?: string[];
  /** Extra blocks per page path, validated before anything is written. */
  extra?: Record<string, JsonLd[]>;
  /** Overrides for the derived identity (name, origin, logo, sameAs). */
  identity?: Partial<SiteIdentity>;
  createdBy?: string | null;
  runId?: string | null;
  /** Test seam: the working copy. */
  provider?: WorkingCopyProvider;
}

const HTML = /\.html?$/i;

/** Site identity from the workspace, site and live URL (deployment, else project domain). */
export async function siteIdentity(input: Pick<JsonLdDraftInput, "workspaceId" | "projectId" | "siteId" | "identity">): Promise<SiteIdentity> {
  const [site, workspace] = await Promise.all([
    prisma.site.findFirst({ where: { id: input.siteId, projectId: input.projectId }, select: { name: true } }),
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true, whiteLabelLogoUrl: true } }),
  ]);
  const live = input.identity?.origin ?? (await resolveLiveAuditUrl(input.siteId, input.projectId));
  let origin: string | null = null;
  try {
    origin = live ? new URL(live).origin : null;
  } catch {
    origin = null;
  }
  if (!origin) {
    throw new JsonLdDraftError("no_origin", "Structured data needs the site's absolute URL: deploy the site or set the project domain first.");
  }
  const logo = input.identity?.logo ?? workspace?.whiteLabelLogoUrl ?? null;
  return {
    name: input.identity?.name?.trim() || workspace?.name || site?.name || new URL(origin).hostname,
    origin,
    logo: logo && /^https?:\/\//i.test(logo) ? logo : null,
    sameAs: input.identity?.sameAs,
  };
}

/** Work out the new files without saving anything (preview + the draft both use it). */
export async function planJsonLd(input: JsonLdDraftInput): Promise<JsonLdPlan> {
  const identity = await siteIdentity(input);
  const { files, skipped } = await readSiteWorkingCopy(input.siteId, input.provider);
  if (skipped.length) {
    throw new JsonLdDraftError(
      "unreadable_files",
      `The working copy has ${skipped.length} file${skipped.length === 1 ? "" : "s"} a draft can't hold (${skipped.slice(0, 3).map((s) => s.path).join(", ")}); fix those first.`,
    );
  }
  const wanted = input.paths?.length ? new Set(input.paths) : null;
  const extras = input.extra ?? {};
  for (const [path, blocks] of Object.entries(extras)) {
    const issues = blocks.flatMap((b) => validateJsonLd(b)).filter((i) => i.severity === "error");
    if (issues.length) {
      throw new JsonLdDraftError(
        "invalid_block",
        `The structured data for ${path} is invalid: ${issues.slice(0, 4).map((i) => `${i.path} — ${i.message}`).join("; ")}`,
        issues,
      );
    }
    if (!files.some((f) => f.path === path)) {
      throw new JsonLdDraftError("no_pages", `${path} is not a page of this site.`);
    }
  }

  const pages: PagePlan[] = [];
  const next = files.map((f) => {
    if (!HTML.test(f.path) || (wanted && !wanted.has(f.path) && !extras[f.path])) return f;
    const fresh = carryOverAgentFields([...suggestJsonLdForPage(f.path, f.content, identity), ...(extras[f.path] ?? [])], injectedJsonLd(f.content));
    // Blocks we injected earlier whose @type isn't regenerated now (e.g. a
    // Product the agent supplied last time) are kept: re-runs only add/update.
    const freshTypes = new Set(fresh.map((b) => JSON.stringify(b["@type"])));
    const kept = injectedJsonLd(f.content).filter((b) => !freshTypes.has(JSON.stringify(b["@type"])));
    const blocks = [...fresh, ...kept];
    // Our own suggestions are valid by construction; checked anyway (fail closed).
    const bad = blocks.flatMap((b) => validateJsonLd(b)).filter((i) => i.severity === "error");
    if (bad.length) throw new JsonLdDraftError("invalid_block", `Generated structured data for ${f.path} is invalid: ${bad[0].message}`, bad);
    const content = injectJsonLd(f.content, blocks);
    pages.push({ path: f.path, types: blocks.map((b) => String(b["@type"])), changed: content !== f.content });
    return content === f.content ? f : { path: f.path, content };
  });
  if (!pages.length) throw new JsonLdDraftError("no_pages", "No HTML pages to add structured data to.");
  return { identity, pages, files: next, baseFiles: files };
}

/** Unified diff of the changed files (capped like agent drafts). */
export function planPatch(plan: Pick<JsonLdPlan, "files" | "baseFiles">): { patch: string; truncated: boolean } {
  const before = new Map(plan.baseFiles.map((f) => [f.path, f.content]));
  const parts: string[] = [];
  for (const f of plan.files) {
    const old = before.get(f.path);
    if (old === undefined || old === f.content) continue;
    const rel = f.path.replace(/^\//, "");
    parts.push(createTwoFilesPatch(`a/${rel}`, `b/${rel}`, old, f.content, "", "", { context: 2 }).replace(/^=+\n/m, ""));
  }
  return capPatch(parts.join(""));
}

export interface JsonLdDraftResult {
  /** Null when every page already carried exactly these blocks. */
  revision: SiteRevisionSummary | null;
  pages: PagePlan[];
  origin: string;
}

/** Save the planned JSON-LD as a draft revision of the site. */
export async function createJsonLdDraft(input: JsonLdDraftInput): Promise<JsonLdDraftResult> {
  const plan = await planJsonLd(input);
  const changed = plan.pages.filter((p) => p.changed);
  if (!changed.length) return { revision: null, pages: plan.pages, origin: plan.identity.origin };
  assertSnapshotSize(plan.files);
  const { patch, truncated } = planPatch(plan);
  const types = [...new Set(changed.flatMap((p) => p.types))].join(", ");
  const revision = await createSiteRevision({
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    status: "draft",
    source: "agent",
    files: plan.files,
    runId: input.runId ?? null,
    summary: `Structured data (${types}) on ${changed.length} page${changed.length === 1 ? "" : "s"}`,
    patch,
    patchTruncated: truncated,
    baseFingerprint: siteFingerprint(plan.baseFiles),
    createdBy: input.createdBy ?? null,
  });
  return { revision, pages: plan.pages, origin: plan.identity.origin };
}
