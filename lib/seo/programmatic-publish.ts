// Marketr — push programmatic SEO pages through existing publishing connectors
// (milestone 17 push).
//
// The M17 service's "publish" is internal-only (status → published + CSV
// export + sitemap). This module pushes a page to a real destination using
// the existing connectors — exactly the payload/auth conventions of the
// milestone-8 `publish-content` flow (lib/connectors): WordPress content
// connector (page create/update), Webflow content connector (CMS item
// create/update), or the M6/M7 site IDE working copy (file write).
//
// Guarantees:
//   - All M17 server-side quality gates (slug/content-hash collisions,
//     thin-content, missing variables, duplicate-rate cap) are evaluated
//     before any push — gated pages never reach a connector.
//   - Idempotent: re-pushing an already-published page to the same target
//     updates in place using the stored externalId. Pushing an already-
//     published page to a *different* target is blocked.
//   - Every push is audit-logged (target, external id/url); push failures
//     emit the M13 `programmatic_publish_failed` alert.
//   - The sitemap regenerates after any successful push (existing behavior).

import { prisma } from "@/lib/prisma";
import {
  QUALITY_FLAGS,
  evaluateGates,
  tiptapToHtml,
} from "./programmatic";
import {
  auditProgrammatic,
  publishProgrammaticPages,
  regenerateSitemap,
  templateDuplicateRate,
  type PageActionResult,
} from "./programmatic-service";
import { emitAlert } from "@/lib/alerts/evaluate";
import {
  getContentConnector,
  getSiteIdeProvider,
  ownedSite,
  siteIsMock,
  type OwnedSite,
} from "@/lib/connectors/source";
import { sanitizePath } from "@/lib/sitefiles/paths";
import type { ContentConnector } from "@/lib/connectors/types";

/** Publish target kinds. "csv" = the existing internal publish (no remote). */
export const PUBLISH_TARGETS = ["none", "csv", "wordpress", "webflow", "marketr-site"] as const;
export type PublishTargetKind = (typeof PUBLISH_TARGETS)[number];

export function isPublishTarget(v: unknown): v is PublishTargetKind {
  return typeof v === "string" && (PUBLISH_TARGETS as readonly string[]).includes(v);
}

/** Site sourceTypes that satisfy each connector-backed target. */
const TARGET_SOURCE_TYPES: Record<string, string[]> = {
  wordpress: ["wordpress"],
  webflow: ["webflow"],
  // The IDE working copy exists for every site; for github/sftp the remote
  // still needs a sync/deploy afterwards (noted in the audit summary).
  "marketr-site": ["github", "sftp", "file", "wordpress", "webflow"],
};

export interface ResolvedDestination {
  kind: PublishTargetKind;
  /** Site id for wordpress/webflow/marketr-site. */
  siteId: string | null;
  /** Webflow CMS collection id. */
  collectionId: string | null;
}

interface DestinationInputs {
  target?: string | null;
  siteId?: string | null;
  collectionId?: string | null;
}

/**
 * Destination precedence: explicit (push call) > per-page override >
 * per-template default > "none".
 */
export function resolveDestination(args: {
  explicit?: DestinationInputs | null;
  page: { publishTarget: string; targetSiteId: string | null; webflowCollectionId: string | null };
  template: {
    defaultPublishTarget: string;
    defaultTargetSiteId: string | null;
    defaultWebflowCollectionId: string | null;
  };
}): ResolvedDestination {
  const kind = (args.explicit?.target ?? args.page.publishTarget ?? "none") || "none";
  const pageTarget = isPublishTarget(kind) ? kind : "none";
  // "none" on the page means "inherit the template default".
  const effectiveKind: PublishTargetKind =
    args.explicit?.target !== undefined && args.explicit?.target !== null
      ? pageTarget
      : pageTarget === "none" && isPublishTarget(args.template.defaultPublishTarget)
        ? (args.template.defaultPublishTarget as PublishTargetKind)
        : pageTarget;
  const siteId =
    args.explicit?.siteId ?? args.page.targetSiteId ?? args.template.defaultTargetSiteId ?? null;
  const collectionId =
    args.explicit?.collectionId ??
    args.page.webflowCollectionId ??
    args.template.defaultWebflowCollectionId ??
    null;
  return { kind: effectiveKind, siteId, collectionId };
}

