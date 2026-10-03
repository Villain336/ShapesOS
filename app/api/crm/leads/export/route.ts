// Marketr — CRM CSV export (viewer+; same filters as the list endpoint).
// GET /api/crm/leads/export?pipelineId=&stage=&...

import { csvCell } from "@/lib/csv";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";

// Lead fields come from the PUBLIC lead form: formula-neutralized via the
// shared encoder (lib/csv.ts).
const esc = (v: string | number | null | undefined) => csvCell(v);

export interface ExportableLead {
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  source: string;
  sourceDetail: string | null;
  stage: string;
  score: number;
  valueCents: number | null;
  ownerName: string | null;
  createdAt: Date;
  pipeline: { name: string };
}

export function leadsToCsv(leads: ExportableLead[]): string {
  const header = "name,email,phone,company,title,source,source_detail,stage,score,value,pipeline,owner,created_at";
  const lines = leads.map((l) =>
    [
      esc(l.name), esc(l.email), esc(l.phone), esc(l.company), esc(l.title),
      esc(l.source), esc(l.sourceDetail), esc(l.stage), l.score,
      l.valueCents == null ? "" : (l.valueCents / 100).toFixed(2),
      esc(l.pipeline.name), esc(l.ownerName), l.createdAt.toISOString(),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const where: Prisma.LeadWhereInput = { workspaceId: workspace.id };
  const pipelineId = sp.get("pipelineId");
  if (pipelineId) where.pipelineId = pipelineId;
  const stage = sp.get("stage");
  if (stage) where.stage = stage;
  const source = sp.get("source");
  if (source) where.source = source as never;

  const leads = await prisma.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 10000,
    include: { pipeline: { select: { name: true } } },
  });

  return new Response(leadsToCsv(leads), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="marketr-leads-${Date.now()}.csv"`,
    },
  });
}
