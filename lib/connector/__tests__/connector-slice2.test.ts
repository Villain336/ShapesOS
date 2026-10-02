// Marketr — Connector Agent slice 2 tests: import + consent.
// Run: npx tsx --test lib/connector/__tests__/connector-slice2.test.ts
//
// DB-backed tests run against the local dev DB and clean up their own test
// workspaces (cascades purge connector rows). Provider fetches are faked via
// the runImport fetcher seam — no network, no OAuth in tests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import {
  runImport,
  liveContactsFetcher,
  type ContactsFetcher,
  type RawImportContact,
} from "../import-engine";
import {
  ConnectorError,
  buildExternalId,
  computeWarmth,
  exclusionMatches,
  normalizeExclusionValue,
  validateExclusionInput,
  validateSourceConsentInput,
} from "../types";

const store = new PrismaConnectorStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice2",
    },
  });
  testWorkspaceIds.push(ws.id);
  return ws.id;
}

after(async () => {
  for (const id of testWorkspaceIds) {
    await prisma.workspace.delete({ where: { id } }).catch(() => {});
  }
});

const NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ConnectorError, `expected ConnectorError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a ConnectorError to be thrown");
}

function contact(
  email: string,
  partial: Partial<RawImportContact> = {},
): RawImportContact {
  return {
    email,
    name: partial.name ?? email.split("@")[0],
    interactionCount: partial.interactionCount ?? 3,
    inboundCount: partial.inboundCount ?? 2,
    outboundCount: partial.outboundCount ?? 1,
    lastInteractionAt: partial.lastInteractionAt ?? daysAgo(4),
  };
}

function fakeFetcher(contacts: RawImportContact[], cursor: string | null = null): ContactsFetcher {
  return async () => ({ contacts, cursor });
}

async function batchCount(ws: string): Promise<number> {
  return prisma.connectorImportBatch.count({ where: { workspaceId: ws } });
}

async function personCount(ws: string): Promise<number> {
  return prisma.connectorPerson.count({ where: { workspaceId: ws } });
}

// ---------------------------------------------------------------------------
// Consent gating — the money test.
// ---------------------------------------------------------------------------

describe("consent gating", () => {
  it("blocks import with NO consent recorded — and writes nothing", async () => {
    const ws = await makeWorkspace();
    const code = await codeOf(
      runImport({
        workspaceId: ws,
        userId: "u1",
        source: "email",
        now: NOW,
        fetcher: fakeFetcher([contact("a@example.com")]),
      }),
    );
    assert.equal(code, "no_consent");
    // Nothing was written: no batch receipt, no persons.
    assert.equal(await batchCount(ws), 0);
    assert.equal(await personCount(ws), 0);
  });

  it("revoked consent blocks the next import", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const { revoked } = await store.revokeSourceConsent(ws, "email");
    assert.equal(revoked, true);
    const code = await codeOf(
      runImport({
        workspaceId: ws,
        userId: "u1",
        source: "email",
        now: NOW,
        fetcher: fakeFetcher([contact("a@example.com")]),
      }),
    );
    assert.equal(code, "no_consent");
  });

  it("consent is per-source: email consent does not unlock calendar", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const code = await codeOf(
      runImport({
        workspaceId: ws,
        userId: "u1",
        source: "calendar",
        now: NOW,
        fetcher: fakeFetcher([contact("a@example.com")]),
      }),
    );
    assert.equal(code, "no_consent");
  });

  it("rejects non-provider sources", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "manual",
      consentedBy: "founder@acme.com",
    });
    const code = await codeOf(
      runImport({ workspaceId: ws, userId: "u1", source: "manual", now: NOW }),
    );
    assert.equal(code, "invalid_source");
  });
});

// ---------------------------------------------------------------------------
// Import run: provenance, persons, relationship seeding.
// ---------------------------------------------------------------------------

describe("import run", () => {
  it("creates persons with provenance from the consent grant", async () => {
    const ws = await makeWorkspace();
    const grant = await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const batch = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([
        contact("ada@analytical.com", { name: "Ada Lovelace" }),
        contact("grace@navy.mil", { name: "Grace Hopper" }),
      ]),
    });
    assert.equal(batch.status, "completed");
    assert.equal(batch.source, "email");
    assert.equal(batch.consentedBy, "founder@acme.com");
    assert.equal(batch.consentedAt.getTime(), grant.consentedAt.getTime());
    assert.ok(batch.completedAt);
    assert.deepEqual(
      {
        fetched: batch.stats?.fetched,
        created: batch.stats?.created,
        excludedSkipped: batch.stats?.excludedSkipped,
      },
      { fetched: 2, created: 2, excludedSkipped: 0 },
    );

    const persons = await store.listPersons(ws, NOW);
    assert.equal(persons.length, 2);
    const ada = persons.find((p) => p.name === "Ada Lovelace");
    assert.ok(ada);
    assert.equal(ada.importBatchId, batch.id);
    assert.equal(ada.consentedBy, "founder@acme.com");
    assert.equal(ada.consentedAt.getTime(), grant.consentedAt.getTime());
    assert.deepEqual(ada.handles, ["ada@analytical.com"]);
    // Relationship seeded from the aggregated signals — warmth derived,
    // never hand-set.
    assert.ok(ada.relationship);
    assert.equal(ada.relationship.touchCount, 3);
    assert.equal(ada.relationship.inboundCount, 2);
    assert.equal(ada.relationship.outboundCount, 1);
    assert.equal(
      ada.relationship.lastTouchAt?.getTime(),
      daysAgo(4).getTime(),
    );
    const expected = computeWarmth(
      {
        lastTouchAt: daysAgo(4),
        touchCount: 3,
        inboundCount: 2,
        outboundCount: 1,
      },
      NOW,
    ).score;
    assert.equal(ada.relationship.warmthScore, expected);
  });

  it("marks the batch failed when the provider throws — and rethrows", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const failing: ContactsFetcher = async () => {
      throw new Error("provider exploded");
    };
    const code = await codeOf(
      runImport({ workspaceId: ws, userId: "u1", source: "email", now: NOW, fetcher: failing }),
    );
    assert.equal(code, "import_failed");
    const batches = await store.listImportBatches(ws);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].status, "failed");
    assert.match(batches[0].error ?? "", /provider exploded/);
    assert.ok(batches[0].completedAt);
    assert.equal(await personCount(ws), 0);
  });

  it("live fetcher fails closed without a connection (no network)", async () => {
    const code = await codeOf(
      liveContactsFetcher({
        source: "email",
        connectorKey: "gmail",
        since: null,
        workspaceId: "nonexistent-workspace",
        userId: "u1",
      }),
    );
    assert.equal(code, "not_connected");
  });
});

// ---------------------------------------------------------------------------
// Exclusion lists — excluded contacts never become Persons.
// ---------------------------------------------------------------------------

describe("exclusion enforcement", () => {
  it("domain, email, and person_name exclusions all filter before creation", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    await store.addExclusion(ws, { type: "domain", value: "Competitor.com" });
    await store.addExclusion(ws, { type: "email", value: "SPAMMY@EXAMPLE.COM" });
    await store.addExclusion(ws, { type: "person_name", value: "annoying" });

    const batch = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([
        contact("rival@competitor.com", { name: "Rival Person" }),
        contact("spy@mail.competitor.com", { name: "Spy Subdomain" }),
        contact("spammy@example.com", { name: "Spammy" }),
        contact("nice@annoying-person.com", { name: "The Annoying Guy" }),
        contact("friend@ally.com", { name: "Good Friend" }),
      ]),
    });
    assert.equal(batch.stats?.excludedSkipped, 4);
    assert.equal(batch.stats?.created, 1);
    const persons = await store.listPersons(ws, NOW);
    assert.equal(persons.length, 1);
    assert.equal(persons[0].name, "Good Friend");
  });

  it("invalid emails never become persons and are reported, not counted as created", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const batch = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([
        contact("not-an-email"),
        contact("ok@fine.com", { name: "Fine" }),
      ]),
    });
    assert.equal(batch.stats?.created, 1);
    assert.equal(batch.stats?.errors.length, 1);
    assert.match(batch.stats?.errors[0] ?? "", /no usable email/);
    assert.equal(await personCount(ws), 1);
  });

  it("duplicate exclusion is rejected", async () => {
    const ws = await makeWorkspace();
    await store.addExclusion(ws, { type: "domain", value: "acme.com" });
    const code = await codeOf(store.addExclusion(ws, { type: "domain", value: "ACME.COM" }));
    assert.equal(code, "duplicate_exclusion");
  });
});

// ---------------------------------------------------------------------------
// Dedup + incremental sync.
// ---------------------------------------------------------------------------

describe("dedup and incremental sync", () => {
  it("same import twice: second run skips stale rows, creates nothing", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const contacts = [
      contact("a@example.com", { lastInteractionAt: daysAgo(10) }),
      contact("b@example.com", { lastInteractionAt: daysAgo(4) }),
    ];
    const first = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher(contacts),
    });
    assert.equal(first.status, "completed");
    // Cursor = newest interaction.
    assert.equal(first.cursor, daysAgo(4).toISOString());
    assert.equal(await personCount(ws), 2);

    let seenSince: string | null = "unset";
    const second = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: async (input) => {
        seenSince = input.since;
        return { contacts, cursor: null };
      },
    });
    // The engine passed the watermark to the provider.
    assert.equal(seenSince, daysAgo(4).toISOString());
    assert.equal(second.stats?.staleSkipped, 2);
    assert.equal(second.stats?.created, 0);
    assert.equal(await personCount(ws), 2);
  });

  it("incremental run merges NEW signal into an existing person (no duplicate)", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([
        contact("a@example.com", {
          interactionCount: 2,
          inboundCount: 1,
          outboundCount: 1,
          lastInteractionAt: daysAgo(10),
        }),
      ]),
    });
    const second = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: async (input) => {
        assert.equal(input.since, daysAgo(10).toISOString());
        return {
          contacts: [
            contact("a@example.com", {
              interactionCount: 5,
              inboundCount: 4,
              outboundCount: 1,
              lastInteractionAt: daysAgo(2),
            }),
          ],
          cursor: null,
        };
      },
    });
    assert.equal(second.stats?.merged, 1);
    assert.equal(second.stats?.created, 0);
    assert.equal(await personCount(ws), 1);
    const persons = await store.listPersons(ws, NOW);
    const rel = persons[0].relationship;
    assert.ok(rel);
    // Signals merged: 2+5 touches, 1+4 inbound, last touch advanced.
    assert.equal(rel.touchCount, 7);
    assert.equal(rel.inboundCount, 5);
    assert.equal(rel.lastTouchAt?.getTime(), daysAgo(2).getTime());
  });

  it("dedup hit with no newer signal is skipped, not merged", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    // Seed a person directly with the same externalId the import would use.
    const seeded = await store.addPerson(ws, {
      name: "Existing",
      handles: ["dup@example.com"],
      importBatchId: null,
      consentedBy: "founder@acme.com",
      externalId: buildExternalId("email", "dup@example.com"),
    });
    await store.addRelationshipSignals(
      ws,
      seeded.id,
      { touchCount: 3, inboundCount: 3, outboundCount: 0, lastTouchAt: daysAgo(4) },
      NOW,
    );
    const batch = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      // Same lastInteractionAt → not newer → dedup skip.
      fetcher: fakeFetcher([
        contact("dup@example.com", { lastInteractionAt: daysAgo(4) }),
      ]),
    });
    assert.equal(batch.stats?.dedupSkipped, 1);
    assert.equal(batch.stats?.merged, 0);
    assert.equal(batch.stats?.created, 0);
    assert.equal(await personCount(ws), 1);
    const persons = await store.listPersons(ws, NOW);
    assert.equal(persons[0].relationship?.touchCount, 3);
  });

  it("dedup is per-source: same email from gmail and calendar are distinct", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    await store.recordSourceConsent(ws, {
      source: "calendar",
      consentedBy: "founder@acme.com",
    });
    await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([contact("same@both.com")]),
    });
    await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "calendar",
      now: NOW,
      fetcher: fakeFetcher([contact("same@both.com")]),
    });
    assert.equal(await personCount(ws), 2);
    const ids = await prisma.connectorPerson.findMany({
      where: { workspaceId: ws },
      select: { externalId: true },
    });
    const keys = ids.map((r) => r.externalId).sort();
    assert.deepEqual(keys, ["gcal:email:same@both.com", "gmail:email:same@both.com"]);
  });

  it("duplicate emails within one batch are deduped", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "email",
      consentedBy: "founder@acme.com",
    });
    const batch = await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([
        contact("dup@example.com"),
        contact("DUP@example.com", { name: "Dup Again" }),
      ]),
    });
    assert.equal(batch.stats?.created, 1);
    assert.equal(batch.stats?.dedupSkipped, 1);
    assert.equal(await personCount(ws), 1);
  });

  it("cursor survives across batches (getImportCursor)", async () => {
    const ws = await makeWorkspace();
    await store.recordSourceConsent(ws, {
      source: "calendar",
      consentedBy: "founder@acme.com",
    });
    await runImport({
      workspaceId: ws,
      userId: "u1",
      source: "calendar",
      now: NOW,
      fetcher: fakeFetcher([contact("a@example.com", { lastInteractionAt: daysAgo(6) })]),
    });
    assert.equal(await store.getImportCursor(ws, "calendar"), daysAgo(6).toISOString());
    assert.equal(await store.getImportCursor(ws, "email"), null);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation.
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("consent, exclusions, batches, and persons never leak across workspaces", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    await store.recordSourceConsent(wsA, {
      source: "email",
      consentedBy: "a@acme.com",
    });
    await store.addExclusion(wsA, { type: "domain", value: "blocked.com" });
    await runImport({
      workspaceId: wsA,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([contact("keep@good.com")]),
    });

    // B has no consent → blocked, even though A consented.
    const code = await codeOf(
      runImport({
        workspaceId: wsB,
        userId: "u1",
        source: "email",
        now: NOW,
        fetcher: fakeFetcher([contact("x@good.com")]),
      }),
    );
    assert.equal(code, "no_consent");
    assert.equal(await batchCount(wsB), 0);
    assert.equal(await personCount(wsB), 0);

    // B's reads see none of A's rows.
    assert.equal(await store.getSourceConsent(wsB, "email"), null);
    assert.deepEqual(await store.listExclusions(wsB), []);
    assert.deepEqual(await store.listImportBatches(wsB), []);
    assert.deepEqual(await store.listPersons(wsB, NOW), []);

    // B's own exclusion of the same domain does not touch A's rules.
    await store.addExclusion(wsB, { type: "domain", value: "blocked.com" });
    assert.equal((await store.listExclusions(wsA)).length, 1);
    assert.equal((await store.listExclusions(wsB)).length, 1);

    // A's dedup key does not exist in B.
    assert.equal(
      await store.findPersonByExternalId(wsB, buildExternalId("email", "keep@good.com")),
      null,
    );

    // Removing B's exclusion leaves A's intact.
    const bEx = await store.listExclusions(wsB);
    const { removed } = await store.removeExclusion(wsB, bEx[0].id);
    assert.equal(removed, true);
    assert.equal((await store.listExclusions(wsA)).length, 1);
  });

  it("cannot remove another workspace's exclusion by id", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    const ex = await store.addExclusion(wsA, { type: "domain", value: "x.com" });
    const { removed } = await store.removeExclusion(wsB, ex.id);
    assert.equal(removed, false);
    assert.equal((await store.listExclusions(wsA)).length, 1);
  });

  it("cannot update another workspace's batch", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();
    await store.recordSourceConsent(wsA, {
      source: "email",
      consentedBy: "a@acme.com",
    });
    const batch = await runImport({
      workspaceId: wsA,
      userId: "u1",
      source: "email",
      now: NOW,
      fetcher: fakeFetcher([contact("a@good.com")]),
    });
    const code = await codeOf(
      store.updateImportBatch(wsB, batch.id, { status: "failed", error: "x" }),
    );
    assert.equal(code, "batch_not_found");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("exclusion matching (pure)", () => {
  const rules = [
    { type: "domain" as const, value: "competitor.com" },
    { type: "email" as const, value: "spam@example.com" },
    { type: "person_name" as const, value: "annoying" },
  ];

  it("domain matches exactly and on subdomains, not on lookalikes", () => {
    assert.ok(exclusionMatches(rules, { email: "a@competitor.com", name: null }));
    assert.ok(exclusionMatches(rules, { email: "a@mail.competitor.com", name: null }));
    assert.equal(
      exclusionMatches(rules, { email: "a@notcompetitor.com", name: null }),
      null,
    );
  });

  it("email matches exactly, case-insensitively", () => {
    assert.ok(
      exclusionMatches(rules, { email: "SPAM@example.com", name: null }),
    );
    assert.equal(
      exclusionMatches(rules, { email: "spam@other.com", name: null }),
      null,
    );
  });

  it("person_name is a case-insensitive substring match", () => {
    assert.ok(
      exclusionMatches(rules, { email: "a@x.com", name: "The ANNOYING Guy" }),
    );
    assert.equal(
      exclusionMatches(rules, { email: "a@x.com", name: "Pleasant Person" }),
      null,
    );
  });

  it("no rules → no match", () => {
    assert.equal(
      exclusionMatches([], { email: "a@competitor.com", name: "Annoying" }),
      null,
    );
  });
});

describe("validators and key builders (pure)", () => {
  it("buildExternalId namespaces per source", () => {
    assert.equal(buildExternalId("email", "A@B.com"), "gmail:email:a@b.com");
    assert.equal(buildExternalId("calendar", "A@B.com"), "gcal:email:a@b.com");
    assert.notEqual(
      buildExternalId("email", "a@b.com"),
      buildExternalId("calendar", "a@b.com"),
    );
  });

  it("normalizeExclusionValue lowercases and strips @ from domains", () => {
    assert.equal(normalizeExclusionValue("domain", "@ACME.com "), "acme.com");
    assert.equal(normalizeExclusionValue("email", " A@B.com "), "a@b.com");
    assert.equal(normalizeExclusionValue("person_name", " Ann "), "ann");
  });

  it("validateExclusionInput rejects bad values", () => {
    assert.ok(validateExclusionInput({ type: "email", value: "not-an-email" }).errors.length > 0);
    assert.ok(validateExclusionInput({ type: "domain", value: "no spaces.com" }).errors.length > 0);
    assert.ok(validateExclusionInput({ type: "bogus", value: "x" }).errors.length > 0);
    assert.ok(validateExclusionInput({ type: "domain", value: "" }).errors.length > 0);
    const ok = validateExclusionInput({ type: "domain", value: "@Acme.com" });
    assert.equal(ok.errors.length, 0);
    assert.equal(ok.value?.value, "acme.com");
  });

  it("validateSourceConsentInput requires a consenter", () => {
    assert.ok(
      validateSourceConsentInput({ source: "email", consentedBy: " " }).errors.length > 0,
    );
    assert.ok(
      validateSourceConsentInput({ source: "nope", consentedBy: "a@b.com" }).errors.length > 0,
    );
    const ok = validateSourceConsentInput({
      source: "email",
      consentedBy: "a@b.com",
      scopes: ["x"],
    });
    assert.equal(ok.errors.length, 0);
    assert.deepEqual(ok.value?.scopes, ["x"]);
  });
});