export function destinationLabel(dest: ResolvedDestination): string {
  if (dest.kind === "none") return "none (inherit → nothing)";
  if (dest.kind === "csv") return "CSV export (internal)";
  return dest.kind;
}

export type PushMode = "create" | "update";

export interface PushClassification {
  mode: PushMode;
  /** Set when the page must not be pushed at all (gated elsewhere too). */
  blockedReason: string | null;
}

/**
 * Pure idempotency classifier (fixture-tested). A published page re-pushed to
 * the same target + site + collection with a stored external id updates in
 * place; a page published to a *different* destination is blocked so we never
 * silently duplicate content across targets.
 *
 * Day-1 (#16): the same-target check includes the Webflow collection id —
 * re-pushing a col-A item while targeting col-B must not "update" col-A's
 * item (it would write into the wrong collection).
 */
export function classifyPush(args: {
  status: string;
  publishTarget: string | null;
  targetSiteId: string | null;
  targetCollectionId: string | null;
  externalId: string | null;
  dest: ResolvedDestination;
}): PushClassification {
  if (args.status !== "draft" && args.status !== "ready" && args.status !== "published") {
    return { mode: "create", blockedReason: `Cannot push from status: ${args.status}` };
  }
  if (args.status === "published") {
    const sameTarget =
      args.publishTarget === args.dest.kind &&
      (args.targetSiteId ?? null) === (args.dest.siteId ?? null) &&
      (args.targetCollectionId ?? null) === (args.dest.collectionId ?? null) &&
      !!args.externalId;
    if (sameTarget) return { mode: "update", blockedReason: null };
    const where =
      args.publishTarget && args.publishTarget !== "none"
        ? ` (already published to ${args.publishTarget})`
        : "";
    return {
      mode: "create",
      blockedReason: `Already published${where} — re-push to the same target to update in place`,
    };
  }
  return { mode: "create", blockedReason: null };
}

/* ------------------------------------------------------------------ */
/* Payload builders (pure — fixture-tested)                            */
/* ------------------------------------------------------------------ */

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * <head> meta tags for a programmatic page. Honest scope: the WordPress REST
 * API has no native canonical/meta endpoints, so these ride along as HTML
 * meta tags at the top of the pushed content (and in the full document for
 * Marketr-site targets). Themes/SEO plugins that output the content body
 * render them; a head-injecting SEO plugin may override them.
 */
export function buildHeadMeta(args: {
  description: string;
  canonical: string | null;
  noindex: boolean;
}): string {
  const lines: string[] = [];
  if (args.description.trim())
    lines.push(`<meta name="description" content="${escapeAttr(args.description.trim())}">`);
  if (args.canonical) lines.push(`<link rel="canonical" href="${escapeAttr(args.canonical)}">`);
  if (args.noindex) lines.push(`<meta name="robots" content="noindex, follow">`);
  return lines.join("\n");
}

