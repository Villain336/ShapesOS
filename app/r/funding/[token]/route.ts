// Marketr — Funding/VC slice 3: public data-room share route.
// GET /r/funding/[token] — serves a shared doc (or the whole room) to an
//        anonymous viewer. Access rules are enforced at access time:
//        - unknown token / revoked / expired → 404 (revoked links look gone)
//        - allowlisted link without a matching ?email= → 403 + email form
//        - otherwise the VIEW IS LOGGED FIRST (who opened what, when), then
//          a minimal viewer page is returned. The file itself streams from
//          ?dl=1 inside the iframe (the iframe hit logs no second view).
//        - room links (docId = null) render an index page; ?v=<versionId>
//          serves one version (also logged).
// POST /r/funding/[token]/views/[viewId] — duration beacon: how long the
//        viewer kept the document open (optional).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import {
  resolveShareLink,
  viewerIdentityFor,
  type ShareAccessFailure,
} from "@/lib/funding/dataroom";
import { readFile } from "@/lib/filesystem/service";
import { buildDownloadHeaders } from "@/lib/filesystem/download";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

const PAGE_CSS = `
  body{font-family:Archivo,system-ui,-apple-system,sans-serif;background:#F3F3F1;color:#1a1a1a;margin:0;padding:32px 16px}
  .wrap{max-width:720px;margin:0 auto}
  .card{background:#fff;border:1px solid #e5e5e2;border-radius:12px;padding:24px}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:14px;color:#5E5E5B;margin:0 0 12px}
  .meta{font-size:12px;color:#8a8a86;margin-bottom:16px}
  a.btn{display:inline-block;background:#000;color:#fff;text-decoration:none;padding:10px 20px;border-radius:999px;font-size:14px;font-weight:600}
  input[type=email]{width:100%;padding:10px 12px;border:1px solid #d4d4d0;border-radius:8px;font-size:14px;margin:8px 0 16px;box-sizing:border-box}
  ul.doclist{list-style:none;margin:16px 0 0;padding:0}
  ul.doclist li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #eee}
  ul.doclist li:first-child{border-top:none}
  .doctitle{font-size:14px;font-weight:600}
  .docsub{font-size:12px;color:#8a8a86}
  iframe.viewer{width:100%;height:72vh;border:1px solid #e5e5e2;border-radius:12px;background:#fff}
`;

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><div class="wrap"><div class="card">${body}</div></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function gonePage(): Response {
  return page(
    "Link unavailable",
    `<h1>This link is unavailable</h1><p>It may have expired, been revoked, or never existed.</p>`,
    404,
  );
}

function emailGatePage(params: {
  failure: ShareAccessFailure;
  token: string;
  versionId: string | null;
}): Response {
  const { token, versionId } = params;
  const hidden = versionId
    ? `<input type="hidden" name="v" value="${esc(versionId)}">`
    : "";
  return page(
    "Enter your email",
    `<h1>Enter your email to view</h1>` +
      `<p>This data room was shared with specific people. Enter the email it was shared with.</p>` +
      `<form method="get" action="/r/funding/${esc(token)}">${hidden}` +
      `<input type="email" name="email" required placeholder="you@company.com" autocomplete="email">` +
      `<button class="btn" type="submit">View documents</button></form>`,
    403,
  );
}

function viewerHeaders(req: NextRequest): { ip: string | null; userAgent: string | null } {
  const fwd = req.headers.get("x-forwarded-for");
  return {
    ip: fwd ? fwd.split(",")[0].trim() : null,
    userAgent: req.headers.get("user-agent"),
  };
}

