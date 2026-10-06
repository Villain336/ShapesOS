// ShapesOS — Phase 18.2 (WS=comms): Contacts — one address book as an
// identity-link layer over the four people stores. NOT a new source of
// truth: names, emails and phones stay in their own records (crm_leads,
// ops_contacts, connector_agent_persons, funding_contacts); this module only
//
//   - links every record to an identity (its own, until a person merges it):
//     syncContactIdentities() — idempotent, run by the Contacts app and the
//     comms-contacts cron;
//   - keeps each identity's search cache (name, emails, phones, companies);
//   - proposes merges (lib/comms/contacts/match.ts) as SUGGESTIONS — pending
//     until a person confirms (merge) or rejects (remembered for the record
//     pair, never suggested again). Nothing here merges on its own;
//   - reads one person's records and their timeline across the stores.
//
// Every function takes the withWorkspaceScope client (contact_* tables and
// the Ops tables are FORCE RLS) and filters workspace_id explicitly too.

import type { Prisma, PrismaClient } from "@prisma/client";
import { HttpError } from "@/lib/api/errors";
import {
  candidatePairs,
  compareRecords,
  emailsIn,
  identitySummary,
  isContactRecordKind,
  normalizeEmail,
  orderPair,
  recordKey,
  type ContactRecordKind,
  type EvidenceReason,
  type PersonRecord,
} from "./match";

type Db = Prisma.TransactionClient | PrismaClient;

export class ContactsError extends HttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "ContactsError";
  }
}

/** Upper bound of records read per store per sync (larger workspaces sync the most recent). */
export const SYNC_MAX_PER_STORE = 20_000;

const PHONE_HANDLE_RE = /^\+?[\d\s().-]{7,}$/;

/** Where each kind of record opens in its own app. */
export function recordHref(kind: ContactRecordKind, id: string): string {
  const e = encodeURIComponent(id);
  switch (kind) {
    case "lead":
      return `/dashboard/crm?lead=${e}`;
    case "ops_contact":
      return `/dashboard/crm?tab=contacts&contact=${e}`;
    case "connector_person":
      return `/dashboard/connector?person=${e}`;
    case "funding_contact":
      return `/dashboard/funding?contact=${e}`;
  }
}

/** Every person record in the workspace, normalized (newest first per store). */
export async function loadPersonRecords(db: Db, workspaceId: string, max = SYNC_MAX_PER_STORE): Promise<PersonRecord[]> {
  const [leads, contacts, persons, funding] = await Promise.all([
    db.lead.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: max,
      select: { id: true, name: true, email: true, phone: true, company: true, title: true, updatedAt: true },
    }),
    db.opsContact.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: max,
      select: { id: true, name: true, email: true, phone: true, title: true, updatedAt: true, company: { select: { name: true } } },
    }),
    db.connectorPerson.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: max,
      select: { id: true, name: true, handles: true, roles: true, updatedAt: true },
    }),
    db.fundingContact.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: max,
      select: { id: true, name: true, role: true, handle: true, updatedAt: true },
    }),
  ]);
  const out: PersonRecord[] = [];
  for (const l of leads) {
    out.push({ kind: "lead", id: l.id, name: l.name, emails: emailsIn([l.email]), phones: l.phone ? [l.phone] : [], company: l.company, title: l.title, updatedAt: l.updatedAt });
  }
  for (const c of contacts) {
    out.push({ kind: "ops_contact", id: c.id, name: c.name, emails: emailsIn([c.email]), phones: c.phone ? [c.phone] : [], company: c.company?.name ?? null, title: c.title, updatedAt: c.updatedAt });
  }
  for (const p of persons) {
    out.push({
      kind: "connector_person",
      id: p.id,
      name: p.name,
      emails: emailsIn(p.handles),
      phones: p.handles.filter((h) => PHONE_HANDLE_RE.test(h.trim())),
      company: null,
      title: p.roles[0] ?? null,
      updatedAt: p.updatedAt,
    });
  }
  for (const f of funding) {
    out.push({
      kind: "funding_contact",
      id: f.id,
      name: f.name,
      emails: emailsIn([f.handle]),
      phones: f.handle && PHONE_HANDLE_RE.test(f.handle.trim()) ? [f.handle] : [],
      company: null,
      title: f.role,
      updatedAt: f.updatedAt,
    });
  }
  return out;
}

export interface SyncResult {
  records: number;
  linked: number;
  unlinked: number;
  identitiesRemoved: number;
  identitiesRefreshed: number;
  suggested: number;
  staled: number;
}

/**
 * Link every record to an identity (a new one of its own if it has none),
 * drop links to records that are gone, refresh identity caches, and refresh
 * the PENDING merge suggestions. Confirmed and rejected suggestions are
 * never touched; nothing is ever merged here. Idempotent.
 */
