// Marketr — R6 prospects in a list API.
// GET  /api/prospects/lists/[id]/prospects → prospects with latest lookup per provider
// POST /api/prospects/lists/[id]/prospects (editor) → manual add OR CSV import
//   body: { prospects: [{company,name,email,phone,title,website}] }   (manual)
//   body: { csv: "company,name,email,...\n..." }                      (import)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { dedupKeyFor } from "@/lib/crm/dedup";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";
import { intQuery, parseQuery } from "@/lib/api/validate";

const ProspectInput = z.object({
  company: z.string().trim().max(200).optional(),
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  title: z.string().trim().max(200).optional(),
  website: z.string().trim().max(500).optional(),
});

const PostSchema = z
  .object({
    prospects: z.array(ProspectInput).max(2000).optional(),
    csv: z.string().max(2_000_000).optional(),
  })
  .refine((d) => d.prospects || d.csv, { message: "Provide prospects[] or csv" });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimal CSV parser: handles quoted fields with commas/quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const push = () => {
    row.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      push();
    } else if (c === "\n") {
      push();
      rows.push(row);
      row = [];
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  push();
  rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const HEADER_ALIASES: Record<string, string> = {
  company: "company",
  company_name: "company",
  organization: "company",
  name: "name",
  full_name: "name",
  contact: "name",
  email: "email",
  email_address: "email",
  phone: "phone",
  phone_number: "phone",
  title: "title",
  job_title: "title",
  website: "website",
  domain: "website",
  company_website: "website",
};

function csvToProspects(csv: string): Array<Record<string, string>> {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) =>
    HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, "_")] ?? "",
  );
  return rows.slice(1, 2001).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h && r[i]?.trim()) obj[h] = r[i].trim();
    });
    return obj;
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const list = await prisma.prospectList.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!list) throw new HttpError(404, "List not found");

    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const limitQuery = parseQuery(z.object({ limit: intQuery(200, 1, 500) }), url.searchParams);
    if (!limitQuery.ok) return limitQuery.error;
    const limit = limitQuery.data.limit;

    const prospects = await prisma.prospect.findMany({
      where: {
        workspaceId: workspace.id,
        listId: id,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        lookups: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    return Response.json({ prospects });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const list = await prisma.prospectList.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!list) throw new HttpError(404, "List not found");

    const parsed = PostSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }

    const rawInputs: Array<Record<string, string | undefined>> = parsed.data.prospects
      ? parsed.data.prospects.map((p) => ({ ...p }))
      : csvToProspects(parsed.data.csv!);

    // Existing dedup keys in this list (fast in-memory check).
    const existing = await prisma.prospect.findMany({
      where: { workspaceId: workspace.id, listId: id, dedupKey: { not: null } },
      select: { dedupKey: true },
    });
    const seen = new Set(existing.map((e) => e.dedupKey as string));

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const [i, raw] of rawInputs.entries()) {
      const email = raw.email?.trim() || undefined;
      const phone = raw.phone?.trim() || undefined;
      if (email && !EMAIL_RE.test(email)) {
        skipped++;
        errors.push(`Row ${i + 1}: invalid email "${email}"`);
        continue;
      }
      if (!email && !phone && !raw.company?.trim() && !raw.website?.trim()) {
        skipped++;
        errors.push(`Row ${i + 1}: no identity (need email, phone, company, or website)`);
        continue;
      }
      const dedupKey = dedupKeyFor(email, phone);
      if (dedupKey && seen.has(dedupKey)) {
        skipped++;
        continue;
      }
      try {
        await prisma.prospect.create({
          data: {
            workspaceId: workspace.id,
            listId: id,
            company: raw.company?.trim() || null,
            name: raw.name?.trim() || null,
            email: email || null,
            phone: phone || null,
            title: raw.title?.trim() || null,
            website: raw.website?.trim() || null,
            status: "new",
            dedupKey,
          },
        });
        if (dedupKey) seen.add(dedupKey);
        created++;
      } catch {
        skipped++;
        errors.push(`Row ${i + 1}: insert failed (possible duplicate)`);
      }
    }

    if (list.status === "draft" && created > 0) {
      await prisma.prospectList.update({ where: { id }, data: { status: "building" } });
    }

    return Response.json(
      { created, skipped, errors: errors.slice(0, 20) },
      { status: 201 },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
