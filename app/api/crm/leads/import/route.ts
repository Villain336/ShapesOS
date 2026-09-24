// Marketr — CRM CSV import with dedup report.
// POST /api/crm/leads/import  → { pipelineId, csv } (editor+)
// Columns: name*, email, phone, company, title, source, sourceDetail, stage,
// value (dollars), ownerName. Returns { created, duplicates, errors }.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { dedupKeyFor, recomputeScore, logActivity } from "@/lib/crm/dedup";
import { parseStages, CLOSED_STAGES } from "@/lib/crm/stages";

const SOURCES = ["website_form", "phone", "referral", "import", "ad", "ooh", "direct_mail", "other"] as const;

const ImportSchema = z.object({
  pipelineId: z.string().min(1).max(64),
  csv: z.string().min(1).max(2_000_000), // 2MB cap
});

/** Minimal RFC-4180-ish CSV parse (quotes, commas, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const pipeline = await prisma.pipeline.findFirst({
    where: { id: parsed.data.pipelineId, workspaceId: workspace.id },
  });
  if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });
  const stages = parseStages(pipeline.stages);
  const stageIds = new Set(stages.map((s) => s.id));

  const rows = parseCsv(parsed.data.csv);
  if (rows.length < 2) {
    return Response.json({ error: "CSV needs a header row and at least one data row" }, { status: 400 });
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const nameIdx = idx("name");
  if (nameIdx === -1) {
    return Response.json({ error: 'CSV must have a "name" column' }, { status: 400 });
  }
  if (rows.length > 5001) {
    return Response.json({ error: "Import capped at 5000 rows" }, { status: 400 });
  }

  const actor = user.name ?? user.email ?? "Import";
  let created = 0;
  const duplicates: { row: number; name: string; existingId: string }[] = [];
  const errors: { row: number; error: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : "");
    const name = get(nameIdx);
    if (!name) { errors.push({ row: r + 1, error: "name required" }); continue; }

    const email = get(idx("email")) || null;
    const phone = get(idx("phone")) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: r + 1, error: "invalid email" }); continue;
    }
    const sourceRaw = get(idx("source")).toLowerCase().replace(/[-\s]/g, "_");
    const source = (SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : "import";
    const stageRaw = get(idx("stage")).toLowerCase().replace(/\s+/g, "_");
    const stage = stageRaw && stageIds.has(stageRaw) ? stageRaw : stages[0].id;
    const valueRaw = get(idx("value")).replace(/[$,]/g, "");
    const valueCents = valueRaw ? Math.round(Number(valueRaw) * 100) : null;
    if (valueCents !== null && (!Number.isFinite(valueCents) || valueCents < 0)) {
      errors.push({ row: r + 1, error: "invalid value" }); continue;
    }

    const dedupKey = dedupKeyFor(email, phone);
    try {
      if (dedupKey) {
        const existing = await prisma.lead.findFirst({
          where: { workspaceId: workspace.id, dedupKey, NOT: { stage: { in: [...CLOSED_STAGES] } } },
          select: { id: true },
        });
        if (existing) {
          duplicates.push({ row: r + 1, name, existingId: existing.id });
          continue;
        }
      }
      const lead = await prisma.lead.create({
        data: {
          workspaceId: workspace.id,
          pipelineId: pipeline.id,
          name,
          email,
          phone,
          company: get(idx("company")) || null,
          title: get(idx("title")) || null,
          source: source as (typeof SOURCES)[number],
          sourceDetail: get(idx("sourcedetail")) || get(idx("source_detail")) || null,
          stage,
          valueCents,
          ownerName: get(idx("ownername")) || get(idx("owner_name")) || get(idx("owner")) || null,
          dedupKey,
        },
      });
      await logActivity({
        workspaceId: workspace.id, leadId: lead.id, type: "import",
        body: `Imported from CSV (row ${r + 1})`, actor,
      });
      await recomputeScore(lead.id, workspace.id);
      created++;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && dedupKey) {
        const existing = await prisma.lead.findFirst({
          where: { workspaceId: workspace.id, dedupKey },
          select: { id: true },
        });
        duplicates.push({ row: r + 1, name, existingId: existing?.id ?? "unknown" });
      } else {
        errors.push({ row: r + 1, error: "insert failed" });
      }
    }
  }

  return Response.json({ created, duplicates, errors, total: rows.length - 1 });
}
