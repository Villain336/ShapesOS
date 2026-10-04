// ShapesOS Phase 10 (ops-core) — CRM accounts: companies, contacts, deals,
// and Lead → Contact/Company(/Deal) conversion.
//
// Lead stays the CAPTURE record (forms, CSV import, inbox threads, scoring,
// the lead pipeline board). Conversion is idempotent and dedupes:
//   - contact: by the lead link, then by normalized email
//   - company: by registrable email domain (free-mail domains ignored),
//     then by case-insensitive name
//   - deal (optional): one per lead, on the lead's pipeline + stage
// The entities are registered in OPS_ENTITIES (generic /api/ops/{entity}
// route + audit + RLS); this module holds their create/patch hooks.

import type { Prisma } from "@prisma/client";
import { OpsError, OpsNotFoundError, auditOpsEvent, type OpsActor } from "./doctype";
import { OPS_ENTITY_MAP } from "./entities";
import { assertWorkspaceUser } from "./people";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Normalization (pure)
// ---------------------------------------------------------------------------

/** Consumer mailbox domains — never a company identity. */
export const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com",
  "yandex.com", "yandex.ru", "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "web.de",
]);

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** "https://www.Acme.com/about" | "acme.com" | "WWW.ACME.COM" → "acme.com". */
export function normalizeDomain(input: string | null | undefined): string | null {
  let d = (input ?? "").trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.split("@").pop()!.replace(/:\d+$/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/** Company identity from an email address (null for free-mail domains). */
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const d = normalizeDomain(e.split("@")[1]);
  return d && !FREE_MAIL_DOMAINS.has(d) ? d : null;
}

export function normalizeCompanyName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().replace(/\s+/g, " ");
  return n || null;
}

// ---------------------------------------------------------------------------
// Delegates
// ---------------------------------------------------------------------------

interface D {
  findFirst(a: unknown): Promise<Record<string, unknown> | null>;
  findMany(a: unknown): Promise<Array<Record<string, unknown>>>;
  create(a: unknown): Promise<Record<string, unknown>>;
  update(a: unknown): Promise<Record<string, unknown>>;
}
const del = (tx: Tx, n: string) => (tx as unknown as Record<string, D>)[n];

async function findCompany(tx: Tx, ws: string, domain: string | null, name: string | null) {
  if (domain) {
    const byDomain = await del(tx, "opsCompany").findFirst({ where: { workspaceId: ws, domain } });
    if (byDomain) return byDomain;
  }
  if (name) {
    return del(tx, "opsCompany").findFirst({ where: { workspaceId: ws, name: { equals: name, mode: "insensitive" } } });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entity hooks
// ---------------------------------------------------------------------------

export async function createCompanyRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const name = normalizeCompanyName(body.name as string)!;
  const domain = normalizeDomain((body.domain as string | undefined) ?? (body.website as string | undefined));
  if (body.domain && !domain) throw new OpsError(400, "Invalid company domain");
  const dupe = await findCompany(tx, actor.workspaceId, domain, name);
  if (dupe) throw new OpsError(409, `Company already exists: "${String(dupe.name)}" (${String(dupe.id)})`);
  return del(tx, "opsCompany").create({
    data: {
      workspaceId: actor.workspaceId,
      name,
      domain,
      website: (body.website as string | undefined) ?? null,
      phone: (body.phone as string | undefined) ?? null,
      industry: (body.industry as string | undefined) ?? null,
      ownerId: (body.ownerId as string | undefined) ?? null,
      notes: (body.notes as string | undefined) ?? null,
    },
  });
}

export async function patchCompanyRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...patch };
  if (patch.domain !== undefined) {
    data.domain = patch.domain === null ? null : normalizeDomain(patch.domain as string);
    if (patch.domain !== null && !data.domain) throw new OpsError(400, "Invalid company domain");
    if (data.domain) {
      const dupe = await del(tx, "opsCompany").findFirst({ where: { workspaceId: actor.workspaceId, domain: data.domain, NOT: { id } } });
      if (dupe) throw new OpsError(409, `Another company already uses ${String(data.domain)}`);
    }
  }
  return del(tx, "opsCompany").update({ where: { id }, data });
}

