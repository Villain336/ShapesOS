// ShapesOS — Phase 11 (conncore): HubSpot ↔ Ops CRM bidirectional sync.
//
// PULL (sync_from_hubspot): HubSpot companies → OpsCompany, contacts →
// OpsContact (with their company), deals → OpsDeal (on a local pipeline that
// mirrors the HubSpot deal pipeline, with its contact/company). Every mapped
// object has ONE hubspot_sync_links row (unique on both ids), so a re-sync
// never duplicates; an unmapped HubSpot record first dedupes onto an existing
// local one (contact by email, company by domain) before creating.
//
// PUSH (push_to_hubspot, a gated write): one local contact / company / deal
// is created or updated in HubSpot (and associated to its linked company /
// contact), then linked.
//
// CONFLICT RULE (documented; asserted in lib/hubspot/__tests__):
//   Each link remembers HubSpot's updatedAt and the local row's updatedAt as
//   of the last sync. "Changed" = newer than that remembered value.
//   - only HubSpot changed  → pull applies HubSpot's values;
//   - only local changed    → pull leaves the record (reported "local_ahead";
//                             push it to send the change);
//   - both changed          → LAST WRITER WINS by timestamp: the side with
//                             the newer updatedAt is kept; a pull reports it
//                             as a conflict either way, a push of an older
//                             local record is refused unless force=true;
//   - neither changed       → nothing to do.
//   A first match (no link yet) treats the two records as both changed.
//   Only mapped fields are written; an empty HubSpot value never erases a
//   local one; a unique clash (another local contact already has that email)
//   keeps the local value and is reported.
//
// Deal stages: HubSpot "closed won" (probability 1) ↔ local "won", "closed
// lost" (probability 0) ↔ local "lost" (so OpsDeal.status follows), every
// other stage ↔ local "hs-<stage id>"; the mirror pipeline's stages JSON
// carries each stage's hubspotStageId for the push back.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { LiveDeps, TokenSource } from "@/lib/connectors/m21/live/http";
import { normalizeDomain, normalizeEmail, dealStatusForStage } from "@/lib/ops/crm";
import {
  hubspotAssociate,
  hubspotCreate,
  hubspotDealPipelines,
  hubspotGet,
  hubspotListPage,
  hubspotUpdate,
  type HubspotObject,
  type HubspotObjectType,
  type HubspotPipeline,
} from "./api";

export type SyncObjectType = "contact" | "company" | "deal";
const HS_TYPE: Record<SyncObjectType, HubspotObjectType> = { contact: "contacts", company: "companies", deal: "deals" };

// ---------------------------------------------------------------------------
// Conflict rule (PURE)
// ---------------------------------------------------------------------------

export type SyncDecision = "apply" | "skip_unchanged" | "local_ahead" | "conflict_hubspot_wins" | "conflict_local_wins";

export interface LinkTimes {
  hubspotUpdatedAt: Date | null;
  localUpdatedAt: Date | null;
}

/** What a pull does with one already-local record. PURE. */
export function decidePull(link: LinkTimes | null, hubspotUpdatedAt: Date, localUpdatedAt: Date): SyncDecision {
  const hsChanged = !link?.hubspotUpdatedAt || hubspotUpdatedAt.getTime() > link.hubspotUpdatedAt.getTime();
  const localChanged = !link?.localUpdatedAt || localUpdatedAt.getTime() > link.localUpdatedAt.getTime();
  if (hsChanged && !localChanged) return "apply";
  if (!hsChanged && localChanged) return "local_ahead";
  if (!hsChanged && !localChanged) return "skip_unchanged";
  return hubspotUpdatedAt.getTime() >= localUpdatedAt.getTime() ? "conflict_hubspot_wins" : "conflict_local_wins";
}

