// Phase 11 (conncore): HubSpot ↔ Ops CRM sync against Postgres (app role)
// with a FAKE HubSpot (an in-memory, URL-routed fetch — labelled test fake;
// the live API is UNVERIFIED-LIVE).
//   1. Pull creates companies → contacts (linked to their company) → a mirror
//      pipeline → deals (stage + contact/company), and links every object.
//   2. A re-pull is idempotent (no duplicates, everything unchanged).
//   3. Conflict rule: HubSpot-only change applies; local-only change is kept
//      (local_ahead); both changed → newer wins and is reported.
//   4. A first pull dedupes onto an existing local contact by email.
//   5. Push creates in HubSpot + associates + links; a push over newer
//      HubSpot changes is refused unless force.
//   6. hubspot_sync_links is FORCE RLS (no GUC → nothing; other tenant → nothing).
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/hubspot/__tests__/hubspot-sync-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { pullFromHubspot, pushToHubspot, HubspotSyncError } from "../sync";
import { publicResolve } from "@/lib/connectors/m21/live/__tests__/fixtures";

const RUN = `p11h-${Date.now().toString(36)}`;
const WS = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const auth = { token: "hs-test-token" };

type Rec = { id: string; properties: Record<string, string | null>; updatedAt: string; associations?: Record<string, { results: Array<{ id: string }> }> };
const store: Record<"contacts" | "companies" | "deals", Rec[]> = { contacts: [], companies: [], deals: [] };
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let nextId = 900;
let clock = Date.parse("2026-10-01T00:00:00Z");
const tick = () => new Date((clock += 60_000)).toISOString();

/** FAKE HubSpot (tests only): list / get / create / patch / pipelines / associate. */
const fakeHubspot = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ method, path: url.pathname, body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/crm/v3/pipelines/deals") {
    return json(200, { results: [{ id: "default", label: "Sales", stages: [
      { id: "appointmentscheduled", label: "Appointment", displayOrder: 0, metadata: { isClosed: "false", probability: "0.2" } },
      { id: "closedwon", label: "Won", displayOrder: 1, metadata: { isClosed: "true", probability: "1.0" } },
      { id: "closedlost", label: "Lost", displayOrder: 2, metadata: { isClosed: "true", probability: "0.0" } },
    ] }] });
  }
  const assoc = url.pathname.match(/^\/crm\/v4\/objects\/(\w+)\/(\d+)\/associations\/default\/(\w+)\/(\d+)$/);
  if (assoc && method === "PUT") return json(200, { status: "COMPLETE" });
  const m = url.pathname.match(/^\/crm\/v3\/objects\/(contacts|companies|deals)(?:\/(\d+))?$/);
  if (!m) return json(404, { message: "not found" });
  const list = store[m[1] as keyof typeof store];
  if (method === "GET" && !m[2]) return json(200, { results: list });
  const rec = m[2] ? list.find((r) => r.id === m[2]) : undefined;
  if (method === "GET") return rec ? json(200, rec) : json(404, { message: "nope" });
  if (method === "POST") {
    const r: Rec = { id: String(nextId++), properties: body.properties, updatedAt: tick() };
    list.push(r);
    return json(201, r);
  }
  if (method === "PATCH" && rec) {
    rec.properties = { ...rec.properties, ...body.properties };
    rec.updatedAt = tick();
    return json(200, rec);
  }
  return json(400, { message: "bad" });
}) as typeof fetch;

const deps = { fetchImpl: fakeHubspot, resolve: publicResolve, sleep: async () => undefined };

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  store.companies.push({ id: "11", properties: { name: "Acme", domain: "acme.com" }, updatedAt: tick() });
  store.contacts.push({ id: "21", properties: { email: "ada@acme.com", firstname: "Ada", lastname: "Lovelace" }, updatedAt: tick(), associations: { companies: { results: [{ id: "11" }] } } });
  store.contacts.push({ id: "22", properties: { email: "bob@acme.com", firstname: "Bob" }, updatedAt: tick() });
  store.deals.push({ id: "31", properties: { dealname: "Acme rollout", amount: "5000", dealstage: "appointmentscheduled", pipeline: "default" }, updatedAt: tick(), associations: { contacts: { results: [{ id: "21" }] }, companies: { results: [{ id: "11" }] } } });
  // A local contact that already exists (dedupe-by-email target), newer than HubSpot's.
  await withWorkspaceScope(WS, (tx) => tx.opsContact.create({ data: { workspaceId: WS, name: "Robert (local)", email: "bob@acme.com" } }));
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const local = () =>
  withWorkspaceScope(WS, async (tx) => ({
    companies: await tx.opsCompany.findMany({ where: { workspaceId: WS } }),
    contacts: await tx.opsContact.findMany({ where: { workspaceId: WS }, orderBy: { email: "asc" } }),
    deals: await tx.opsDeal.findMany({ where: { workspaceId: WS } }),
    links: await tx.hubspotSyncLink.findMany({ where: { workspaceId: WS } }),
  }));