export async function syncContactIdentities(db: Db, workspaceId: string, now = new Date()): Promise<SyncResult> {
  const records = await loadPersonRecords(db, workspaceId);
  const byKey = new Map(records.map((r) => [recordKey(r), r]));
  const links = await db.contactIdentityLink.findMany({
    where: { workspaceId },
    select: { id: true, identityId: true, recordKind: true, recordId: true },
  });
  const result: SyncResult = { records: records.length, linked: 0, unlinked: 0, identitiesRemoved: 0, identitiesRefreshed: 0, suggested: 0, staled: 0 };

  // 1. Links to records that no longer exist.
  const gone = links.filter((l) => !byKey.has(`${l.recordKind}:${l.recordId}`));
  if (gone.length) {
    await db.contactIdentityLink.deleteMany({ where: { workspaceId, id: { in: gone.map((l) => l.id) } } });
    result.unlinked = gone.length;
  }
  const identityOf = new Map<string, string>();
  for (const l of links) if (byKey.has(`${l.recordKind}:${l.recordId}`)) identityOf.set(`${l.recordKind}:${l.recordId}`, l.identityId);

  // 2. Records without an identity get their own (one row each; never merged).
  for (const r of records) {
    const key = recordKey(r);
    if (identityOf.has(key)) continue;
    const s = identitySummary([r]);
    const identity = await db.contactIdentity.create({
      data: { workspaceId, displayName: s.displayName.slice(0, 300), emails: s.emails, phones: s.phones, companies: s.companies, recordCount: 1 },
      select: { id: true },
    });
    try {
      await db.contactIdentityLink.create({ data: { workspaceId, identityId: identity.id, recordKind: r.kind, recordId: r.id, linkedVia: "sync" } });
      identityOf.set(key, identity.id);
      result.linked++;
    } catch {
      // A concurrent sync linked it first: drop ours, keep theirs.
      await db.contactIdentity.delete({ where: { id: identity.id, workspaceId } }).catch(() => undefined);
      const theirs = await db.contactIdentityLink.findFirst({ where: { workspaceId, recordKind: r.kind, recordId: r.id }, select: { identityId: true } });
      if (theirs) identityOf.set(key, theirs.identityId);
    }
  }

  // 3. Identity caches (and identities left with no records).
  const members = new Map<string, PersonRecord[]>();
  for (const r of records) {
    const id = identityOf.get(recordKey(r));
    if (!id) continue;
    const list = members.get(id);
    if (list) list.push(r);
    else members.set(id, [r]);
  }
  const identities = await db.contactIdentity.findMany({
    where: { workspaceId },
    select: { id: true, displayName: true, emails: true, phones: true, companies: true, recordCount: true },
  });
  const empty = identities.filter((i) => !members.has(i.id)).map((i) => i.id);
  if (empty.length) {
    await db.contactIdentity.deleteMany({ where: { workspaceId, id: { in: empty } } });
    result.identitiesRemoved = empty.length;
  }
  for (const i of identities) {
    const recs = members.get(i.id);
    if (!recs) continue;
    const s = identitySummary(recs);
    const same =
      s.displayName === i.displayName &&
      recs.length === i.recordCount &&
      s.emails.join("|") === i.emails.join("|") &&
      s.phones.join("|") === i.phones.join("|") &&
      s.companies.join("|") === i.companies.join("|");
    if (same) continue;
    await db.contactIdentity.update({
      where: { id: i.id, workspaceId },
      data: { displayName: s.displayName.slice(0, 300), emails: s.emails, phones: s.phones, companies: s.companies, recordCount: recs.length },
    });
    result.identitiesRefreshed++;
  }

  // 4. Suggestions: refresh PENDING ones; remembered rejections block a pair of identities.
  const existing = await db.contactMergeSuggestion.findMany({
    where: { workspaceId },
    select: { id: true, aKind: true, aId: true, bKind: true, bId: true, status: true },
  });
  const rejected = new Set<string>();
  for (const s of existing) {
    if (s.status !== "rejected") continue;
    const ia = identityOf.get(`${s.aKind}:${s.aId}`);
    const ib = identityOf.get(`${s.bKind}:${s.bId}`);
    if (ia && ib) {
      rejected.add(`${ia}|${ib}`);
      rejected.add(`${ib}|${ia}`);
    }
  }
  const pairs = candidatePairs(records, (r) => identityOf.get(recordKey(r)) ?? recordKey(r), rejected);
  const wanted = new Set<string>();
  for (const p of pairs) {
    const key = { workspaceId, aKind: p.a.kind, aId: p.a.id, bKind: p.b.kind, bId: p.b.id };
    wanted.add(`${p.a.kind}:${p.a.id}|${p.b.kind}:${p.b.id}`);
    const prior = existing.find((s) => s.aKind === key.aKind && s.aId === key.aId && s.bKind === key.bKind && s.bId === key.bId);
    if (prior && (prior.status === "rejected" || prior.status === "confirmed")) continue;
    if (prior) {
      await db.contactMergeSuggestion.update({
        where: { id: prior.id, workspaceId },
        data: { score: p.evidence.score, reasons: p.evidence.reasons, status: "pending", updatedAt: now },
      });
    } else {
      await db.contactMergeSuggestion.create({ data: { ...key, score: p.evidence.score, reasons: p.evidence.reasons, status: "pending", proposedVia: "sync" } });
      result.suggested++;
    }
  }
  // Pending sync suggestions that no longer hold (now one identity, or the evidence changed) go stale.
  for (const s of existing) {
    if (s.status !== "pending") continue;
    const ia = identityOf.get(`${s.aKind}:${s.aId}`);
    const ib = identityOf.get(`${s.bKind}:${s.bId}`);
    const sameIdentity = !!ia && ia === ib;
    const missing = !ia || !ib;
    const stillWanted = wanted.has(`${s.aKind}:${s.aId}|${s.bKind}:${s.bId}`);
    if (sameIdentity || missing || !stillWanted) {
      // An agent's or person's proposal stays until decided unless it became moot.
      const proposed = await db.contactMergeSuggestion.findUnique({ where: { id: s.id, workspaceId }, select: { proposedVia: true } });
      if (!sameIdentity && !missing && proposed?.proposedVia !== "sync") continue;
      await db.contactMergeSuggestion.update({ where: { id: s.id, workspaceId }, data: { status: "stale" } });
      result.staled++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface IdentityCard {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  companies: string[];
  recordCount: number;
  kinds: ContactRecordKind[];
  updatedAt: string;
}

/** The address book: one row per person, optionally searched (name, email, phone, company). */
export async function listIdentities(db: Db, opts: { workspaceId: string; q?: string | null; limit?: number; offset?: number }): Promise<{ items: IdentityCard[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = (opts.q ?? "").trim().slice(0, 100);
  const where: Prisma.ContactIdentityWhereInput = { workspaceId: opts.workspaceId };
  if (q) {
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { displayName: { contains: q, mode: "insensitive" } },
      { emails: { has: lower } },
      { companies: { has: q } },
      ...(digits.length >= 4 ? [{ phones: { has: q } }] : []),
    ];
  }
  const [rows, total] = await Promise.all([
    db.contactIdentity.findMany({
      where: { ...where, workspaceId: opts.workspaceId },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: limit,
      skip: Math.max(0, opts.offset ?? 0),
      include: { links: { select: { recordKind: true } } },
    }),
    db.contactIdentity.count({ where }),
  ]);
  // Email / phone substrings (has: is exact) — a second, bounded pass.
  let items = rows;
  if (q && rows.length < limit && /[@\d]/.test(q)) {
    const extra = await db.contactIdentity.findMany({
      where: { workspaceId: opts.workspaceId, id: { notIn: rows.map((r) => r.id) } },
      take: 2000,
      include: { links: { select: { recordKind: true } } },
    });
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    items = [
      ...rows,
      ...extra.filter((i) => i.emails.some((e) => e.includes(lower)) || (digits.length >= 4 && i.phones.some((p) => p.replace(/\D/g, "").includes(digits)))).slice(0, limit - rows.length),
    ];
  }
  return {
    total: Math.max(total, items.length),
    items: items.map((i) => ({
      id: i.id,
      name: i.displayName,
      emails: i.emails,
      phones: i.phones,
      companies: i.companies,
      recordCount: i.recordCount,
      kinds: [...new Set(i.links.map((l) => l.recordKind).filter(isContactRecordKind))],
      updatedAt: i.updatedAt.toISOString(),
    })),
  };
}

export interface LinkedRecordView {
  kind: ContactRecordKind;
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string | null;
  title: string | null;
  href: string;
  linkedVia: string;
  confirmedAt: string | null;
}

export interface TimelineItem {
  key: string;
  at: string;
  /** mail | sms | meeting | call | deal | ticket | invoice | note | funding | booking */
  type: string;
  title: string;
  detail: string | null;
  href: string | null;
}

export interface IdentityDetail {
  identity: IdentityCard;
  records: LinkedRecordView[];
  timeline: TimelineItem[];
  suggestions: SuggestionView[];
}

async function recordsOf(db: Db, workspaceId: string, identityId: string) {
  const links = await db.contactIdentityLink.findMany({
    where: { workspaceId, identityId },
    orderBy: { createdAt: "asc" },
    select: { recordKind: true, recordId: true, linkedVia: true, confirmedAt: true },
  });
  const all = await loadRecordsByKeys(db, workspaceId, links.map((l) => ({ kind: l.recordKind as ContactRecordKind, id: l.recordId })));
  return links
    .map((l) => {
      const r = all.get(`${l.recordKind}:${l.recordId}`);
      return r ? { r, link: l } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/** Load specific records (by kind + id) — normalized. */
export async function loadRecordsByKeys(db: Db, workspaceId: string, keys: { kind: ContactRecordKind; id: string }[]): Promise<Map<string, PersonRecord>> {
  const ids = (k: ContactRecordKind) => keys.filter((x) => x.kind === k).map((x) => x.id);
  const out = new Map<string, PersonRecord>();
  const [leads, contacts, persons, funding] = await Promise.all([
    ids("lead").length ? db.lead.findMany({ where: { workspaceId, id: { in: ids("lead") } }, select: { id: true, name: true, email: true, phone: true, company: true, title: true, updatedAt: true } }) : [],
    ids("ops_contact").length
      ? db.opsContact.findMany({ where: { workspaceId, id: { in: ids("ops_contact") } }, select: { id: true, name: true, email: true, phone: true, title: true, updatedAt: true, company: { select: { name: true } } } })
      : [],
    ids("connector_person").length ? db.connectorPerson.findMany({ where: { workspaceId, id: { in: ids("connector_person") } }, select: { id: true, name: true, handles: true, roles: true, updatedAt: true } }) : [],
    ids("funding_contact").length ? db.fundingContact.findMany({ where: { workspaceId, id: { in: ids("funding_contact") } }, select: { id: true, name: true, role: true, handle: true, updatedAt: true } }) : [],
  ]);
  for (const l of leads) out.set(`lead:${l.id}`, { kind: "lead", id: l.id, name: l.name, emails: emailsIn([l.email]), phones: l.phone ? [l.phone] : [], company: l.company, title: l.title, updatedAt: l.updatedAt });
  for (const c of contacts)
    out.set(`ops_contact:${c.id}`, { kind: "ops_contact", id: c.id, name: c.name, emails: emailsIn([c.email]), phones: c.phone ? [c.phone] : [], company: c.company?.name ?? null, title: c.title, updatedAt: c.updatedAt });
  for (const p of persons)
    out.set(`connector_person:${p.id}`, { kind: "connector_person", id: p.id, name: p.name, emails: emailsIn(p.handles), phones: p.handles.filter((h) => PHONE_HANDLE_RE.test(h.trim())), company: null, title: p.roles[0] ?? null, updatedAt: p.updatedAt });
  for (const f of funding)
    out.set(`funding_contact:${f.id}`, { kind: "funding_contact", id: f.id, name: f.name, emails: emailsIn([f.handle]), phones: [], company: null, title: f.role, updatedAt: f.updatedAt });
  return out;
}

function cardOf(i: { id: string; displayName: string; emails: string[]; phones: string[]; companies: string[]; recordCount: number; updatedAt: Date }, kinds: ContactRecordKind[]): IdentityCard {
  return { id: i.id, name: i.displayName, emails: i.emails, phones: i.phones, companies: i.companies, recordCount: i.recordCount, kinds, updatedAt: i.updatedAt.toISOString() };
}

/** One person: every linked record, the timeline across them, and pending suggestions about them. */
export async function getIdentityDetail(db: Db, workspaceId: string, identityId: string, viewerUserId: string | null = null): Promise<IdentityDetail> {
  const identity = await db.contactIdentity.findFirst({ where: { id: identityId, workspaceId } });
  if (!identity) throw new ContactsError(404, "Contact not found.");
  const recs = await recordsOf(db, workspaceId, identityId);
  const records: LinkedRecordView[] = recs.map(({ r, link }) => ({
    kind: r.kind,
    id: r.id,
    name: r.name,
    emails: r.emails,
    phones: r.phones,
    company: r.company,
    title: r.title,
    href: recordHref(r.kind, r.id),
    linkedVia: link.linkedVia,
    confirmedAt: link.confirmedAt ? link.confirmedAt.toISOString() : null,
  }));
  const timeline = await identityTimeline(db, workspaceId, recs.map((x) => x.r), 60, viewerUserId);
  const suggestions = (await listSuggestions(db, { workspaceId, status: "pending", identityId, limit: 20 })).items;
  return { identity: cardOf(identity, [...new Set(records.map((r) => r.kind))]), records, timeline, suggestions };
}

/**
 * The person's timeline across the existing activity sources: CRM messages
 * (email / SMS ledger) and lead activity, bookings and calls, Ops deals,
 * tickets and invoices, funding interactions, and cached mail threads that
 * include one of their addresses. Newest first, bounded.
 */
/**
 * The timeline across a person's linked records. Cached Gmail / Outlook
 * threads are PERSONAL: they appear only for their owner (viewerUserId), and
 * not at all without one.
 */
export async function identityTimeline(db: Db, workspaceId: string, records: PersonRecord[], limit = 60, viewerUserId: string | null = null): Promise<TimelineItem[]> {
  const leadIds = records.filter((r) => r.kind === "lead").map((r) => r.id);
  const contactIds = records.filter((r) => r.kind === "ops_contact").map((r) => r.id);
  const fundingIds = records.filter((r) => r.kind === "funding_contact").map((r) => r.id);
  const emails = [...new Set(records.flatMap((r) => r.emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e)))];
  const take = 25;
  const none = Promise.resolve([] as never[]);
  const [messages, activities, bookings, calls, deals, tickets, invoices, interactions, mail] = await Promise.all([
    leadIds.length
      ? db.outboundMessage.findMany({ where: { workspaceId, leadId: { in: leadIds } }, orderBy: { createdAt: "desc" }, take, select: { id: true, leadId: true, channel: true, direction: true, subject: true, body: true, status: true, createdAt: true } })
      : none,
    leadIds.length ? db.leadActivity.findMany({ where: { workspaceId, leadId: { in: leadIds } }, orderBy: { createdAt: "desc" }, take, select: { id: true, leadId: true, type: true, body: true, createdAt: true } }) : none,
    leadIds.length || emails.length
      ? db.booking.findMany({
          where: { workspaceId, OR: [...(leadIds.length ? [{ leadId: { in: leadIds } }] : []), ...(emails.length ? [{ email: { in: emails, mode: "insensitive" as const } }] : [])] },
          orderBy: { startAt: "desc" },
          take,
          select: { id: true, startAt: true, status: true, page: { select: { title: true } } },
        })
      : none,
    leadIds.length ? db.call.findMany({ where: { workspaceId, leadId: { in: leadIds } }, orderBy: { startedAt: "desc" }, take, select: { id: true, startedAt: true, direction: true, status: true, durationSec: true, summary: true } }) : none,
    leadIds.length || contactIds.length
      ? db.opsDeal.findMany({
          where: { workspaceId, OR: [...(leadIds.length ? [{ leadId: { in: leadIds } }] : []), ...(contactIds.length ? [{ contactId: { in: contactIds } }] : [])] },
          orderBy: { updatedAt: "desc" },
          take,
          select: { id: true, title: true, stage: true, status: true, valueCents: true, updatedAt: true },
        })
      : none,
    contactIds.length || emails.length
      ? db.opsTicket.findMany({
          where: { workspaceId, OR: [...(contactIds.length ? [{ contactId: { in: contactIds } }] : []), ...(emails.length ? [{ requesterEmail: { in: emails, mode: "insensitive" as const } }] : [])] },
          orderBy: { lastMessageAt: "desc" },
          take,
          select: { id: true, number: true, subject: true, status: true, lastMessageAt: true },
        })
      : none,
    leadIds.length || emails.length
      ? db.opsInvoice.findMany({
          where: { workspaceId, OR: [...(leadIds.length ? [{ customerId: { in: leadIds } }] : []), ...(emails.length ? [{ customerEmail: { in: emails, mode: "insensitive" as const } }] : [])] },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, number: true, status: true, totalCents: true, createdAt: true },
        })
      : none,
    fundingIds.length ? db.fundingInteraction.findMany({ where: { workspaceId, contactId: { in: fundingIds } }, orderBy: { occurredAt: "desc" }, take, select: { id: true, kind: true, summary: true, occurredAt: true } }) : none,
    emails.length && viewerUserId
      ? db.mailThreadCache.findMany({ where: { workspaceId, ownerUserId: viewerUserId, participants: { hasSome: emails } }, orderBy: { lastMessageAt: "desc" }, take, select: { id: true, source: true, subject: true, lastMessageAt: true, connectionId: true, externalId: true } })
      : none,
  ]);
  const items: TimelineItem[] = [];
  for (const m of messages)
    items.push({
      key: `msg:${m.id}`,
      at: m.createdAt.toISOString(),
      type: m.channel === "sms" ? "sms" : "mail",
      title: `${m.direction === "inbound" ? "←" : "→"} ${m.subject?.trim() || m.body.replace(/\s+/g, " ").slice(0, 80)}`,
      detail: m.status,
      href: m.leadId ? `/dashboard/mail?thread=${encodeURIComponent(`crm:${m.leadId}`)}` : null,
    });
  for (const a of activities) items.push({ key: `act:${a.id}`, at: a.createdAt.toISOString(), type: "note", title: String(a.type).replace(/_/g, " "), detail: a.body ?? null, href: `/dashboard/crm?lead=${encodeURIComponent(a.leadId)}` });
  for (const b of bookings) items.push({ key: `bk:${b.id}`, at: b.startAt.toISOString(), type: "meeting", title: b.page?.title ?? "Booking", detail: b.status, href: "/dashboard/calendar" });
  for (const c of calls) items.push({ key: `call:${c.id}`, at: c.startedAt.toISOString(), type: "call", title: `${c.direction === "inbound" ? "Inbound" : "Outbound"} call · ${Math.round(c.durationSec / 60)} min`, detail: c.summary ?? c.status, href: "/dashboard/calls" });
  for (const d of deals) items.push({ key: `deal:${d.id}`, at: d.updatedAt.toISOString(), type: "deal", title: d.title, detail: `${d.stage} · ${d.status}`, href: `/dashboard/crm?tab=deals&deal=${encodeURIComponent(d.id)}` });
  for (const t of tickets) items.push({ key: `tk:${t.id}`, at: t.lastMessageAt.toISOString(), type: "ticket", title: `#${t.number} ${t.subject}`, detail: t.status, href: `/dashboard/ops/helpdesk?ticket=${encodeURIComponent(t.id)}` });
  for (const i of invoices)
    items.push({ key: `inv:${i.id}`, at: i.createdAt.toISOString(), type: "invoice", title: i.number ?? "Draft invoice", detail: `${i.status} · ${(i.totalCents / 100).toFixed(2)}`, href: `/dashboard/ops/invoices?invoice=${encodeURIComponent(i.id)}` });
  for (const f of interactions) items.push({ key: `fi:${f.id}`, at: f.occurredAt.toISOString(), type: "funding", title: f.summary, detail: String(f.kind), href: "/dashboard/funding" });
  for (const t of mail)
    items.push({ key: `mail:${t.id}`, at: t.lastMessageAt.toISOString(), type: "mail", title: t.subject, detail: t.source, href: `/dashboard/mail?thread=${encodeURIComponent(`${t.source}:${t.connectionId}:${t.externalId}`)}` });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** The identity a record belongs to (linking it on the fly when the sync has not seen it yet). */
export async function identityForRecord(db: Db, workspaceId: string, kind: ContactRecordKind, id: string): Promise<string> {
  const link = await db.contactIdentityLink.findFirst({ where: { workspaceId, recordKind: kind, recordId: id }, select: { identityId: true } });
  if (link) return link.identityId;
  const rec = (await loadRecordsByKeys(db, workspaceId, [{ kind, id }])).get(`${kind}:${id}`);
  if (!rec) throw new ContactsError(404, "Contact not found.");
  const s = identitySummary([rec]);
  const identity = await db.contactIdentity.create({ data: { workspaceId, displayName: s.displayName.slice(0, 300), emails: s.emails, phones: s.phones, companies: s.companies, recordCount: 1 }, select: { id: true } });
  await db.contactIdentityLink.create({ data: { workspaceId, identityId: identity.id, recordKind: kind, recordId: id, linkedVia: "sync" } });
  return identity.id;
}

// ---------------------------------------------------------------------------
// Suggestions: list, propose (agent / person), confirm (merge), reject
// ---------------------------------------------------------------------------

export interface SuggestionSide {
  kind: ContactRecordKind;
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string | null;
  href: string;
  identityId: string | null;
}

export interface SuggestionView {
  id: string;
  score: number;
  reasons: EvidenceReason[];
  status: string;
  proposedVia: string;
  a: SuggestionSide;
  b: SuggestionSide;
  createdAt: string;
}

export async function listSuggestions(
  db: Db,
  opts: { workspaceId: string; status?: "pending" | "confirmed" | "rejected"; identityId?: string; limit?: number },
): Promise<{ items: SuggestionView[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let filter: Prisma.ContactMergeSuggestionWhereInput = { workspaceId: opts.workspaceId, status: opts.status ?? "pending" };
  if (opts.identityId) {
    const links = await db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: opts.identityId }, select: { recordKind: true, recordId: true } });
    if (!links.length) return { items: [], total: 0 };
    const sides = links.map((l) => ({ kind: l.recordKind, id: l.recordId }));
    filter = { ...filter, OR: [...sides.map((s) => ({ aKind: s.kind, aId: s.id })), ...sides.map((s) => ({ bKind: s.kind, bId: s.id }))] };
  }
  const [rows, total] = await Promise.all([
    db.contactMergeSuggestion.findMany({ where: { ...filter, workspaceId: opts.workspaceId }, orderBy: [{ score: "desc" }, { createdAt: "asc" }], take: limit }),
    db.contactMergeSuggestion.count({ where: { ...filter, workspaceId: opts.workspaceId } }),
  ]);
  const keys = rows.flatMap((r) => [
    { kind: r.aKind as ContactRecordKind, id: r.aId },
    { kind: r.bKind as ContactRecordKind, id: r.bId },
  ]);
  const recs = await loadRecordsByKeys(db, opts.workspaceId, keys.filter((k) => isContactRecordKind(k.kind)));
  const links = keys.length
    ? await db.contactIdentityLink.findMany({
        where: { workspaceId: opts.workspaceId, OR: keys.map((k) => ({ recordKind: k.kind, recordId: k.id })) },
        select: { recordKind: true, recordId: true, identityId: true },
      })
    : [];
  const idOf = new Map(links.map((l) => [`${l.recordKind}:${l.recordId}`, l.identityId]));
  const side = (kind: string, id: string): SuggestionSide | null => {
    const r = recs.get(`${kind}:${id}`);
    if (!r) return null;
    return { kind: r.kind, id: r.id, name: r.name, emails: r.emails, phones: r.phones, company: r.company, href: recordHref(r.kind, r.id), identityId: idOf.get(`${kind}:${id}`) ?? null };
  };
  const items: SuggestionView[] = [];
  for (const r of rows) {
    const a = side(r.aKind, r.aId);
    const b = side(r.bKind, r.bId);
    if (!a || !b) continue;
    items.push({ id: r.id, score: r.score, reasons: r.reasons as EvidenceReason[], status: r.status, proposedVia: r.proposedVia, a, b, createdAt: r.createdAt.toISOString() });
  }
  return { items, total };
}

/**
 * Propose that two records are one person (an agent's suggest_merge, or a
 * person's "Merge with…"). Never merges. A pair a person rejected before is
 * refused; an already-merged pair is a no-op.
 */
export async function proposeMerge(
  db: Db,
  opts: { workspaceId: string; a: { kind: ContactRecordKind; id: string }; b: { kind: ContactRecordKind; id: string }; via: "agent" | "person" },
): Promise<{ suggestion: SuggestionView | null; outcome: "proposed" | "already_merged" | "previously_rejected" | "exists" }> {
  if (recordKey(opts.a) === recordKey(opts.b)) throw new ContactsError(400, "Pick two different records.");
  const recs = await loadRecordsByKeys(db, opts.workspaceId, [opts.a, opts.b]);
  const ra = recs.get(recordKey(opts.a));
  const rb = recs.get(recordKey(opts.b));
  if (!ra || !rb) throw new ContactsError(404, "Contact not found.");
  const ia = await identityForRecord(db, opts.workspaceId, ra.kind, ra.id);
  const ib = await identityForRecord(db, opts.workspaceId, rb.kind, rb.id);
  if (ia === ib) return { suggestion: null, outcome: "already_merged" };
  // A rejection between any records of the two identities is remembered.
  const [la, lb] = await Promise.all([
    db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: ia }, select: { recordKind: true, recordId: true } }),
    db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: ib }, select: { recordKind: true, recordId: true } }),
  ]);
  const pairsOr = la.flatMap((x) =>
    lb.flatMap((y) => {
      const [p, q] = orderPair({ kind: x.recordKind, id: x.recordId }, { kind: y.recordKind, id: y.recordId });
      return [{ aKind: p.kind, aId: p.id, bKind: q.kind, bId: q.id }];
    }),
  );
  if (pairsOr.length && (await db.contactMergeSuggestion.count({ where: { workspaceId: opts.workspaceId, status: "rejected", OR: pairsOr.slice(0, 400) } })) > 0) {
    return { suggestion: null, outcome: "previously_rejected" };
  }
  const [p, q] = orderPair(ra, rb);
  const key = { workspaceId: opts.workspaceId, aKind: p.kind, aId: p.id, bKind: q.kind, bId: q.id };
  const evidence = compareRecords(p, q);
  const existing = await db.contactMergeSuggestion.findUnique({ where: { workspaceId_aKind_aId_bKind_bId: key } });
  if (existing?.status === "pending") {
    const view = (await listSuggestions(db, { workspaceId: opts.workspaceId, identityId: ia, limit: 200 })).items.find((s) => s.id === existing.id) ?? null;
    return { suggestion: view, outcome: "exists" };
  }
  const row = existing
    ? await db.contactMergeSuggestion.update({ where: { id: existing.id, workspaceId: opts.workspaceId }, data: { status: "pending", score: evidence.score, reasons: evidence.reasons, proposedVia: opts.via, decidedBy: null, decidedAt: null } })
    : await db.contactMergeSuggestion.create({ data: { ...key, score: evidence.score, reasons: evidence.reasons, status: "pending", proposedVia: opts.via } });
  const view = (await listSuggestions(db, { workspaceId: opts.workspaceId, identityId: ia, limit: 200 })).items.find((s) => s.id === row.id) ?? null;
  return { suggestion: view, outcome: "proposed" };
}