/** Whether a push may overwrite HubSpot. PURE. */
export function pushAllowed(link: LinkTimes | null, hubspotUpdatedAt: Date | null, localUpdatedAt: Date, force: boolean): boolean {
  if (force || !link || !hubspotUpdatedAt) return true;
  const hsChanged = !link.hubspotUpdatedAt || hubspotUpdatedAt.getTime() > link.hubspotUpdatedAt.getTime();
  if (!hsChanged) return true;
  return localUpdatedAt.getTime() > hubspotUpdatedAt.getTime();
}

// ---------------------------------------------------------------------------
// Field mapping (PURE)
// ---------------------------------------------------------------------------

const val = (o: HubspotObject, k: string) => {
  const v = o.properties[k];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

export function contactFromHubspot(o: HubspotObject): { name: string; email: string | null; phone: string | null; title: string | null } {
  const email = normalizeEmail(val(o, "email"));
  const name = [val(o, "firstname"), val(o, "lastname")].filter(Boolean).join(" ") || email || `HubSpot contact ${o.id}`;
  return { name: name.slice(0, 200), email, phone: val(o, "phone"), title: val(o, "jobtitle") };
}

export function companyFromHubspot(o: HubspotObject): { name: string; domain: string | null; website: string | null; phone: string | null; industry: string | null } {
  const domain = normalizeDomain(val(o, "domain") ?? val(o, "website"));
  return {
    name: (val(o, "name") ?? domain ?? `HubSpot company ${o.id}`).slice(0, 200),
    domain,
    website: val(o, "website"),
    phone: val(o, "phone"),
    industry: val(o, "industry"),
  };
}

/** Local stage id for a HubSpot stage. PURE. */
export function localStageId(stage: { id: string; isClosed: boolean; probability: number | null }): string {
  if (stage.isClosed && stage.probability === 1) return "won";
  if (stage.isClosed && stage.probability === 0) return "lost";
  return `hs-${stage.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}`;
}

export interface MirrorStage {
  id: string;
  label: string;
  hubspotStageId: string;
}

export function mirrorStages(p: HubspotPipeline): MirrorStage[] {
  const out: MirrorStage[] = [];
  for (const s of p.stages) {
    const id = localStageId(s);
    if (!out.some((x) => x.id === id)) out.push({ id, label: s.label.slice(0, 80), hubspotStageId: s.id });
  }
  return out;
}

export function dealFromHubspot(o: HubspotObject): { title: string; valueCents: number; hubspotStage: string | null; hubspotPipeline: string | null; expectedCloseAt: Date | null } {
  const amount = Number(val(o, "amount") ?? "0");
  const close = val(o, "closedate");
  const closeAt = close ? new Date(close) : null;
  return {
    title: (val(o, "dealname") ?? `HubSpot deal ${o.id}`).slice(0, 200),
    valueCents: Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0,
    hubspotStage: val(o, "dealstage"),
    hubspotPipeline: val(o, "pipeline"),
    expectedCloseAt: closeAt && !Number.isNaN(closeAt.getTime()) ? closeAt : null,
  };
}

const clean = (props: Record<string, string | null | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(props).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));

export function contactToHubspot(c: { name: string; email: string | null; phone: string | null; title: string | null }): Record<string, string> {
  const [first, ...rest] = c.name.trim().split(/\s+/);
  return clean({ email: c.email, firstname: first, lastname: rest.join(" ") || undefined, phone: c.phone, jobtitle: c.title });
}