export async function createContactRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  const email = normalizeEmail(body.email as string | undefined);
  if (body.email && !email) throw new OpsError(400, "Invalid contact email");
  if (email) {
    const dupe = await del(tx, "opsContact").findFirst({ where: { workspaceId: actor.workspaceId, email } });
    if (dupe) throw new OpsError(409, `Contact already exists for ${email} (${String(dupe.id)})`);
  }
  let companyId = (body.companyId as string | undefined) ?? null;
  if (companyId) {
    const c = await del(tx, "opsCompany").findFirst({ where: { id: companyId, workspaceId: actor.workspaceId } });
    if (!c) throw new OpsNotFoundError("companies", companyId);
  } else if (email) {
    // Auto-link to an existing company on the same business domain.
    const domain = companyDomainFromEmail(email);
    if (domain) companyId = ((await findCompany(tx, actor.workspaceId, domain, null))?.id as string | undefined) ?? null;
  }
  return del(tx, "opsContact").create({
    data: {
      workspaceId: actor.workspaceId,
      companyId,
      name: String(body.name).trim(),
      email,
      phone: (body.phone as string | undefined) ?? null,
      title: (body.title as string | undefined) ?? null,
      ownerId: (body.ownerId as string | undefined) ?? null,
      notes: (body.notes as string | undefined) ?? null,
    },
  });
}

export async function patchContactRow(tx: Tx, actor: OpsActor, id: string, patch: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...patch };
  if (patch.email !== undefined) {
    data.email = patch.email === null ? null : normalizeEmail(patch.email as string);
    if (patch.email !== null && !data.email) throw new OpsError(400, "Invalid contact email");
  }
  if (typeof patch.companyId === "string") {
    const c = await del(tx, "opsCompany").findFirst({ where: { id: patch.companyId, workspaceId: actor.workspaceId } });
    if (!c) throw new OpsNotFoundError("companies", patch.companyId);
  }
  return del(tx, "opsContact").update({ where: { id }, data });
}

/** Stage ids of a CRM pipeline (crm_pipelines.stages JSON). */
async function pipelineStages(tx: Tx, ws: string, pipelineId: string): Promise<string[]> {
  const p = await del(tx, "pipeline").findFirst({ where: { id: pipelineId, workspaceId: ws } });
  if (!p) throw new OpsNotFoundError("pipelines", pipelineId);
  const stages = Array.isArray(p.stages) ? (p.stages as Array<{ id?: unknown }>) : [];
  return stages.map((s) => String(s.id ?? "")).filter(Boolean);
}

/** Deal status follows the canonical closed stages (won / lost). */
export function dealStatusForStage(stage: string): "open" | "won" | "lost" {
  return stage === "won" ? "won" : stage === "lost" ? "lost" : "open";
}

export async function createDealRow(tx: Tx, actor: OpsActor, body: Record<string, unknown>) {
  let pipelineId = body.pipelineId as string | undefined;
  if (!pipelineId) {
    const def =
      (await del(tx, "pipeline").findFirst({ where: { workspaceId: actor.workspaceId, isDefault: true } })) ??
      (await del(tx, "pipeline").findFirst({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "asc" } }));
    if (!def) throw new OpsError(422, "Create a CRM pipeline before adding deals");
    pipelineId = String(def.id);
  }
  const stages = await pipelineStages(tx, actor.workspaceId, pipelineId);
  const stage = (body.stage as string | undefined) ?? stages[0];
  if (!stage || !stages.includes(stage)) throw new OpsError(422, `Stage "${stage}" is not in this pipeline (${stages.join(", ")})`);
  for (const [field, model, slug] of [["contactId", "opsContact", "contacts"], ["companyId", "opsCompany", "companies"]] as const) {
    const ref = body[field] as string | undefined;
    if (ref && !(await del(tx, model).findFirst({ where: { id: ref, workspaceId: actor.workspaceId } }))) throw new OpsNotFoundError(slug, ref);
  }
  if (typeof body.ownerId === "string" && body.ownerId !== actor.userId) await assertWorkspaceUser(tx, actor.workspaceId, body.ownerId);
  const status = dealStatusForStage(stage);
  return del(tx, "opsDeal").create({
    data: {
      workspaceId: actor.workspaceId,
      title: String(body.title).trim(),
      pipelineId,
      stage,
      status,
      valueCents: (body.valueCents as number | undefined) ?? 0,
      ownerId: (body.ownerId as string | undefined) ?? actor.userId,
      ownerName: (body.ownerName as string | undefined) ?? null,
      contactId: (body.contactId as string | undefined) ?? null,
      companyId: (body.companyId as string | undefined) ?? null,
      leadId: (body.leadId as string | undefined) ?? null,
      expectedCloseAt: body.expectedCloseAt ? new Date(String(body.expectedCloseAt)) : null,
      closedAt: status === "open" ? null : new Date(),
    },
  });
}