describe("HubSpot pull", () => {
  it("creates and links companies, contacts, the mirror pipeline and deals", async () => {
    const report = await pullFromHubspot(WS, auth, { userId: USER }, deps);
    const l = await local();
    assert.equal(l.companies.length, 1);
    assert.equal(l.companies[0].domain, "acme.com");
    const ada = l.contacts.find((c) => c.email === "ada@acme.com");
    assert.equal(ada?.name, "Ada Lovelace");
    assert.equal(ada?.companyId, l.companies[0].id);
    // Bob dedupes onto the existing local contact (first match → newer side wins: local).
    assert.equal(l.contacts.length, 2);
    assert.equal(l.contacts.find((c) => c.email === "bob@acme.com")?.name, "Robert (local)");
    assert.equal(l.deals.length, 1);
    assert.equal(l.deals[0].stage, "hs-appointmentscheduled");
    assert.equal(l.deals[0].valueCents, 500000);
    assert.equal(l.deals[0].contactId, ada?.id);
    const pipe = await withWorkspaceScope(WS, (tx) => tx.pipeline.findFirst({ where: { id: l.deals[0].pipelineId } }));
    assert.equal(pipe?.name, "HubSpot: Sales");
    assert.deepEqual((l.links.map((x) => x.objectType).sort()), ["company", "contact", "contact", "deal", "pipeline"]);
    assert.ok(report.conflicts.some((c) => c.objectType === "contact" && /local is newer/.test(c.resolution)));
  });

  it("a re-pull is idempotent: no duplicates, nothing changed", async () => {
    const report = await pullFromHubspot(WS, auth, { userId: USER }, deps);
    const l = await local();
    assert.equal(l.companies.length + l.contacts.length + l.deals.length, 4);
    assert.equal(report.created, 0);
    assert.equal(report.updated, 0);
    assert.equal(l.links.length, 5);
  });

  it("HubSpot-only change applies; local-only change is kept; both changed → newer wins", async () => {
    // HubSpot-only: the deal moves to closed won.
    const deal = store.deals[0];
    deal.properties.dealstage = "closedwon";
    deal.updatedAt = tick();
    // Local-only: the company's industry.
    const { companies } = await local();
    await withWorkspaceScope(WS, (tx) => tx.opsCompany.update({ where: { id: companies[0].id }, data: { industry: "Robotics (local)" } }));
    const report = await pullFromHubspot(WS, auth, { userId: USER }, deps);
    let l = await local();
    assert.equal(l.deals[0].stage, "won");
    assert.equal(l.deals[0].status, "won");
    assert.equal(l.companies[0].industry, "Robotics (local)");
    assert.ok(report.localAhead >= 1);

    // Both changed, HubSpot newer → HubSpot wins (reported).
    const ada = l.contacts.find((c) => c.email === "ada@acme.com")!;
    await withWorkspaceScope(WS, (tx) => tx.opsContact.update({ where: { id: ada.id }, data: { title: "Local title" } }));
    clock = Date.now() + 3_600_000;
    store.contacts[0].properties.jobtitle = "HubSpot title";
    store.contacts[0].updatedAt = tick();
    const r2 = await pullFromHubspot(WS, auth, { objectTypes: ["contact"], userId: USER }, deps);
    l = await local();
    assert.equal(l.contacts.find((c) => c.id === ada.id)?.title, "HubSpot title");
    assert.ok(r2.conflicts.some((c) => /HubSpot is newer/.test(c.resolution)));
  });
});

describe("HubSpot push (gated write)", () => {
  it("creates a new local contact in HubSpot, associates its linked company, and links it", async () => {
    const { companies } = await local();
    const c = await withWorkspaceScope(WS, (tx) => tx.opsContact.create({ data: { workspaceId: WS, name: "Cleo Park", email: "cleo@acme.com", companyId: companies[0].id } }));
    const res = await pushToHubspot(WS, auth, { objectType: "contact", localId: c.id }, deps);
    assert.equal(res.action, "created");
    assert.deepEqual(res.associated, ["companies:11"]);
    const created = store.contacts.find((r) => r.id === res.hubspotId);
    assert.deepEqual(created?.properties, { email: "cleo@acme.com", firstname: "Cleo", lastname: "Park" });
    assert.ok(calls.some((x) => x.method === "PUT" && x.path === `/crm/v4/objects/contacts/${res.hubspotId}/associations/default/companies/11`));
    const again = await pushToHubspot(WS, auth, { objectType: "contact", localId: c.id }, deps);
    assert.equal(again.action, "updated");
    assert.equal(again.hubspotId, res.hubspotId);
  });

  it("refuses to overwrite newer HubSpot changes unless force; deals push their stage", async () => {
    const { contacts, deals } = await local();
    const ada = contacts.find((c) => c.email === "ada@acme.com")!;
    store.contacts[0].updatedAt = new Date(Date.now() + 10 * 3_600_000).toISOString();
    await assert.rejects(pushToHubspot(WS, auth, { objectType: "contact", localId: ada.id }, deps), (e: unknown) => e instanceof HubspotSyncError && e.code === "conflict");
    const forced = await pushToHubspot(WS, auth, { objectType: "contact", localId: ada.id, force: true }, deps);
    assert.equal(forced.action, "updated");
    await withWorkspaceScope(WS, (tx) => tx.opsDeal.update({ where: { id: deals[0].id }, data: { stage: "lost", status: "lost" } }));
    await pushToHubspot(WS, auth, { objectType: "deal", localId: deals[0].id, force: true }, deps);
    assert.equal(store.deals[0].properties.dealstage, "closedlost");
    assert.equal(store.deals[0].properties.pipeline, "default");
  });

  it("hubspot_sync_links is tenant-isolated (FORCE RLS)", async () => {
    assert.equal(await countWithoutScope("hubspot_sync_links"), 0);
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.hubspotSyncLink.count()), 0);
    assert.ok((await withWorkspaceScope(WS, (tx) => tx.hubspotSyncLink.count())) >= 6);
  });
});