async function refreshIdentity(db: Db, workspaceId: string, identityId: string): Promise<void> {
  const recs = await recordsOf(db, workspaceId, identityId);
  if (!recs.length) {
    await db.contactIdentity.deleteMany({ where: { workspaceId, id: identityId } });
    return;
  }
  const s = identitySummary(recs.map((x) => x.r));
  await db.contactIdentity.update({
    where: { id: identityId, workspaceId },
    data: { displayName: s.displayName.slice(0, 300), emails: s.emails, phones: s.phones, companies: s.companies, recordCount: recs.length },
  });
}

/**
 * A person confirms a pending suggestion: the two identities become one (all
 * of B's links move to A, stamped with who confirmed and when). The only
 * place identities merge.
 */
export async function confirmSuggestion(db: Db, opts: { workspaceId: string; suggestionId: string; userId: string; now?: Date }): Promise<{ identityId: string }> {
  const now = opts.now ?? new Date();
  const s = await db.contactMergeSuggestion.findFirst({ where: { id: opts.suggestionId, workspaceId: opts.workspaceId } });
  if (!s) throw new ContactsError(404, "Suggestion not found.");
  if (s.status !== "pending") throw new ContactsError(409, `This suggestion was already ${s.status}.`);
  if (!isContactRecordKind(s.aKind) || !isContactRecordKind(s.bKind)) throw new ContactsError(400, "Unknown record kind.");
  const ia = await identityForRecord(db, opts.workspaceId, s.aKind, s.aId);
  const ib = await identityForRecord(db, opts.workspaceId, s.bKind, s.bId);
  if (ia !== ib) {
    await db.contactIdentityLink.updateMany({ where: { workspaceId: opts.workspaceId, identityId: ib }, data: { identityId: ia } });
    await db.contactIdentity.deleteMany({ where: { workspaceId: opts.workspaceId, id: ib } });
  }
  // Both sides of the confirmed pair are now person-confirmed links.
  for (const side of [
    { kind: s.aKind, id: s.aId },
    { kind: s.bKind, id: s.bId },
  ]) {
    await db.contactIdentityLink.updateMany({
      where: { workspaceId: opts.workspaceId, recordKind: side.kind, recordId: side.id },
      data: { linkedVia: "merge", confirmedBy: opts.userId, confirmedAt: now },
    });
  }
  await db.contactMergeSuggestion.update({ where: { id: s.id, workspaceId: opts.workspaceId }, data: { status: "confirmed", decidedBy: opts.userId, decidedAt: now } });
  await refreshIdentity(db, opts.workspaceId, ia);
  return { identityId: ia };
}