/** Full HTML document for the marketr-site target (IDE working copy). */
export function buildSiteHtml(args: {
  title: string;
  description: string;
  canonical: string | null;
  noindex: boolean;
  bodyHtml: string;
}): string {
  const meta = buildHeadMeta(args);
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(args.title)}</title>\n${meta}\n</head>\n<body>\n${args.bodyHtml}\n</body>\n</html>\n`;
}

/**
 * File path for a programmatic page inside a site working copy.
 * "/services/austin/plumbing" → "/services/austin/plumbing.html".
 */
export function siteFilePathForUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return sanitizePath(`${trimmed || "/index"}.html`);
}

/**
 * Webflow CMS item fieldData — the same shape the milestone-8 publish-content
 * flow uses ({ name, slug, "page-html" }), with the meta tags prepended to
 * the HTML so the collection template renders them.
 */
export function webflowFieldDataForPage(args: {
  title: string;
  slug: string;
  metaHtml: string;
  bodyHtml: string;
}): string {
  return JSON.stringify(
    {
      name: args.title,
      slug: args.slug,
      "page-html": `${args.metaHtml}${args.metaHtml ? "\n" : ""}${args.bodyHtml}`,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* Push orchestration                                                  */
/* ------------------------------------------------------------------ */

export interface PushDetail {
  id: string;
  url: string;
  target: PublishTargetKind;
  siteName: string | null;
  externalId: string | null;
  externalUrl: string | null;
  /** True when an existing remote page/item/file was updated in place. */
  updated: boolean;
  mock: boolean;
}

export interface PushActionResult extends PageActionResult {
  pushes: PushDetail[];
}

interface PageWithTemplate {
  id: string;
  url: string;
  slug: string;
  status: string;
  noindex: boolean;
  canonical: string | null;
  content: unknown;
  qualityFlags: unknown;
  publishTarget: string;
  targetSiteId: string | null;
  webflowCollectionId: string | null;
  externalId: string | null;
  template: {
    id: string;
    name: string;
    minWordCount: number;
    duplicateRateCap: number;
    defaultPublishTarget: string;
    defaultTargetSiteId: string | null;
    defaultWebflowCollectionId: string | null;
  };
}

async function emitPushFailure(args: {
  workspaceId: string;
  projectId: string;
  pageId: string;
  url: string;
  target: string;
  reason: string;
}): Promise<void> {
  const dayKey = new Date().toISOString().slice(0, 10);
  try {
    await emitAlert({
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      trigger: "programmatic_publish_failed",
      severity: "warn",
      title: `⚠️ Programmatic push failed: ${args.url}`,
      body: `Push to ${args.target} failed: ${args.reason}`,
      link: `/dashboard/projects/${args.projectId}/programmatic`,
      dedupKey: `programmatic_publish_failed:${args.pageId}:${dayKey}`,
    });
  } catch {
    // alert failures never break the push
  }
}

function pageContentOf(content: unknown): {
  title: string;
  description: string;
  bodyHtml: string;
  wordCount: number;
  missingVariables: string[];
} {
  const c = (content ?? {}) as {
    title?: string;
    description?: string;
    contentBlocks?: unknown;
    wordCount?: number;
    missingVariables?: string[];
  };
  return {
    title: c.title ?? "",
    description: c.description ?? "",
    bodyHtml: c.contentBlocks ? tiptapToHtml(c.contentBlocks) : "",
    wordCount: c.wordCount ?? 0,
    missingVariables: c.missingVariables ?? [],
  };
}

function contentOf(connector: ContentConnector): ContentConnector {
  return connector;
}

/** Push one page to a connector-backed target. Returns remote refs. */
async function pushToConnector(args: {
  page: PageWithTemplate;
  dest: ResolvedDestination;
  site: OwnedSite;
  updateMode: boolean;
  webflowPublish: boolean;
}): Promise<{ externalId: string | null; externalUrl: string | null; mock: boolean; siteName: string }> {
  const { page, dest, site } = args;
  const pc = pageContentOf(page.content);
  const canonical = page.canonical;
  const mock = siteIsMock(site);

  if (dest.kind === "marketr-site") {
    const provider = await getSiteIdeProvider(site);
    const filePath = args.updateMode && page.externalId ? page.externalId : siteFilePathForUrl(page.url);
    const safe = sanitizePath(filePath);
    const html = buildSiteHtml({
      title: pc.title,
      description: pc.description,
      canonical,
      noindex: false,
      bodyHtml: pc.bodyHtml,
    });
    await provider.writeFile(safe, html);
    const note =
      site.sourceType === "github" || site.sourceType === "sftp"
        ? " — written to the IDE working copy; run sync/deploy to publish to the remote"
        : "";
    return { externalId: safe, externalUrl: null, mock: false, siteName: `${site.name}${note}` };
  }

  const connector = contentOf(await getContentConnector(site));
  const meta = buildHeadMeta({ description: pc.description, canonical, noindex: false });
  const id = args.updateMode && page.externalId ? page.externalId : undefined;

  if (dest.kind === "wordpress") {
    const detail = await connector.saveContent("page", {
      id,
      title: pc.title,
      slug: page.slug,
      content: `${meta}${meta ? "\n" : ""}${pc.bodyHtml}`,
      status: "publish",
    });
    return {
      externalId: detail.id,
      externalUrl: detail.link ?? null,
      mock: detail.mock === true || mock,
      siteName: site.name,
    };
  }

  // webflow
  const collectionId = dest.collectionId;
  if (!collectionId) throw new Error("Webflow push needs a CMS collection id");
  const detail = await connector.saveContent(
    "item",
    {
      id,
      title: pc.title,
      slug: page.slug,
      content: webflowFieldDataForPage({ title: pc.title, slug: page.slug, metaHtml: meta, bodyHtml: pc.bodyHtml }),
      status: "publish",
      collectionId,
    },
    { collectionId },
  );
  if (args.webflowPublish && "publishSite" in connector) {
    await (connector as { publishSite(): Promise<{ ok: boolean; mock?: boolean }> }).publishSite();
  }
  return {
    externalId: detail.id,
    externalUrl: detail.link ?? null,
    mock: detail.mock === true || mock,
    siteName: site.name,
  };
}

export async function pushProgrammaticPages(args: {
  userId: string;
  workspaceId: string;
  projectId: string;
  pageIds: string[];
  actor?: "user" | "system";
  /** Explicit destination applied to every page (overrides page/template). */
  explicitDest?: { target?: string; siteId?: string; collectionId?: string; webflowPublish?: boolean };
}): Promise<PushActionResult> {
  const result: PushActionResult = { changed: [], blocked: [], pushes: [] };
  const webflowPublish = args.explicitDest?.webflowPublish === true;

  const pages = await prisma.programmaticPage.findMany({
    where: { id: { in: args.pageIds }, projectId: args.projectId },
    include: { template: true },
  });
  const byId = new Map(pages.map((p) => [p.id, p as unknown as PageWithTemplate]));
  for (const id of args.pageIds) {
    const page = byId.get(id);
    if (!page) {
      result.blocked.push({ id, url: "", reasons: ["Page not found"] });
      continue;
    }
    const dest = resolveDestination({
      explicit: args.explicitDest ?? null,
      page: {
        publishTarget: page.publishTarget,
        targetSiteId: page.targetSiteId,
        webflowCollectionId: page.webflowCollectionId,
      },
      template: {
        defaultPublishTarget: page.template.defaultPublishTarget,
        defaultTargetSiteId: page.template.defaultTargetSiteId,
        defaultWebflowCollectionId: page.template.defaultWebflowCollectionId,
      },
    });

    if (dest.kind === "none") {
      result.blocked.push({ id, url: page.url, reasons: ["No publish target selected (page and template both unset)"] });
      continue;
    }

    // "csv" = the existing internal publish path (no remote).
    if (dest.kind === "csv") {
      const csvRes = await publishProgrammaticPages({
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        pageIds: [id],
        actor: args.actor ?? "user",
      });
      result.changed.push(...csvRes.changed);
      result.blocked.push(...csvRes.blocked);
      continue;
    }

    // External target: resolve + validate the site.
    if (!dest.siteId) {
      result.blocked.push({ id, url: page.url, reasons: [`${dest.kind} push needs a target site`] });
      continue;
    }
    const site = await ownedSite(args.userId, args.projectId, dest.siteId);
    if (!site) {
      result.blocked.push({ id, url: page.url, reasons: ["Target site not found or not accessible"] });
      continue;
    }
    if (!(TARGET_SOURCE_TYPES[dest.kind] ?? []).includes(site.sourceType)) {
      result.blocked.push({
        id,
        url: page.url,
        reasons: [`Site "${site.name}" is a ${site.sourceType} site — cannot publish to ${dest.kind}`],
      });
      continue;
    }
    if (dest.kind === "webflow" && !dest.collectionId) {
      result.blocked.push({ id, url: page.url, reasons: ["Webflow push needs a CMS collection id"] });
      continue;
    }

    // Quality gates — identical to the internal publish path.
    const dupRate = await templateDuplicateRate(page.template.id);
    const pc = pageContentOf(page.content);
    const gates = evaluateGates({
      flags: Array.isArray(page.qualityFlags) ? (page.qualityFlags as string[]) : [],
      missingVariables: pc.missingVariables,
      wordCount: pc.wordCount,
      minWordCount: page.template.minWordCount,
      templateDuplicateRate: dupRate,
      duplicateRateCap: page.template.duplicateRateCap,
      checkDuplicateRate: true,
    });
    if (!gates.pass) {
      result.blocked.push({ id, url: page.url, reasons: gates.reasons });
      continue;
    }

    // Idempotency: same target + site + stored external id → update in place.
    // Published anywhere else → blocked (no silent duplicates).
    const classification = classifyPush({
      status: page.status,
      publishTarget: page.publishTarget,
      targetSiteId: page.targetSiteId,
      targetCollectionId: page.webflowCollectionId,
      externalId: page.externalId,
      dest,
    });
    if (classification.blockedReason) {
      result.blocked.push({ id, url: page.url, reasons: [classification.blockedReason] });
      continue;
    }
    const sameTarget = classification.mode === "update";

    // Push.
    let remote: { externalId: string | null; externalUrl: string | null; mock: boolean; siteName: string };
    try {
      remote = await pushToConnector({
        page,
        dest,
        site,
        updateMode: sameTarget,
        webflowPublish,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Push failed";
      result.blocked.push({ id, url: page.url, reasons: [reason] });
      await emitPushFailure({
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        pageId: page.id,
        url: page.url,
        target: dest.kind,
        reason,
      });
      continue;
    }

    await prisma.programmaticPage.update({
      where: { id: page.id },
      data: {
        status: "published",
        noindex: false,
        publishTarget: dest.kind,
        targetSiteId: dest.siteId,
        webflowCollectionId: dest.collectionId,
        externalId: remote.externalId,
        externalUrl: remote.externalUrl,
        publishedUrl: remote.externalUrl ?? page.canonical ?? page.url,
        publishedAt: new Date(),
      },
    });
    result.changed.push(page.id);
    result.pushes.push({
      id: page.id,
      url: page.url,
      target: dest.kind,
      siteName: remote.siteName,
      externalId: remote.externalId,
      externalUrl: remote.externalUrl,
      updated: sameTarget,
      mock: remote.mock,
    });
    await auditProgrammatic(
      args.workspaceId,
      args.projectId,
      "programmatic_page_pushed",
      `Pushed ${page.url} → ${dest.kind} site "${remote.siteName}"${sameTarget ? " (updated in place)" : ""}: external id ${remote.externalId ?? "—"}, url ${remote.externalUrl ?? page.canonical ?? page.url}${remote.mock ? " (mock)" : ""}`,
      args.actor ?? "user",
    ).catch(() => {});
  }

  if (result.changed.length > 0) {
    await regenerateSitemap(args.projectId).catch(() => {});
  }
  return result;
}

/** Persist a per-page publish-target override (the Pages-tab selector). */
export async function setProgrammaticPageTargets(args: {
  workspaceId: string;
  projectId: string;
  pageIds: string[];
  target: string;
  siteId?: string | null;
  collectionId?: string | null;
  actor?: "user" | "system";
}): Promise<{ changed: string[] }> {
  if (!isPublishTarget(args.target)) throw new Error(`Unknown publish target "${args.target}"`);
  // Site/collection default to the template's — the per-page selector only
  // overrides the target kind; explicit values still win.
  const pages = await prisma.programmaticPage.findMany({
    where: { id: { in: args.pageIds }, projectId: args.projectId },
    select: {
      id: true,
      template: { select: { defaultTargetSiteId: true, defaultWebflowCollectionId: true } },
    },
  });
  for (const p of pages) {
    const siteId = args.siteId ?? p.template.defaultTargetSiteId ?? null;
    const collectionId = args.collectionId ?? p.template.defaultWebflowCollectionId ?? null;
    if (args.target !== "none" && args.target !== "csv" && !siteId) {
      throw new Error(`${args.target} target needs a site`);
    }
    await prisma.programmaticPage.update({
      where: { id: p.id },
      data: {
        publishTarget: args.target,
        targetSiteId: siteId,
        webflowCollectionId: collectionId,
      },
    });
  }
  if (pages.length > 0) {
    await auditProgrammatic(
      args.workspaceId,
      args.projectId,
      "programmatic_page_pushed",
      `Set publish target → ${args.target} on ${pages.length} programmatic page(s)`,
      args.actor ?? "user",
    ).catch(() => {});
  }
  return { changed: pages.map((p) => p.id) };
}
