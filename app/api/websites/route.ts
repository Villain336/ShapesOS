// Marketr — site management API (milestone 7).
// GET  /api/websites?projectId=…                    → { sites } (no secrets)
// POST /api/websites { projectId, name, sourceType, github?, sftpConnectionId?, initialFiles? }
//      sourceType: "github" | "sftp" | "file"
//      github: { token, owner, repo, branch?, demo? } — demo:true serves the
//        labeled mock repo (GitHub is unreachable from some environments).
//      sftp: { sftpConnectionId } — reuses a milestone-6 connection.
//      file: managed local working copy (upload/AI-generated).
//      initialFiles?: [{ path, content }] — written into the working copy.
//
// A Site is the unit the builder creates and the IDE edits. Every site gets a
// local working copy; github/sftp sites sync/deploy against their remote.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { ownedProject, readJsonBody } from "@/lib/sitefiles/api";
import { sanitizePath } from "@/lib/sitefiles/paths";
import { assertSafeUrl } from "@/lib/safe-url";
import {
  encryptSiteConfig,
  getSiteIdeProvider,
  ownedSite,
  publicSite,
} from "@/lib/connectors/source";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const sites = await prisma.site.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    include: { sftpConnection: true },
  });
  return Response.json({ sites: sites.map(publicSite) });
}

interface InitialFile {
  path?: string;
  content?: string;
}

interface CreateBody {
  projectId?: string;
  name?: string;
  sourceType?: string;
  github?: {
    token?: string;
    owner?: string;
    repo?: string;
    branch?: string;
    demo?: boolean;
  };
  wordpress?: {
    baseUrl?: string;
    username?: string;
    appPassword?: string;
    demo?: boolean;
  };
  webflow?: {
    token?: string;
    siteId?: string;
    demo?: boolean;
  };
  sftpConnectionId?: string;
  initialFiles?: InitialFile[];
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJsonBody<CreateBody>(req);
  if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const name = (body.name ?? "").trim().slice(0, 80) || "Untitled site";
  const sourceType =
    body.sourceType === "github" ||
    body.sourceType === "sftp" ||
    body.sourceType === "wordpress" ||
    body.sourceType === "webflow"
      ? body.sourceType
      : "file";

  // Milestone 11: connecting a source that stores credentials (GitHub token,
  // WP app password, Webflow token) is admin+. Plain file sites are editor+.
  const storesCredentials =
    (sourceType === "github" && body.github?.demo !== true) ||
    (sourceType === "wordpress" && body.wordpress?.demo !== true) ||
    (sourceType === "webflow" && body.webflow?.demo !== true);
  const minRole = storesCredentials ? "admin" : "editor";
  if (!(await requireProjectRole(user.id, project.id, minRole))) return forbidden();

  let configEnc = encryptSiteConfig({});
  let sftpConnectionId: string | null = null;

  if (sourceType === "github") {
    const g = body.github ?? {};
    const demo = g.demo === true;
    const owner = (g.owner ?? "").trim();
    const repo = (g.repo ?? "").trim();
    const token = (g.token ?? "").trim();
    const branch = (g.branch ?? "").trim() || "main";
    if (!demo) {
      if (!owner || !/^[A-Za-z0-9_.-]+$/.test(owner))
        return Response.json({ error: "GitHub owner is required" }, { status: 400 });
      if (!repo || !/^[A-Za-z0-9_.-]+$/.test(repo))
        return Response.json({ error: "GitHub repo is required" }, { status: 400 });
      if (!token) return Response.json({ error: "GitHub token is required" }, { status: 400 });
    }
    configEnc = encryptSiteConfig({ token, owner, repo, branch, demo });
  } else if (sourceType === "wordpress") {
    const w = body.wordpress ?? {};
    const demo = w.demo === true;
    let baseUrl = (w.baseUrl ?? "").trim().replace(/\/+$/, "");
    const username = (w.username ?? "").trim();
    const appPassword = (w.appPassword ?? "").replace(/\s+/g, "");
    if (!demo) {
      // Day-1 hardening (M6): SSRF-validate the baseUrl before storing it —
      // blocks loopback/private/link-local/metadata destinations.
      try {
        baseUrl = await assertSafeUrl(baseUrl);
      } catch {
        return Response.json(
          { error: "WordPress site URL is invalid or not allowed." },
          { status: 400 },
        );
      }
      if (!username) return Response.json({ error: "WordPress username is required" }, { status: 400 });
      if (!appPassword) return Response.json({ error: "Application password is required" }, { status: 400 });
    }
    configEnc = encryptSiteConfig({ baseUrl, username, appPassword, demo });
  } else if (sourceType === "webflow") {
    const w = body.webflow ?? {};
    const demo = w.demo === true;
    const token = (w.token ?? "").trim();
    const siteId = (w.siteId ?? "").trim();
    if (!demo && !token)
      return Response.json({ error: "Webflow API token is required" }, { status: 400 });
    configEnc = encryptSiteConfig({ token, siteId, demo });
  } else if (sourceType === "sftp") {
    const connId = (body.sftpConnectionId ?? "").trim();
    if (!connId) return Response.json({ error: "sftpConnectionId is required" }, { status: 400 });
    const conn = await prisma.siteConnection.findFirst({
      where: { id: connId, projectId: project.id },
    });
    if (!conn) return Response.json({ error: "SFTP connection not found" }, { status: 404 });
    sftpConnectionId = conn.id;
  }

  const site = await prisma.site.create({
    data: { projectId: project.id, name, sourceType, configEnc, sftpConnectionId },
    include: { sftpConnection: true },
  });

  // Milestone 11: credential lifecycle is audit-logged (no secret material).
  if (storesCredentials) {
    await prisma.fileChangeLog.create({
      data: {
        projectId: project.id,
        siteId: site.id,
        filePath: "(connection)",
        actor: "user",
        action: "credential_created",
        summary: `${user.email ?? user.id} connected ${sourceType} credentials for site "${name}"`,
        approvedBy: user.id,
      },
    });
  }

  // Seed the working copy (validates paths through the same sanitizer the IDE uses).
  const provider = await getSiteIdeProvider({ ...site, sftpConnection: site.sftpConnection });
  for (const f of body.initialFiles ?? []) {
    try {
      const p = sanitizePath(f.path);
      if (typeof f.content === "string" && f.content.length <= 2_000_000) {
        await provider.writeFile(p, f.content);
      }
    } catch {
      /* skip invalid seed files */
    }
  }

  const fresh = await ownedSite(user.id, project.id, site.id);
  return Response.json({ site: publicSite(fresh!) }, { status: 201 });
}