export async function patchDealRow(
  tx: Tx,
  actor: OpsActor,
  id: string,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
) {
  const data: Record<string, unknown> = { ...patch };
  if (typeof patch.stage === "string") {
    const stages = await pipelineStages(tx, actor.workspaceId, String(existing.pipelineId));
    if (!stages.includes(patch.stage)) throw new OpsError(422, `Stage "${patch.stage}" is not in this pipeline`);
    const status = dealStatusForStage(patch.stage);
    data.status = status;
    data.closedAt = status === "open" ? null : existing.closedAt ?? new Date();
  }
  if (typeof patch.ownerId === "string") await assertWorkspaceUser(tx, actor.workspaceId, patch.ownerId);
  if (patch.expectedCloseAt !== undefined) {
    data.expectedCloseAt = patch.expectedCloseAt === null ? null : new Date(String(patch.expectedCloseAt));
  }
  for (const [field, model, slug] of [["contactId", "opsContact", "contacts"], ["companyId", "opsCompany", "companies"]] as const) {
    const ref = patch[field];
    if (typeof ref === "string" && !(await del(tx, model).findFirst({ where: { id: ref, workspaceId: actor.workspaceId } }))) {
      throw new OpsNotFoundError(slug, ref);
    }
  }
  return del(tx, "opsDeal").update({ where: { id }, data });
}

// ---------------------------------------------------------------------------
// Lead → Contact / Company (/ Deal) conversion
// ---------------------------------------------------------------------------

export interface ConvertLeadResult {
  contact: Record<string, unknown>;
  company: Record<string, unknown> | null;
  deal: Record<string, unknown> | null;
  created: { contact: boolean; company: boolean; deal: boolean };
}

export async function convertLead(
  tx: Tx,
  actor: OpsActor,
  leadId: string,
  opts: { createDeal?: boolean } = {},
): Promise<ConvertLeadResult> {
  const lead = await del(tx, "lead").findFirst({ where: { id: leadId, workspaceId: actor.workspaceId } });
  if (!lead) throw new OpsNotFoundError("leads", leadId);
  const email = normalizeEmail(lead.email as string | null);
  const created = { contact: false, company: false, deal: false };

  // Company: business email domain first, then the lead's company string.
  const domain = companyDomainFromEmail(email);
  const companyName = normalizeCompanyName(lead.company as string | null);
  let company = await findCompany(tx, actor.workspaceId, domain, companyName);
  if (!company && (companyName || domain)) {
    company = await del(tx, "opsCompany").create({
      data: { workspaceId: actor.workspaceId, name: companyName ?? domain!, domain, ownerId: (lead.ownerId as string | null) ?? null },
    });
    created.company = true;
  } else if (company && domain && !company.domain) {
    // Learn the domain on a name-matched company (dedupes future emails).
    const clash = await del(tx, "opsCompany").findFirst({ where: { workspaceId: actor.workspaceId, domain } });
    if (!clash) company = await del(tx, "opsCompany").update({ where: { id: company.id }, data: { domain } });
  }

  // Contact: the lead link, then the email.
  let contact =
    (await del(tx, "opsContact").findFirst({ where: { workspaceId: actor.workspaceId, leadId } })) ??
    (email ? await del(tx, "opsContact").findFirst({ where: { workspaceId: actor.workspaceId, email } }) : null);
  if (!contact) {
    contact = await del(tx, "opsContact").create({
      data: {
        workspaceId: actor.workspaceId,
        companyId: company ? company.id : null,
        name: lead.name,
        email,
        phone: lead.phone ?? null,
        title: lead.title ?? null,
        ownerId: lead.ownerId ?? null,
        leadId,
      },
    });
    created.contact = true;
  } else if (!contact.companyId && company) {
    contact = await del(tx, "opsContact").update({ where: { id: contact.id }, data: { companyId: company.id } });
  }

  let deal = await del(tx, "opsDeal").findFirst({ where: { workspaceId: actor.workspaceId, leadId } });
  if (!deal && opts.createDeal) {
    deal = await createDealRow(tx, actor, {
      title: companyName ? `${companyName} — ${String(lead.name)}` : String(lead.name),
      pipelineId: lead.pipelineId,
      stage: lead.stage,
      valueCents: (lead.valueCents as number | null) ?? 0,
      // Lead owners are free-text CRM fields; the deal is owned by the
      // converting user (a validated workspace member).
      ownerName: (lead.ownerName as string | null) ?? undefined,
      contactId: contact.id,
      companyId: company ? company.id : undefined,
      leadId,
    });
    created.deal = true;
  }

  const anyNew = created.contact || created.company || created.deal;
  if (anyNew) {
    await auditOpsEvent(
      tx,
      OPS_ENTITY_MAP["contacts"]!,
      actor,
      "convert_lead",
      String(contact.id),
      `lead ${leadId} converted → contact ${String(contact.id)}${company ? `, company ${String(company.id)}` : ""}${deal ? `, deal ${String(deal.id)}` : ""}`,
    );
    await del(tx, "leadActivity").create({
      data: {
        workspaceId: actor.workspaceId,
        leadId,
        type: "note",
        body: `Converted to contact${company ? ` at ${String(company.name)}` : ""}${created.deal ? " with a deal" : ""}.`,
        actor: "System",
      },
    });
  }
  return { contact, company, deal, created };
}