export function companyToHubspot(c: { name: string; domain: string | null; website: string | null; phone: string | null; industry: string | null }): Record<string, string> {
  return clean({ name: c.name, domain: c.domain, website: c.website, phone: c.phone, industry: c.industry });
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface SyncReport {
  created: number;
  updated: number;
  linked: number;
  unchanged: number;
  localAhead: number;
  conflicts: Array<{ objectType: SyncObjectType | "pipeline"; hubspotId: string; localId: string | null; resolution: string }>;
  pages: number;
  truncated: boolean;
}

const emptyReport = (): SyncReport => ({ created: 0, updated: 0, linked: 0, unchanged: 0, localAhead: 0, conflicts: [], pages: 0, truncated: false });

type Tx = Parameters<Parameters<typeof withWorkspaceScope>[1]>[0];

async function findLink(tx: Tx, workspaceId: string, objectType: string, by: { hubspotId?: string; localId?: string }) {
  return tx.hubspotSyncLink.findFirst({ where: { workspaceId, objectType, ...by } });
}

async function saveLink(
  tx: Tx,
  workspaceId: string,
  objectType: string,
  hubspotId: string,
  localId: string,
  times: { hubspotUpdatedAt: Date | null; localUpdatedAt: Date | null },
  direction: "pull" | "push",
) {
  await tx.hubspotSyncLink.upsert({
    where: { workspaceId_objectType_hubspotId: { workspaceId, objectType, hubspotId } },
    create: { workspaceId, objectType, hubspotId, localId, ...times, lastDirection: direction },
    update: { localId, ...times, lastDirection: direction },
  });
}

const isUnique = (err: unknown) => (err as { code?: unknown })?.code === "P2002";

export interface PullOptions {
  objectTypes?: SyncObjectType[];
  /** Pages of 100 per object type (default 20 → up to 2,000 records each). */
  maxPages?: number;
  /** The member running the sync (deal owner for new deals). */
  userId: string;
}

async function pullPipelines(workspaceId: string, auth: TokenSource, deps: LiveDeps, report: SyncReport): Promise<Map<string, { localId: string; stages: MirrorStage[] }>> {
  const map = new Map<string, { localId: string; stages: MirrorStage[] }>();
  for (const p of await hubspotDealPipelines(auth, deps)) {
    const stages = mirrorStages(p);
    if (stages.length === 0) continue;
    const localId = await withWorkspaceScope(workspaceId, async (tx) => {
      const link = await findLink(tx, workspaceId, "pipeline", { hubspotId: p.id });
      const existing = link ? await tx.pipeline.findFirst({ where: { id: link.localId, workspaceId } }) : null;
      const data = { name: `HubSpot: ${p.label}`.slice(0, 120), stages: stages as unknown as object };
      const row = existing
        ? await tx.pipeline.update({ where: { id: existing.id }, data })
        : await tx.pipeline.create({ data: { workspaceId, ...data } });
      await saveLink(tx, workspaceId, "pipeline", p.id, row.id, { hubspotUpdatedAt: null, localUpdatedAt: row.updatedAt }, "pull");
      if (!existing) report.created += 1;
      return row.id;
    });
    map.set(p.id, { localId, stages });
  }
  return map;
}

async function eachPage(
  auth: TokenSource,
  type: HubspotObjectType,
  maxPages: number,
  deps: LiveDeps,
  report: SyncReport,
  fn: (o: HubspotObject) => Promise<void>,
): Promise<void> {
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await hubspotListPage(auth, type, { after, limit: 100 }, deps);
    report.pages += 1;
    for (const o of res.results) if (o.id && !o.archived) await fn(o);
    after = res.after;
    if (!after) return;
  }
  if (after) report.truncated = true;
}

