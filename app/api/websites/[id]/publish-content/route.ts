// Marketr — publish a built landing page to WordPress / Webflow (milestone 8).
// POST /api/websites/[id]/publish-content
//   { projectId, targetSiteId, title?, slug?, status?, collectionId?, webflowPublish? }
//   → { ok, item, published?, mock }
//
// Reads the source site's working copy (index.html, or the first .html file)
// and pushes it to the target content site:
//   - WordPress: creates/updates a page (kind "page") with the HTML as content.
//   - Webflow: creates a CMS item in the chosen collection with fieldData
//     { name, slug, "page-html": <html> }, then optionally publishes the site.
//
// Honest scope: WP gets a page whose content IS the generated HTML; Webflow
// gets a CMS item holding the HTML (works with a collection + embed/HTML
// field — page designs themselves are not API-editable). Nothing scheduled,
// nothing automatic.

import { requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import {
  collectAllFiles,
  getContentConnector,
  getSiteIdeProvider,
  logSiteChange,
  ownedSite,
  siteIsMock,
} from "@/lib/connectors/source";
import type { OwnedSite } from "@/lib/connectors/source";

interface PublishBody {
  projectId?: string;
  targetSiteId?: string;
  title?: string;
  slug?: string;
  status?: string;
  collectionId?: string;
  webflowPublish?: boolean;
}

async function readLandingHtml(site: OwnedSite) {
  const provider = await getSiteIdeProvider(site);
  const paths = await collectAllFiles(provider);
  const html = paths.filter((p) => /\.html?$/i.test(p));
  const pick = html.find((p) => /(^|\/)index\.html?$/i.test(p)) ?? html[0];
  if (!pick) throw new Error("Source site has no .html file to publish");
  const { content } = await provider.readFile(pick);
  return { file: pick, html: content };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody<PublishBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const source = await ownedSite(user.id, body.projectId, id);
  if (!source) return Response.json({ error: "Source site not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, source.projectId, "editor"))) return forbidden();
  const target = await ownedSite(user.id, body.projectId, body.targetSiteId);
  if (!target) return Response.json({ error: "Target site not found" }, { status: 404 });
  if (target.sourceType !== "wordpress" && target.sourceType !== "webflow")
    return Response.json({ error: "Target must be a WordPress or Webflow site" }, { status: 400 });

  const status = body.status === "publish" ? "publish" : "draft";
  const title = (body.title ?? "").trim().slice(0, 200) || `${source.name} landing page`;
  const slug =
    (body.slug ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    undefined;

  try {
    const { file, html } = await readLandingHtml(source);
    if (!html.trim()) throw new Error(`No HTML content found in ${file}`);

    const connector = getContentConnector(target);
    const mock = siteIsMock(target);

    if (target.sourceType === "wordpress") {
      const item = await connector.saveContent("page", { title, slug, content: html, status });
      await logSiteChange({
        projectId: target.projectId,
        siteId: target.id,
        filePath: `page:${item.slug || item.id}`,
        actor: "user",
        action: "save",
        summary: `Published landing page from "${source.name}" to WordPress page "${title.slice(0, 100)}" (${status})${mock ? " (mock)" : ""}`,
      });
      return Response.json({ ok: true, item, mock });
    }

    // Webflow
    const collectionId = (body.collectionId ?? "").trim();
    if (!collectionId)
      return Response.json({ error: "collectionId is required for Webflow" }, { status: 400 });
    const fieldData = JSON.stringify({ name: title, slug: slug ?? "", "page-html": html }, null, 2);
    const item = await connector.saveContent(
      "item",
      { title, slug, content: fieldData, status, collectionId },
      { collectionId },
    );
    let published: boolean | undefined;
    if (body.webflowPublish && "publishSite" in connector) {
      const r = await (
        connector as { publishSite(): Promise<{ ok: boolean; mock?: boolean }> }
      ).publishSite();
      published = r.ok;
    }
    await logSiteChange({
      projectId: target.projectId,
      siteId: target.id,
      filePath: `item:${item.slug || item.id}`,
      actor: "user",
      action: "save",
      summary: `Published landing page from "${source.name}" to Webflow CMS item "${title.slice(0, 100)}" (${status})${published ? ", site published" : ""}${mock ? " (mock)" : ""}`,
    });
    return Response.json({ ok: true, item, published, mock });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Publish failed" },
      { status: 502 },
    );
  }
}