/** A person says "not the same person": remembered for this record pair. */
export async function rejectSuggestion(db: Db, opts: { workspaceId: string; suggestionId: string; userId: string; now?: Date }): Promise<void> {
  const s = await db.contactMergeSuggestion.findFirst({ where: { id: opts.suggestionId, workspaceId: opts.workspaceId } });
  if (!s) throw new ContactsError(404, "Suggestion not found.");
  if (s.status !== "pending") throw new ContactsError(409, `This suggestion was already ${s.status}.`);
  const now = opts.now ?? new Date();
  await db.contactMergeSuggestion.update({ where: { id: s.id, workspaceId: opts.workspaceId }, data: { status: "rejected", decidedBy: opts.userId, decidedAt: now } });
  // "Not the same person" is about the two PEOPLE: remember it for every
  // record pair across them, so it holds even if one of them is later split.
  if (!isContactRecordKind(s.aKind) || !isContactRecordKind(s.bKind)) return;
  const ia = await identityForRecord(db, opts.workspaceId, s.aKind, s.aId);
  const ib = await identityForRecord(db, opts.workspaceId, s.bKind, s.bId);
  if (ia === ib) return;
  const [la, lb] = await Promise.all([
    db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: ia }, select: { recordKind: true, recordId: true } }),
    db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: ib }, select: { recordKind: true, recordId: true } }),
  ]);
  for (const x of la.slice(0, 50)) {
    for (const y of lb.slice(0, 50)) {
      const [p, q] = orderPair({ kind: x.recordKind, id: x.recordId }, { kind: y.recordKind, id: y.recordId });
      const key = { workspaceId: opts.workspaceId, aKind: p.kind, aId: p.id, bKind: q.kind, bId: q.id };
      await db.contactMergeSuggestion.upsert({
        where: { workspaceId_aKind_aId_bKind_bId: key },
        create: { ...key, score: 0, reasons: [], status: "rejected", proposedVia: "person", decidedBy: opts.userId, decidedAt: now },
        update: { status: "rejected", decidedBy: opts.userId, decidedAt: now },
      });
    }
  }
}