export async function GET(req: NextRequest, { params }: Params) {
  const store = new PrismaFundingStore(prisma);
  const { token } = await params;
  const url = new URL(req.url);
  const now = new Date();

  const link = await store.getShareLinkByToken(token, now);
  if (!link) return gonePage();

  const emailParam = url.searchParams.get("email");
  const access = resolveShareLink(
    {
      revoked: link.revoked,
      expiresAt: link.expiresAt,
      viewerEmails: link.viewerEmails,
    },
    { email: emailParam },
    now,
  );
  if (!access.ok) {
    if (
      access.failure === "link_revoked" ||
      access.failure === "link_expired"
    ) {
      return gonePage();
    }
    return emailGatePage({
      failure: access.failure,
      token,
      versionId: url.searchParams.get("v"),
    });
  }

  // Room link without a chosen version → index page (no view logged; views
  // are logged per document opened, "who opened what, when").
  if (!link.docId) {
    const versionId = url.searchParams.get("v");
    if (!versionId) {
      const docs = await store.listDocs(link.workspaceId);
      const emailQ = emailParam
        ? `&amp;email=${encodeURIComponent(emailParam)}`
        : "";
      const items = docs
        .map((d) => {
          const v = d.currentVersion;
          if (!v) return "";
          const size =
            v.sizeBytes >= 1024 * 1024
              ? `${(v.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
              : `${Math.max(1, Math.round(v.sizeBytes / 1024))} KB`;
          return `<li><div><div class="doctitle">${esc(d.title)}</div><div class="docsub">Version ${v.versionNumber} · ${esc(v.fileName)} · ${size}</div></div><a class="btn" href="/r/funding/${esc(token)}?v=${esc(v.id)}${emailQ}">Open</a></li>`;
        })
        .join("");
      return page(
        "Data room",
        `<h1>Data room</h1><p>Shared documents. Each open is logged for the sender.</p>${items ? `<ul class="doclist">${items}</ul>` : `<p>No documents yet.</p>`}`,
      );
    }
    const version = await store.getRoomVersion(link.workspaceId, versionId);
    if (!version) return gonePage();
    return serveVersion(req, store, {
      workspaceId: link.workspaceId,
      linkId: link.id,
      version,
      docTitle: version.document.title,
      token,
      email: emailParam,
      now,
    });
  }

  // Doc link: pinned version, or the current version at access time.
  const version = link.resolvedVersion;
  if (!version) return gonePage();
  return serveVersion(req, store, {
    workspaceId: link.workspaceId,
    linkId: link.id,
    version,
    docTitle: link.docTitle ?? "Document",
    token,
    email: emailParam,
    now,
  });
}

async function serveVersion(
  req: NextRequest,
  store: PrismaFundingStore,
  opts: {
    workspaceId: string;
    linkId: string;
    version: {
      id: string;
      workspaceFileId: string;
      fileName: string;
      mimeType: string | null;
      sizeBytes: number;
      versionNumber: number;
    };
    docTitle: string;
    token: string;
    email: string | null;
    now: Date;
  },
): Promise<Response> {
  const url = new URL(req.url);
  const { ip, userAgent } = viewerHeaders(req);

  // The iframe hit (?dl=1) streams bytes without logging a second view.
  if (!url.searchParams.has("dl")) {
    const view = await store.recordDocView(opts.workspaceId, {
      linkId: opts.linkId,
      docVersionId: opts.version.id,
      viewerIdentity: viewerIdentityFor({ email: opts.email, ip, userAgent }),
      userAgent,
    });
    const iframeSrc = `/r/funding/${encodeURIComponent(opts.token)}?dl=1${
      url.searchParams.get("v")
        ? `&v=${encodeURIComponent(url.searchParams.get("v")!)}`
        : ""
    }${opts.email ? `&email=${encodeURIComponent(opts.email)}` : ""}`;
    const beaconUrl = `/r/funding/${encodeURIComponent(opts.token)}/views/${encodeURIComponent(view.id)}`;
    const openedAt = Math.round(opts.now.getTime());
    return page(
      opts.docTitle,
      `<h1>${esc(opts.docTitle)}</h1>` +
        `<div class="meta">Version ${opts.version.versionNumber} · ${esc(opts.version.fileName)} · this view was logged for the sender</div>` +
        `<iframe class="viewer" src="${iframeSrc}" title="${esc(opts.docTitle)}"></iframe>` +
        `<script>(function(){var t0=${openedAt};function send(){var ms=Date.now()-t0;try{navigator.sendBeacon(${JSON.stringify(beaconUrl)},JSON.stringify({durationMs:ms}))}catch(e){}}window.addEventListener("pagehide",send);})();</script>`,
    );
  }

  const file = await readFile({
    workspaceId: opts.workspaceId,
    fileId: opts.version.workspaceFileId,
  });
  if (!file) return gonePage();
  const headers = buildDownloadHeaders(
    opts.version.mimeType ?? "application/octet-stream",
    opts.version.fileName,
  );
  return new Response(new Uint8Array(file.bytes), { headers });
}