/** Apply one HubSpot record to its local row per the conflict rule. */
async function applyRecord<L extends { id: string; updatedAt: Date }>(input: {
  tx: Tx;
  workspaceId: string;
  objectType: SyncObjectType;
  o: HubspotObject;
  report: SyncReport;
  findLocal: (link: { localId: string } | null) => Promise<L | null>;
  create: () => Promise<L>;
  update: (local: L) => Promise<L>;
}): Promise<L | null> {
  const { tx, workspaceId, objectType, o, report } = input;
  const hsAt = new Date(o.updatedAt || Date.now());
  const link = await findLink(tx, workspaceId, objectType, { hubspotId: o.id });
  const local = await input.findLocal(link);
  if (!local) {
    const created = await input.create();
    await saveLink(tx, workspaceId, objectType, o.id, created.id, { hubspotUpdatedAt: hsAt, localUpdatedAt: created.updatedAt }, "pull");
    report.created += 1;
    return created;
  }
  if (!link) {
    // A dedupe match must not already belong to another HubSpot record.
    const taken = await findLink(tx, workspaceId, objectType, { localId: local.id });
    if (taken) {
      report.conflicts.push({ objectType, hubspotId: o.id, localId: local.id, resolution: `already linked to HubSpot ${taken.hubspotId}; skipped` });
      return null;
    }
    report.linked += 1;
  }
  const decision = decidePull(link, hsAt, local.updatedAt);
  if (decision === "skip_unchanged") {
    report.unchanged += 1;
    return local;
  }
  if (decision === "local_ahead" || decision === "conflict_local_wins") {
    if (decision === "local_ahead") report.localAhead += 1;
    else report.conflicts.push({ objectType, hubspotId: o.id, localId: local.id, resolution: "local is newer — kept local (push it to update HubSpot)" });
    if (!link) await saveLink(tx, workspaceId, objectType, o.id, local.id, { hubspotUpdatedAt: hsAt, localUpdatedAt: null }, "pull");
    return local;
  }
  if (decision === "conflict_hubspot_wins") {
    report.conflicts.push({ objectType, hubspotId: o.id, localId: local.id, resolution: "HubSpot is newer — applied HubSpot's values" });
  }
  const updated = await input.update(local);
  await saveLink(tx, workspaceId, objectType, o.id, updated.id, { hubspotUpdatedAt: hsAt, localUpdatedAt: updated.updatedAt }, "pull");
  report.updated += 1;
  return updated;
}

/** Only fields HubSpot actually has (an empty HubSpot value never erases a local one). */
const present = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

