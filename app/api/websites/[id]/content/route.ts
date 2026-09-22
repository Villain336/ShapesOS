// Marketr — content-source operations API (milestone 8).
// POST /api/websites/[id]/content { projectId, action, ... }
//   action "test"                                    → { ok, info, mock }
//   action "list",   kind "page"|"post"|"collection" → { items }
//   action "get",    kind, id, collectionId?         → { item }
//   action "save",   kind, id?, title, slug?, content, status, collectionId?
//                                                   → { item } (creates or updates)
//   action "delete", kind, id, collectionId?        → { ok }
//   WordPress extras:
//     action "media-list"                           → { media }
//     action "media-upload" (multipart: file)       → { id, url }
//   Webflow extras:
//     action "sites"                                → { sites }
//     action "items", collectionId                  → { items }
//     action "publish"                              → { ok, mock }
//
// All auth-gated + project-ownership checked. Secrets stay server-side.
// Live WordPress/Webflow APIs are unreachable from some environments — use
// the demo checkbox when connecting for the labeled mock flow.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  getContentConnector,
  logSiteChange,
  ownedSite,
  siteIsMock,
} from "@/lib/connectors/source";
import type { ContentKind } from "@/lib/connectors/types";
import { MockWordPressConnector } from "@/lib/connectors/mock-wordpress";
import { MockWebflowConnector } from "@/lib/connectors/mock-webflow";
import { UnsafeUrlError } from "@/lib/safe-url";

interface ContentBody {
  projectId?: string;
  action?: string;
  kind?: string;
  id?: string;
  title?: string;
  slug?: string;
  content?: string;
  status?: string;
  collectionId?: string;
  siteId?: string;
}

function validKind(kind: unknown): kind is ContentKind {
  return kind === "page" || kind === "post" || kind === "collection" || kind === "item";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // media-upload arrives as multipart.
  const isMultipart = (req.headers.get("content-type") ?? "").includes("multipart/form-data");
  let body: ContentBody | null = null;
  let uploadFile: File | null = null;
  if (isMultipart) {
    const fd = await req.formData();
    body = {
      projectId: String(fd.get("projectId") ?? ""),
      action: String(fd.get("action") ?? ""),
    };
    const f = fd.get("file");
    if (f instanceof File) uploadFile = f;
  } else {
    body = await readJsonBody<ContentBody>(req);
  }
  if (!body) return Response.json({ error: "Invalid request" }, { status: 400 });

  const site = await ownedSite(user.id, body.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, site.projectId, "editor"))) return forbidden();
  if (site.sourceType !== "wordpress" && site.sourceType !== "webflow")
    return Response.json({ error: "Not a content source" }, { status: 400 });

  const mock = siteIsMock(site);
  const action = body.action ?? "";

  try {
    const connector = await getContentConnector(site);

    if (action === "test") {
      const r = await connector.test();
      return Response.json({ ok: r.ok, info: r.info, mock });
    }

    if (action === "list") {
      if (!validKind(body.kind)) return Response.json({ error: "kind is required" }, { status: 400 });
      const items = await connector.listContent(body.kind);
      return Response.json({ items, mock });
    }

    if (action === "get") {
      if (!validKind(body.kind) || !body.id)
        return Response.json({ error: "kind and id are required" }, { status: 400 });
      const item = await connector.getContent(body.kind, body.id, {
        collectionId: body.collectionId,
      });
      return Response.json({ item, mock });
    }

    if (action === "save") {
      if (!validKind(body.kind)) return Response.json({ error: "kind is required" }, { status: 400 });
      const title = (body.title ?? "").trim().slice(0, 200) || "(untitled)";
      const status = body.status === "publish" ? "publish" : "draft";
      const item = await connector.saveContent(
        body.kind,
        {
          id: body.id || undefined,
          title,
          slug: body.slug?.trim() || undefined,
          content: body.content ?? "",
          status,
          collectionId: body.collectionId,
        },
        { collectionId: body.collectionId },
      );
      await logSiteChange({
        projectId: site.projectId,
        siteId: site.id,
        filePath: `${body.kind}:${item.slug || item.id}`,
        actor: "user",
        action: "save",
        summary: `${body.id ? "Updated" : "Created"} ${body.kind} "${title.slice(0, 120)}" on ${site.sourceType}${mock ? " (mock)" : ""}`,
      });
      return Response.json({ item, mock });
    }

    if (action === "delete") {
      if (!validKind(body.kind) || !body.id)
        return Response.json({ error: "kind and id are required" }, { status: 400 });
      await connector.deleteContent(body.kind, body.id, { collectionId: body.collectionId });
      await logSiteChange({
        projectId: site.projectId,
        siteId: site.id,
        filePath: `${body.kind}:${body.id}`,
        actor: "user",
        action: "save",
        summary: `Deleted ${body.kind} ${body.id} on ${site.sourceType}${mock ? " (mock)" : ""}`,
      });
      return Response.json({ ok: true, mock });
    }

    if (action === "media-list") {
      if (connector instanceof MockWordPressConnector || "listMedia" in connector) {
        const media = await (
          connector as { listMedia(): Promise<unknown[]> }
        ).listMedia();
        return Response.json({ media, mock });
      }
      return Response.json({ error: "Media is WordPress-only" }, { status: 400 });
    }

    if (action === "media-upload") {
      if (!uploadFile) return Response.json({ error: "file is required" }, { status: 400 });
      if (!("uploadMedia" in connector))
        return Response.json({ error: "Media upload is WordPress-only" }, { status: 400 });
      const bytes = new Uint8Array(await uploadFile.arrayBuffer());
      if (bytes.length > 25_000_000)
        return Response.json({ error: "File too large (25 MB max)" }, { status: 400 });
      const r = await (
        connector as {
          uploadMedia(a: { filename: string; bytes: Uint8Array; mime: string }): Promise<{ id: string; url: string | null }>;
        }
      ).uploadMedia({ filename: uploadFile.name, bytes, mime: uploadFile.type });
      return Response.json({ ...r, mock });
    }

    if (action === "sites") {
      if (!("listSites" in connector))
        return Response.json({ error: "Sites listing is Webflow-only" }, { status: 400 });
      const sites = await (connector as { listSites(): Promise<unknown[]> }).listSites();
      return Response.json({ sites, mock });
    }

    if (action === "items") {
      if (!body.collectionId)
        return Response.json({ error: "collectionId is required" }, { status: 400 });
      if (!("listItems" in connector))
        return Response.json({ error: "Items are Webflow-only" }, { status: 400 });
      const items = await (
        connector as { listItems(c: string): Promise<unknown[]> }
      ).listItems(body.collectionId);
      return Response.json({ items, mock });
    }

    if (action === "publish") {
      if (!("publishSite" in connector))
        return Response.json({ error: "Publish is Webflow-only" }, { status: 400 });
      const r = await (
        connector as { publishSite(): Promise<{ ok: boolean; mock?: boolean }> }
      ).publishSite();
      await logSiteChange({
        projectId: site.projectId,
        siteId: site.id,
        filePath: "webflow:publish",
        actor: "user",
        action: "save",
        summary: `Published Webflow site${mock || r.mock ? " (mock)" : ""}`,
      });
      return Response.json({ ok: r.ok, mock: mock || r.mock });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (err) {
    // Day-1 (M6): an SSRF block is a bad stored config → 400, not a 502.
    if (err instanceof UnsafeUrlError) {
      return Response.json({ error: `Unsafe WordPress URL: ${err.message}` }, { status: 400 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Content operation failed" },
      { status: 502 },
    );
  }
}
