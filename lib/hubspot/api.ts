// ShapesOS — Phase 11 (conncore): HubSpot CRM v3 calls (OAuth bearer).
//
//   GET   https://api.hubapi.com/crm/v3/objects/{type}?limit&after&properties&associations
//   POST  https://api.hubapi.com/crm/v3/objects/{type}            { properties }
//   PATCH https://api.hubapi.com/crm/v3/objects/{type}/{id}       { properties }
//   GET   https://api.hubapi.com/crm/v3/pipelines/deals
//   PUT   https://api.hubapi.com/crm/v4/objects/{from}/{id}/associations/default/{to}/{toId}
// Docs: https://developers.hubspot.com/docs/api-reference/crm-contacts-v3
//       https://developers.hubspot.com/docs/api-reference/crm-pipelines-v3
//       https://developers.hubspot.com/docs/api-reference/crm-associations-v4
//
// Reads back off on 429 (HubSpot's per-10s burst limit) via liveRequest;
// writes are never retried on 5xx/network errors (no duplicate creates);
// refresh-on-401 goes through the vault (HubSpot access tokens live 30 min).

import { liveRequest, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";

export const HUBSPOT_API = "https://api.hubapi.com";
const PROVIDER = "HubSpot";

export type HubspotObjectType = "contacts" | "companies" | "deals";

export const HUBSPOT_PROPERTIES: Readonly<Record<HubspotObjectType, readonly string[]>> = {
  contacts: ["email", "firstname", "lastname", "phone", "jobtitle", "lastmodifieddate"],
  companies: ["name", "domain", "website", "phone", "industry", "hs_lastmodifieddate"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate", "hs_lastmodifieddate"],
};

const ASSOCIATIONS: Readonly<Record<HubspotObjectType, string | undefined>> = {
  contacts: "companies",
  companies: undefined,
  deals: "contacts,companies",
};

export interface HubspotObject {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: string;
  archived?: boolean;
  /** Associated ids by object type (contacts → companies, deals → contacts + companies). */
  associations: Partial<Record<"contacts" | "companies", string[]>>;
}

interface RawObject {
  id?: string;
  properties?: Record<string, string | null>;
  updatedAt?: string;
  archived?: boolean;
  associations?: Record<string, { results?: Array<{ id?: string }> }>;
}

function toObject(r: RawObject): HubspotObject {
  const assoc: HubspotObject["associations"] = {};
  for (const k of ["contacts", "companies"] as const) {
    const ids = (r.associations?.[k]?.results ?? []).map((x) => String(x.id ?? "")).filter(Boolean);
    if (ids.length) assoc[k] = [...new Set(ids)];
  }
  return { id: String(r.id ?? ""), properties: r.properties ?? {}, updatedAt: String(r.updatedAt ?? ""), archived: r.archived, associations: assoc };
}

/** One page of a CRM object list (newest pages are not guaranteed; we scan). */
export async function hubspotListPage(
  auth: TokenSource,
  type: HubspotObjectType,
  opts: { after?: string | null; limit?: number },
  deps: LiveDeps = {},
): Promise<{ results: HubspotObject[]; after: string | null }> {
  const res = await liveRequest<{ results?: RawObject[]; paging?: { next?: { after?: string } } }>(
    {
      provider: PROVIDER,
      url: `${HUBSPOT_API}/crm/v3/objects/${type}`,
      query: {
        limit: Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 100),
        after: opts.after ?? undefined,
        properties: HUBSPOT_PROPERTIES[type].join(","),
        associations: ASSOCIATIONS[type],
        archived: false,
      },
      auth,
    },
    deps,
  );
  return { results: (res?.results ?? []).map(toObject), after: res?.paging?.next?.after ?? null };
}

/** One record by id (with the synced properties). */
export async function hubspotGet(auth: TokenSource, type: HubspotObjectType, id: string, deps: LiveDeps = {}): Promise<HubspotObject> {
  if (!/^\d{1,20}$/.test(id)) throw new Error("HubSpot ids are numeric.");
  const r = await liveRequest<RawObject>(
    {
      provider: PROVIDER,
      url: `${HUBSPOT_API}/crm/v3/objects/${type}/${id}`,
      query: { properties: HUBSPOT_PROPERTIES[type].join(","), associations: ASSOCIATIONS[type] },
      auth,
    },
    deps,
  );
  return toObject(r ?? {});
}

export async function hubspotCreate(
  auth: TokenSource,
  type: HubspotObjectType,
  properties: Record<string, string>,
  deps: LiveDeps = {},
): Promise<HubspotObject> {
  const r = await liveRequest<RawObject>(
    { provider: PROVIDER, url: `${HUBSPOT_API}/crm/v3/objects/${type}`, method: "POST", json: { properties }, auth },
    { ...deps, maxRetries: 0 },
  );
  return toObject(r ?? {});
}

export async function hubspotUpdate(
  auth: TokenSource,
  type: HubspotObjectType,
  id: string,
  properties: Record<string, string>,
  deps: LiveDeps = {},
): Promise<HubspotObject> {
  if (!/^\d{1,20}$/.test(id)) throw new Error("HubSpot ids are numeric.");
  const r = await liveRequest<RawObject>(
    { provider: PROVIDER, url: `${HUBSPOT_API}/crm/v3/objects/${type}/${id}`, method: "PATCH", json: { properties }, auth },
    { ...deps, maxRetries: 0 },
  );
  return toObject(r ?? {});
}

/** Default (unlabelled) association between two records (v4). Idempotent at HubSpot. */
export async function hubspotAssociate(
  auth: TokenSource,
  from: { type: HubspotObjectType; id: string },
  to: { type: HubspotObjectType; id: string },
  deps: LiveDeps = {},
): Promise<void> {
  if (!/^\d{1,20}$/.test(from.id) || !/^\d{1,20}$/.test(to.id)) throw new Error("HubSpot ids are numeric.");
  await liveRequest(
    {
      provider: PROVIDER,
      url: `${HUBSPOT_API}/crm/v4/objects/${from.type}/${from.id}/associations/default/${to.type}/${to.id}`,
      method: "PUT",
      auth,
    },
    { ...deps, maxRetries: 0 },
  );
}

export interface HubspotPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string; displayOrder: number; isClosed: boolean; probability: number | null }>;
}

export async function hubspotDealPipelines(auth: TokenSource, deps: LiveDeps = {}): Promise<HubspotPipeline[]> {
  const res = await liveRequest<{
    results?: Array<{ id?: string; label?: string; stages?: Array<{ id?: string; label?: string; displayOrder?: number; metadata?: { isClosed?: string; probability?: string } }> }>;
  }>({ provider: PROVIDER, url: `${HUBSPOT_API}/crm/v3/pipelines/deals`, auth }, deps);
  return (res?.results ?? []).map((p) => ({
    id: String(p.id ?? ""),
    label: String(p.label ?? "Pipeline"),
    stages: (p.stages ?? [])
      .map((s) => ({
        id: String(s.id ?? ""),
        label: String(s.label ?? s.id ?? ""),
        displayOrder: Number(s.displayOrder ?? 0),
        isClosed: s.metadata?.isClosed === "true",
        probability: s.metadata?.probability !== undefined && s.metadata.probability !== "" ? Number(s.metadata.probability) : null,
      }))
      .sort((a, b) => a.displayOrder - b.displayOrder),
  }));
}
