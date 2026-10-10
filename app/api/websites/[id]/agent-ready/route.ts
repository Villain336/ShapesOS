// ShapesOS — Phase 21A (WS=agentweb): agent readiness for a SiteBuilder site.
// GET  /api/websites/[id]/agent-ready?projectId=…[&search=yes|no&input=…&train=…]  → the readiness score now, what the
//      agent-ready draft would change and the score after it (no writes)
// POST /api/websites/[id]/agent-ready { projectId, policy? } → save it as a DRAFT
//      revision (lib/agentweb/site/agent-ready-draft.ts). Never writes the live working
//      copy: a person applies the draft in Site drafts, then deploys. `policy` is the
//      tenant's AI-usage choice { search, input, train } written into robots.txt.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/sitefiles/api";
import { ownedSite } from "@/lib/connectors/source";
import { errorResponse } from "@/lib/api/errors";
import { AgentReadyError, createAgentReadyDraft, previewAgentReady, type AgentReadyPreview } from "@/lib/agentweb/site/agent-ready-draft";
import type { AiPolicy } from "@/lib/agentweb/site/robots-ai";
import type { ReadinessReport } from "@/lib/agentweb/site/readiness";

export const dynamic = "force-dynamic";

function failure(err: unknown) {
  if (err instanceof AgentReadyError) return Response.json({ error: err.message, code: err.code }, { status: 400 });
  return errorResponse(err, "agent-ready");
}

const slim = (r: ReadinessReport) => ({
  score: r.score,
  checks: r.checks.map((c) => ({ id: c.id, weight: c.weight, earned: c.earned, status: c.status, detail: c.detail })),
  fixes: r.fixes.map((f) => ({ id: f.id, points: f.points })),
  tasks: r.tasks.map((t) => ({ kind: t.kind, can: t.can, channel: t.channel, via: t.via, note: t.note })),
});

const view = (p: AgentReadyPreview) => ({
  origin: p.origin,
  policy: p.policy,
  currentPolicy: p.currentPolicy,
  before: slim(p.before),
  after: slim(p.after),
  changes: p.changes,
  kept: p.kept,
});

function parsePolicy(v: unknown): AiPolicy | undefined | null {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") return null;
  const { search, input, train } = v as Record<string, unknown>;
  return typeof search === "boolean" && typeof input === "boolean" && typeof train === "boolean" ? { search, input, train } : null;
}

const yesNo = (v: string | null): boolean | undefined => (v === "yes" ? true : v === "no" ? false : undefined);

async function resolve(userId: string, projectId: unknown, siteId: string, minRole: "viewer" | "editor") {
  const site = await ownedSite(userId, projectId, siteId);
  if (!site) return { error: Response.json({ error: "Site not found" }, { status: 404 }) };
  if (!(await requireProjectRole(userId, site.projectId, minRole))) return { error: forbidden() };
  const project = await prisma.project.findUnique({ where: { id: site.projectId }, select: { workspaceId: true } });
  if (!project) return { error: Response.json({ error: "Site not found" }, { status: 404 }) };
  return { site, workspaceId: project.workspaceId };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const got = await resolve(user.id, req.nextUrl.searchParams.get("projectId"), id, "viewer");
  if ("error" in got) return got.error;
  const q = req.nextUrl.searchParams;
  const policy = q.has("search") || q.has("input") || q.has("train") ? parsePolicy({ search: yesNo(q.get("search")), input: yesNo(q.get("input")), train: yesNo(q.get("train")) }) : undefined;
  if (policy === null) return Response.json({ error: "search, input and train must each be yes or no" }, { status: 400 });
  try {
    const preview = await previewAgentReady({ workspaceId: got.workspaceId, projectId: got.site.projectId, siteId: got.site.id, policy });
    return Response.json({ ok: true, ...view(preview) });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; policy?: unknown }>(req);
  const got = await resolve(user.id, body?.projectId, id, "editor");
  if ("error" in got) return got.error;
  const policy = parsePolicy(body?.policy);
  if (policy === null) return Response.json({ error: "policy must be { search, input, train } booleans" }, { status: 400 });
  try {
    const res = await createAgentReadyDraft({ workspaceId: got.workspaceId, projectId: got.site.projectId, siteId: got.site.id, policy, createdBy: user.id });
    return Response.json({
      ok: true,
      saved: !!res.revision,
      revision: res.revision ? { id: res.revision.id, number: res.revision.number } : null,
      ...view(res.preview),
    });
  } catch (err) {
    return failure(err);
  }
}