/**
 * Take one record back out of a merged identity (it gets its own again), and
 * remember that it is not the same person as the rest — so the sync never
 * suggests that pair again.
 */
export async function unlinkRecord(db: Db, opts: { workspaceId: string; identityId: string; kind: ContactRecordKind; id: string; userId: string; now?: Date }): Promise<{ identityId: string }> {
  const now = opts.now ?? new Date();
  const link = await db.contactIdentityLink.findFirst({ where: { workspaceId: opts.workspaceId, identityId: opts.identityId, recordKind: opts.kind, recordId: opts.id } });
  if (!link) throw new ContactsError(404, "That record is not part of this contact.");
  const others = await db.contactIdentityLink.findMany({ where: { workspaceId: opts.workspaceId, identityId: opts.identityId, NOT: { id: link.id } }, select: { recordKind: true, recordId: true } });
  if (!others.length) throw new ContactsError(400, "A contact's only record can't be unlinked.");
  const recs = await loadRecordsByKeys(db, opts.workspaceId, [{ kind: opts.kind, id: opts.id }]);
  const rec = recs.get(`${opts.kind}:${opts.id}`);
  const s = identitySummary(rec ? [rec] : []);
  const fresh = await db.contactIdentity.create({ data: { workspaceId: opts.workspaceId, displayName: s.displayName.slice(0, 300), emails: s.emails, phones: s.phones, companies: s.companies, recordCount: 1 }, select: { id: true } });
  await db.contactIdentityLink.update({ where: { id: link.id, workspaceId: opts.workspaceId }, data: { identityId: fresh.id, linkedVia: "sync", confirmedBy: null, confirmedAt: null } });
  for (const o of others) {
    const [p, q] = orderPair({ kind: opts.kind as string, id: opts.id }, { kind: o.recordKind, id: o.recordId });
    const key = { workspaceId: opts.workspaceId, aKind: p.kind, aId: p.id, bKind: q.kind, bId: q.id };
    await db.contactMergeSuggestion.upsert({
      where: { workspaceId_aKind_aId_bKind_bId: key },
      create: { ...key, score: 0, reasons: [], status: "rejected", proposedVia: "person", decidedBy: opts.userId, decidedAt: now },
      update: { status: "rejected", decidedBy: opts.userId, decidedAt: now },
    });
  }
  await refreshIdentity(db, opts.workspaceId, opts.identityId);
  return { identityId: fresh.id };
}

/** Find people by name / email / phone / company (find_contact, the Mail app's recipient picker). */
export async function findContacts(db: Db, workspaceId: string, q: string, limit = 10): Promise<IdentityCard[]> {
  return (await listIdentities(db, { workspaceId, q, limit })).items;
}