export async function pullFromHubspot(workspaceId: string, auth: TokenSource, opts: PullOptions, deps: LiveDeps = {}): Promise<SyncReport> {
  const report = emptyReport();
  const types = new Set(opts.objectTypes?.length ? opts.objectTypes : (["company", "contact", "deal"] as SyncObjectType[]));
  const maxPages = Math.min(Math.max(Math.floor(opts.maxPages ?? 20), 1), 100);
  const companyLocal = async (tx: Tx, hubspotId: string) => (await findLink(tx, workspaceId, "company", { hubspotId }))?.localId ?? null;

  if (types.has("company")) {
    await eachPage(auth, "companies", maxPages, deps, report, (o) =>
      withWorkspaceScope(workspaceId, async (tx) => {
        const f = companyFromHubspot(o);
        await applyRecord({
          tx, workspaceId, objectType: "company", o, report,
          findLocal: async (link) =>
            link
              ? tx.opsCompany.findFirst({ where: { id: link.localId, workspaceId } })
              : f.domain
                ? tx.opsCompany.findFirst({ where: { workspaceId, domain: f.domain } })
                : null,
          create: () => tx.opsCompany.create({ data: { workspaceId, ...f } }),
          update: async (local) => {
            try {
              return await tx.opsCompany.update({ where: { id: local.id }, data: present(f) });
            } catch (err) {
              if (!isUnique(err)) throw err;
              report.conflicts.push({ objectType: "company", hubspotId: o.id, localId: local.id, resolution: "domain used by another local company; kept the local domain" });
              const { domain: _d, ...rest } = f;
              void _d;
              return tx.opsCompany.update({ where: { id: local.id }, data: present(rest) });
            }
          },
        });
      }),
    );
  }

  if (types.has("contact")) {
    await eachPage(auth, "contacts", maxPages, deps, report, (o) =>
      withWorkspaceScope(workspaceId, async (tx) => {
        const f = contactFromHubspot(o);
        const hsCompany = o.associations.companies?.[0];
        const companyId = hsCompany ? await companyLocal(tx, hsCompany) : null;
        await applyRecord({
          tx, workspaceId, objectType: "contact", o, report,
          findLocal: async (link) =>
            link
              ? tx.opsContact.findFirst({ where: { id: link.localId, workspaceId } })
              : f.email
                ? tx.opsContact.findFirst({ where: { workspaceId, email: f.email } })
                : null,
          create: () => tx.opsContact.create({ data: { workspaceId, ...f, companyId } }),
          update: async (local) => {
            const data = { ...present(f), ...(companyId ? { companyId } : {}) };
            try {
              return await tx.opsContact.update({ where: { id: local.id }, data });
            } catch (err) {
              if (!isUnique(err)) throw err;
              report.conflicts.push({ objectType: "contact", hubspotId: o.id, localId: local.id, resolution: "email used by another local contact; kept the local email" });
              const { email: _e, ...rest } = data as Record<string, unknown>;
              void _e;
              return tx.opsContact.update({ where: { id: local.id }, data: rest });
            }
          },
        });
      }),
    );
  }

  if (types.has("deal")) {
    const pipelines = await pullPipelines(workspaceId, auth, deps, report);
    await eachPage(auth, "deals", maxPages, deps, report, (o) =>
      withWorkspaceScope(workspaceId, async (tx) => {
        const f = dealFromHubspot(o);
        const pipe = pipelines.get(f.hubspotPipeline ?? "") ?? [...pipelines.values()][0];
        if (!pipe) {
          report.conflicts.push({ objectType: "deal", hubspotId: o.id, localId: null, resolution: "no HubSpot deal pipeline could be mirrored; skipped" });
          return;
        }
        const stage = pipe.stages.find((s) => s.hubspotStageId === f.hubspotStage)?.id ?? pipe.stages[0].id;
        const status = dealStatusForStage(stage);
        const contactHs = o.associations.contacts?.[0];
        const companyHs = o.associations.companies?.[0];
        const contactId = contactHs ? (await findLink(tx, workspaceId, "contact", { hubspotId: contactHs }))?.localId ?? null : null;
        const companyId = companyHs ? await companyLocal(tx, companyHs) : null;
        const fields = {
          title: f.title,
          valueCents: f.valueCents,
          pipelineId: pipe.localId,
          stage,
          status,
          expectedCloseAt: f.expectedCloseAt,
          ...(contactId ? { contactId } : {}),
          ...(companyId ? { companyId } : {}),
        };
        await applyRecord({
          tx, workspaceId, objectType: "deal", o, report,
          findLocal: async (link) => (link ? tx.opsDeal.findFirst({ where: { id: link.localId, workspaceId } }) : null),
          create: () =>
            tx.opsDeal.create({ data: { workspaceId, ...fields, ownerId: opts.userId, closedAt: status === "open" ? null : new Date() } }),
          update: (local) =>
            tx.opsDeal.update({
              where: { id: local.id },
              data: { ...present(fields), closedAt: status === "open" ? null : (local as { closedAt?: Date | null }).closedAt ?? new Date() },
            }),
        });
      }),
    );
  }

  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId,
        filePath: "(crm)",
        actor: "user",
        action: "hubspot_sync_pulled",
        summary: `[hubspot] pulled: ${report.created} created, ${report.updated} updated, ${report.linked} linked, ${report.localAhead} local ahead, ${report.conflicts.length} conflicts`.slice(0, 500),
        approvedBy: opts.userId,
      },
    })
    .catch(() => undefined);
  return report;
}

// ---------------------------------------------------------------------------
// Push (gated write)
// ---------------------------------------------------------------------------

export class HubspotSyncError extends Error {
  readonly code: "not_found" | "conflict" | "bad_request";
  constructor(code: "not_found" | "conflict" | "bad_request", message: string) {
    super(message);
    this.name = "HubspotSyncError";
    this.code = code;
  }
}

export interface PushResult {
  objectType: SyncObjectType;
  localId: string;
  hubspotId: string;
  action: "created" | "updated";
  associated: string[];
}

