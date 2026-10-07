// ShapesOS — Phase 19B (WS=panel): what a page walk walks, and what the
// browser may load while it does.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Three targets:
//   url           any public http(s) page — every request (navigation,
//                 redirect hop, subresource, websocket) passes the SSRF guard
//                 (lib/safe-url.ts assertSafeUrl, injected as checkUrl);
//   landing_page  a GrapesJS landing page (page_drafts html + css), served to
//                 the browser from the database at a reserved ".invalid"
//                 origin — nothing is fetched over the network for it;
//   site          a SiteBuilder site's working copy (index.html and its
//                 relative files), served the same way.
// Analytics / tracking hosts are always aborted (lib/panel/tracker.ts), so a
// synthetic visit never lands in anyone's real metrics. The prototype's
// "allowedDomains" list (and its blanket localhost / file: allowance) is
// replaced by the SSRF guard: private, loopback and metadata addresses are
// refused for url targets.

import { z } from "zod";
import { isAnalyticsHost } from "./tracker";

export const PanelTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().trim().min(1).max(2000) }),
  z.object({ kind: z.literal("landing_page"), pageDraftId: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal("site"), siteId: z.string().trim().min(1).max(64), path: z.string().trim().max(500).optional() }),
]);
export type PanelTarget = z.infer<typeof PanelTargetSchema>;

/** Reserved origins (RFC 2606 ".invalid": never resolvable) for pages served from the database. */
export const LANDING_PAGE_ORIGIN = "https://landing-page.rehearsal.invalid";
export const SITE_ORIGIN = "https://site.rehearsal.invalid";

export interface ServedFile {
  body: string;
  contentType: string;
}

/** A page (and its files) served to the browser from our own storage. */
export interface ServedSite {
  origin: string;
  /** Path the walk opens, e.g. "/index.html". */
  entryPath: string;
  files: Record<string, ServedFile>;
}

export function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml",
  };
  return map[ext] ?? "text/plain; charset=utf-8";
}

/** A landing page's stored html + css as one served document. */
export function landingPageSite(draft: { html: string | null; css: string | null; name: string }): ServedSite {
  const body = draft.html ?? "";
  const hasDoc = /<html[\s>]/i.test(body);
  const css = draft.css ? `<style>${draft.css}</style>` : "";
  const doc = hasDoc
    ? body.replace(/<\/head>/i, `${css}</head>`)
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(draft.name)}</title>${css}</head><body>${body}</body></html>`;
  return { origin: LANDING_PAGE_ORIGIN, entryPath: "/index.html", files: { "/index.html": { body: doc, contentType: contentTypeFor("index.html") } } };
}

/** A SiteBuilder working copy as a served site (text files only, as the working copy is). */
export function siteFilesSite(files: ReadonlyArray<{ path: string; content: string }>, entry?: string): ServedSite {
  const out: Record<string, ServedFile> = {};
  for (const f of files) {
    const p = f.path.startsWith("/") ? f.path : `/${f.path}`;
    out[p] = { body: f.content, contentType: contentTypeFor(p) };
  }
  const wanted = entry ? (entry.startsWith("/") ? entry : `/${entry}`) : "/index.html";
  const entryPath = out[wanted] ? wanted : Object.keys(out).find((p) => /\.html?$/i.test(p)) ?? wanted;
  return { origin: SITE_ORIGIN, entryPath, files: out };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * The response for a request to the served origin (null when the URL is not
 * on it). "/" maps to the entry path, a directory to its index.html; unknown
 * paths are a plain 404 (honest: the persona sees a missing page).
 */
export function servedResponse(site: ServedSite, rawUrl: string): { status: number; contentType: string; body: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.origin !== site.origin) return null;
  let p = decodeURIComponent(u.pathname);
  if (p === "/" || p === "") p = site.entryPath;
  else if (p.endsWith("/")) p = `${p}index.html`;
  const f = site.files[p];
  if (!f) return { status: 404, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Not found</title><h1>Not found</h1>" };
  return { status: 200, contentType: f.contentType, body: f.body };
}

/**
 * The per-request guard for a walk: analytics never load; the served origin
 * (when any) loads from storage; everything else must pass checkUrl (the SSRF
 * guard). Cached per origin for a minute, like the agent browser tools.
 */
export function makePanelRequestGuard(opts: {
  checkUrl: (url: string) => Promise<unknown>;
  servedOrigin?: string | null;
  cacheMs?: number;
}): (url: string) => Promise<boolean> {
  const cache = new Map<string, { ok: boolean; at: number }>();
  const ttl = opts.cacheMs ?? 60_000;
  return async (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (opts.servedOrigin && u.origin === opts.servedOrigin) return true;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isAnalyticsHost(u.hostname)) return false;
    const hit = cache.get(u.origin);
    if (hit && Date.now() - hit.at < ttl) return hit.ok;
    const ok = await opts.checkUrl(raw).then(
      () => true,
      () => false,
    );
    cache.set(u.origin, { ok, at: Date.now() });
    return ok;
  };
}

/** Short label for a target (UI and tool summaries). */
export function targetLabel(t: PanelTarget, names: { pageDraft?: string | null; site?: string | null } = {}): string {
  if (t.kind === "url") return t.url;
  if (t.kind === "landing_page") return names.pageDraft ? `Landing page: ${names.pageDraft}` : "Landing page";
  return names.site ? `Site: ${names.site}${t.path ? ` ${t.path}` : ""}` : `Site${t.path ? ` ${t.path}` : ""}`;
}
