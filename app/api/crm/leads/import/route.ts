// Marketr — CRM CSV import with dedup report.
// POST /api/crm/leads/import  → { pipelineId, csv } (editor+)
// Columns: name*, email, phone, company, title, source, sourceDetail, stage,
// value (dollars), ownerName, utm_source, utm_medium, utm_campaign,
// utm_content, content_id. Returns { created, duplicates, errors }.
// UTM columns are recorded as the lead's creation attribution touch (C2).

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { dedupKeyFor, recomputeScore, logActivity } from "@/lib/crm/dedup";
import { parseStages, CLOSED_STAGES } from "@/lib/crm/stages";
import { recordCaptureTouch } from "@/lib/attribution/touches";
import { maybeRecordWonRevenue } from "@/lib/attribution/revenue";
import { parseCsvWithLines, parseLeadValueCents } from "@/lib/crm/csv-import";
import { emitLeadCreated } from "@/lib/webhooks/emit";

const SOURCES = ["website_form", "phone", "referral", "import", "ad", "ooh", "direct_mail", "other"] as const;

const ImportSchema = z.object({
  pipelineId: z.string().min(1).max(64),
  csv: z.string().min(1).max(2_000_000), // 2MB cap
});

/** Minimal RFC-4180-ish CSV parse (quotes, commas, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  return parseCsvWithLines(text).rows;
}

export interface ImportRowResult {
  created: number;
  duplicates: { row: number; name: string; existingId: string }[];
  errors: { row: number; error: string }[];
  total: number;
}

/**
 * Process parsed CSV rows into leads. Exported so the attribution battery
 * exercises the same code the route runs (C2: UTM columns → touches).
 */
export async function processImportRows(
  workspaceId: string,
  actor: string,
  pipeline: { id: string; stages: unknown },
  rows: string[][],
  /** Source line of each row (parseCsvWithLines) — errors name the real line. */
  lines?: number[],
): Promise<ImportRowResult> {
  const stages = parseStages(pipeline.stages);
  const stageIds = new Set(stages.map((s) => s.id));

  if (rows.length < 2) {
    return { created: 0, duplicates: [], errors: [{ row: 0, error: "CSV needs a header row and at least one data row" }], total: 0 };
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const nameIdx = idx("name");
  if (nameIdx === -1) {
    return { created: 0, duplicates: [], errors: [{ row: 0, error: 'CSV must have a "name" column' }], total: 0 };
  }

  let created = 0;
  const duplicates: { row: number; name: string; existingId: string }[] = [];
  const errors: { row: number; error: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNo = lines?.[r] ?? r + 1;
    const get = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : "");
    const name = get(nameIdx);
    if (!name) { errors.push({ row: rowNo, error: "name required" }); continue; }

    const email = get(idx("email")) || null;
    const phone = get(idx("phone")) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: rowNo, error: "invalid email" }); continue;
    }
    const sourceRaw = get(idx("source")).toLowerCase().replace(/[-\s]/g, "_");
    const source = (SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : "import";
    const stageRaw = get(idx("stage")).toLowerCase().replace(/\s+/g, "_");
    const stage = stageRaw && stageIds.has(stageRaw) ? stageRaw : stages[0].id;
    // Bounded to the int4 column with a clear message (was a generic
    // "insert failed" once the value overflowed).
    const value = parseLeadValueCents(get(idx("value")));
    if ("error" in value) {
      errors.push({ row: rowNo, error: value.error }); continue;
    }
    const valueCents = value.cents;
    // C2: UTM columns → the creation attribution touch.
    const utm = {
      utm_source: get(idx("utm_source")) || undefined,
      utm_medium: get(idx("utm_medium")) || undefined,
      utm_campaign: get(idx("utm_campaign")) || undefined,
      utm_content: get(idx("utm_content")) || undefined,
    };
    const contentId = get(idx("content_id")) || null;

    const dedupKey = dedupKeyFor(email, phone);
    try {
      if (dedupKey) {
        const existing = await prisma.lead.findFirst({
          where: { workspaceId, dedupKey, NOT: { stage: { in: [...CLOSED_STAGES] } } },
          select: { id: true },
        });
        if (existing) {
          duplicates.push({ row: rowNo, name, existingId: existing.id });
          continue;
        }
      }
      const lead = await prisma.lead.create({
        data: {
          workspaceId,
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
        workspaceId, leadId: lead.id, type: "import",
        body: `Imported from CSV (row ${rowNo})`, actor,
      });
      // C2: creation touch + won-revenue event (imported rows may be won).
      await recordCaptureTouch({
        workspaceId, leadId: lead.id, leadSource: source,
        utm, contentId,
      });
      await maybeRecordWonRevenue({
        workspaceId, leadId: lead.id,
        before: { stage: "", valueCents: 0 },
        after: { stage: lead.stage, valueCents: lead.valueCents },
        actor,
      });
      await recomputeScore(lead.id, workspaceId);
      // Phase 4a: lead.created webhook (best-effort, never throws).
      await emitLeadCreated(lead);
      created++;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && dedupKey) {
        const existing = await prisma.lead.findFirst({
          where: { workspaceId, dedupKey },
          select: { id: true },
        });
        duplicates.push({ row: rowNo, name, existingId: existing?.id ?? "unknown" });
      } else {
        errors.push({ row: rowNo, error: "insert failed" });
      }
    }
  }

  return { created, duplicates, errors, total: rows.length - 1 };
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

  const { rows, lines } = parseCsvWithLines(parsed.data.csv);
  if (rows.length > 5001) {
    return Response.json({ error: "Import capped at 5000 rows" }, { status: 400 });
  }
  const actor = user.name ?? user.email ?? "Import";
  const result = await processImportRows(workspace.id, actor, pipeline, rows, lines);
  return Response.json(result);
}