export async function pushToHubspot(
  workspaceId: string,
  auth: TokenSource,
  input: { objectType: SyncObjectType; localId: string; force?: boolean },
  deps: LiveDeps = {},
): Promise<PushResult> {
  const { objectType, localId } = input;
  if (!["contact", "company", "deal"].includes(objectType)) throw new HubspotSyncError("bad_request", "objectType must be contact, company or deal.");
  const type = HS_TYPE[objectType];

  const loaded = await withWorkspaceScope(workspaceId, async (tx) => {
    const link = await findLink(tx, workspaceId, objectType, { localId });
    const hsId = async (t: SyncObjectType, id: string | null | undefined) => (id ? (await findLink(tx, workspaceId, t, { localId: id }))?.hubspotId ?? null : null);
    if (objectType === "contact") {
      const c = await tx.opsContact.findFirst({ where: { id: localId, workspaceId } });
      if (!c) return null;
      return { link, updatedAt: c.updatedAt, props: contactToHubspot(c), assoc: [["companies", await hsId("company", c.companyId)]] as const };
    }
    if (objectType === "company") {
      const c = await tx.opsCompany.findFirst({ where: { id: localId, workspaceId } });
      if (!c) return null;
      return { link, updatedAt: c.updatedAt, props: companyToHubspot(c), assoc: [] as const };
    }
    const d = await tx.opsDeal.findFirst({ where: { id: localId, workspaceId } });
    if (!d) return null;
    const pipeLink = await findLink(tx, workspaceId, "pipeline", { localId: d.pipelineId });
    const pipe = pipeLink ? await tx.pipeline.findFirst({ where: { id: d.pipelineId, workspaceId } }) : null;
    const stages = (Array.isArray(pipe?.stages) ? pipe?.stages : []) as unknown as MirrorStage[];
    const hsStage = stages.find((s) => s.id === d.stage)?.hubspotStageId;
    if (!pipeLink || !hsStage) {
      throw new HubspotSyncError("bad_request", "Only deals on a HubSpot pipeline can be pushed — move the deal to a \"HubSpot:\" pipeline first (sync_from_hubspot creates them).");
    }
    const props = clean({
      dealname: d.title,
      amount: (d.valueCents / 100).toFixed(2),
      pipeline: pipeLink.hubspotId,
      dealstage: hsStage,
      closedate: d.expectedCloseAt ? d.expectedCloseAt.toISOString() : undefined,
    });
    return {
      link,
      updatedAt: d.updatedAt,
      props,
      assoc: [["contacts", await hsId("contact", d.contactId)], ["companies", await hsId("company", d.companyId)]] as const,
    };
  });
  if (!loaded) throw new HubspotSyncError("not_found", `No local ${objectType} ${localId} in this workspace.`);

  let remote: HubspotObject;
  let action: PushResult["action"];
  if (loaded.link) {
    const current = await hubspotGet(auth, type, loaded.link.hubspotId, deps);
    const currentAt = current.updatedAt ? new Date(current.updatedAt) : null;
    if (!pushAllowed(loaded.link, currentAt, loaded.updatedAt, input.force === true)) {
      throw new HubspotSyncError(
        "conflict",
        `HubSpot has newer changes to this ${objectType} (${current.updatedAt}) — run sync_from_hubspot first, or push with force to overwrite them.`,
      );
    }
    remote = await hubspotUpdate(auth, type, loaded.link.hubspotId, loaded.props, deps);
    action = "updated";
  } else {
    remote = await hubspotCreate(auth, type, loaded.props, deps);
    action = "created";
  }
  const associated: string[] = [];
  for (const [toType, toId] of loaded.assoc) {
    if (!toId) continue;
    await hubspotAssociate(auth, { type, id: remote.id }, { type: toType, id: toId }, deps);
    associated.push(`${toType}:${toId}`);
  }
  await withWorkspaceScope(workspaceId, (tx) =>
    saveLink(tx, workspaceId, objectType, remote.id, localId, { hubspotUpdatedAt: remote.updatedAt ? new Date(remote.updatedAt) : new Date(), localUpdatedAt: loaded.updatedAt }, "push"),
  );
  return { objectType, localId, hubspotId: remote.id, action, associated };
}
