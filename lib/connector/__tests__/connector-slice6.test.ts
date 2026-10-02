// Marketr — Connector Agent slice 6 tests: Directory + Boardy rail.
// Run: npx tsx --test lib/connector/__tests__/connector-slice6.test.ts
//
// Pure domain tests pin discoverability law (opt-in, reversible, per-facet),
// the mutual-discoverability matcher, the Boardy transition law, and the
// email-draft copy. DB-backed tests run against the local dev DB and clean
// up their own test workspaces (cascades purge directory + boardy rows).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import { PrismaIntroductionStore } from "../introduction-store";
import { PrismaBoardyRailStore } from "../boardy-rail";
import { ConnectorError } from "../types";
import type { IntroActor } from "../introductions";
import {
  matchDirectoryProfiles,
  toDirectoryPublicProfile,
  validateDirectoryProfileInput,
  type DirectoryProfileRow,
} from "../directory";
import {
  BOARDY_EMAIL,
  assertBoardyTransition,
  buildBoardyRequestEmail,
  validateBoardyRequestInput,
} from "../boardy-rail";

const dirStore = new PrismaConnectorStore(prisma);
const boardy = new PrismaBoardyRailStore(prisma);
const introStore = new PrismaIntroductionStore(prisma);
const personStore = new PrismaConnectorStore(prisma);
const testWorkspaceIds: string[] = [];

async function makeWorkspace(tag: string): Promise<string> {
  const ws = await prisma.workspace.create({
    data: {
      name: `test-connector-slice6-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: "test-connector-slice6",
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
const TENANT: IntroActor = { kind: "human", identity: "tico@example.com" };
const AGENT: IntroActor = { kind: "agent", identity: "connector-agent" };

async function assertThrowsCode(
  fn: () => Promise<unknown>,
  code: string,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ConnectorError, `${label}: expected ConnectorError, got ${e}`);
    assert.equal(
      (e as ConnectorError).code,
      code,
      `${label}: expected code ${code}, got ${(e as ConnectorError).code}`,
    );
    return;
  }
  assert.fail(`${label}: expected ConnectorError(${code}) but nothing threw`);
}

function assertThrowsCodeSync(fn: () => unknown, code: string, label: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConnectorError, `${label}: expected ConnectorError, got ${e}`);
    assert.equal((e as ConnectorError).code, code, `${label}: code`);
    return;
  }
  assert.fail(`${label}: expected ConnectorError(${code}) but nothing threw`);
}

// ---------------------------------------------------------------------------
// Pure: directory profile validation.
// ---------------------------------------------------------------------------

describe("validateDirectoryProfileInput", () => {
  it("omitted discoverable means keep-current — opt-in is never implied", () => {
    const { errors, value } = validateDirectoryProfileInput({ name: "Tico" });
    assert.deepEqual(errors, []);
    assert.ok(value);
    // undefined = the store keeps the current value (false for a new
    // profile). Publishing requires an EXPLICIT discoverable: true.
    assert.equal(value.discoverable, undefined);
    const bad = validateDirectoryProfileInput({ discoverable: "yes" });
    assert.ok(bad.value === null);
    assert.ok(bad.errors.some((e) => e.includes("discoverable must be a boolean")));
  });

  it("rejects an empty name at publish time", () => {
    const { errors, value } = validateDirectoryProfileInput({
      discoverable: true,
      name: "   ",
    });
    assert.ok(value === null);
    assert.ok(errors.some((e) => e.includes("name is required to publish")));
  });

  it("rejects an unknown lookingFor", () => {
    const { value } = validateDirectoryProfileInput({
      discoverable: false,
      lookingFor: "world-domination",
    });
    assert.ok(value === null);
  });

  it("rejects too many industries", () => {
    const { value } = validateDirectoryProfileInput({
      discoverable: false,
      industries: Array.from({ length: 11 }, (_, i) => `ind-${i}`),
    });
    assert.ok(value === null);
  });

  it("accepts a partial update (unpublish without profile fields)", () => {
    const { errors, value } = validateDirectoryProfileInput({ discoverable: false });
    assert.deepEqual(errors, []);
    assert.ok(value);
    assert.equal(value.discoverable, false);
    assert.equal(value.name, undefined); // not provided — not cleared
  });

  it("an empty provided name clears the field", () => {
    const { errors, value } = validateDirectoryProfileInput({ name: "  " });
    assert.deepEqual(errors, []);
    assert.ok(value);
    assert.equal(value.name, null);
  });
});

// ---------------------------------------------------------------------------
// Pure: facet gating.
// ---------------------------------------------------------------------------

function row(over: Partial<DirectoryProfileRow>): DirectoryProfileRow {
  return {
    id: "dir-1",
    workspaceId: "ws-1",
    discoverable: true,
    name: "Tico Hamphill",
    role: "Founder",
    company: "Launchabl",
    bio: "Building the OS.",
    industries: ["SaaS", "Marketing"],
    lookingFor: "leads",
    shareNameRole: true,
    shareFull: false,
    updatedAt: NOW,
    ...over,
  };
}

describe("toDirectoryPublicProfile", () => {
  it("exposes name+role when only the name_role facet is published", () => {
    const pub = toDirectoryPublicProfile(row({}));
    assert.deepEqual(pub.facets, ["name_role"]);
    assert.equal(pub.name, "Tico Hamphill");
    assert.equal(pub.role, "Founder");
    assert.equal(pub.company, null);
    assert.equal(pub.bio, null);
    assert.deepEqual(pub.industries, []);
    assert.equal(pub.lookingFor, null);
  });

  it("exposes the fuller profile when the full facet is published", () => {
    const pub = toDirectoryPublicProfile(row({ shareFull: true }));
    assert.deepEqual(pub.facets, ["name_role", "full"]);
    assert.equal(pub.company, "Launchabl");
    assert.equal(pub.bio, "Building the OS.");
    assert.deepEqual(pub.industries, ["SaaS", "Marketing"]);
    assert.equal(pub.lookingFor, "leads");
  });

  it("exposes nothing but the id when no facet is published", () => {
    const pub = toDirectoryPublicProfile(
      row({ shareNameRole: false, shareFull: false }),
    );
    assert.deepEqual(pub.facets, []);
    assert.equal(pub.name, null);
    assert.equal(pub.role, null);
  });
});

// ---------------------------------------------------------------------------
// Pure: mutual-discoverability matching.
// ---------------------------------------------------------------------------

describe("matchDirectoryProfiles", () => {
  const viewerId = "ws-viewer";

  it("throws not_discoverable when the viewer is not discoverable", () => {
    assertThrowsCodeSync(
      () =>
        matchDirectoryProfiles({
          viewerWorkspaceId: viewerId,
          viewerDiscoverable: false,
          candidates: [row({ workspaceId: "ws-b" })],
        }),
      "not_discoverable",
      "viewer gate",
    );
  });

  it("never matches non-discoverable candidates", () => {
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates: [row({ workspaceId: "ws-b", discoverable: false })],
    });
    assert.equal(matches.length, 0);
  });

  it("never matches the viewer against themselves", () => {
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates: [row({ workspaceId: viewerId })],
    });
    assert.equal(matches.length, 0);
  });

  it("requires the minimum identity facet (shareNameRole)", () => {
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates: [row({ workspaceId: "ws-b", shareNameRole: false })],
    });
    assert.equal(matches.length, 0);
  });

  it("scores industries 50 + role keywords 30 + lookingFor 20", () => {
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates: [
        row({
          id: "dir-b",
          workspaceId: "ws-b",
          role: "VP Sales",
          industries: ["SaaS"],
          lookingFor: "partners",
        }),
      ],
      criteria: {
        industries: ["saas"],
        roleKeywords: ["sales"],
        lookingFor: "partners",
      },
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].score, 100);
    assert.ok(matches[0].reasons.some((r) => r.includes("saas")));
    assert.ok(matches[0].reasons.some((r) => r.includes("sales")));
    assert.ok(matches[0].reasons.some((r) => r.includes("partners")));
  });

  it("sorts by score desc and applies the limit", () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      row({
        id: `dir-${i}`,
        workspaceId: `ws-${i}`,
        role: `role-${i}`,
        industries: i < 2 ? ["saas"] : ["other"],
      }),
    );
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates,
      criteria: { industries: ["saas"], limit: 1 },
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].score, 50);
  });

  it("browse mode returns every discoverable candidate at baseline score", () => {
    const matches = matchDirectoryProfiles({
      viewerWorkspaceId: viewerId,
      viewerDiscoverable: true,
      candidates: [row({ workspaceId: "ws-b" }), row({ workspaceId: "ws-c" })],
    });
    assert.equal(matches.length, 2);
    assert.ok(matches.every((m) => m.score === 10));
  });
});

// ---------------------------------------------------------------------------
// Pure: Boardy transition law + email draft copy.
// ---------------------------------------------------------------------------

describe("assertBoardyTransition", () => {
  it("allows the legal rail path draft→approved→sent→replied", () => {
    assert.equal(assertBoardyTransition("draft", "tenant_approve"), "approved");
    assert.equal(assertBoardyTransition("approved", "send"), "sent");
    assert.equal(assertBoardyTransition("sent", "reply_received"), "replied");
  });

  it("allows decline and cancel", () => {
    assert.equal(assertBoardyTransition("draft", "tenant_decline"), "declined");
    assert.equal(assertBoardyTransition("draft", "cancel"), "cancelled");
    assert.equal(assertBoardyTransition("approved", "cancel"), "cancelled");
  });

  it("rejects send from draft — the approval gate", () => {
    assertThrowsCodeSync(
      () => assertBoardyTransition("draft", "send"),
      "illegal_boardy_transition",
      "draft→send",
    );
  });

  it("rejects actions from terminal states", () => {
    for (const status of ["declined", "replied", "cancelled"] as const) {
      assertThrowsCodeSync(
        () => assertBoardyTransition(status, "tenant_approve"),
        "illegal_boardy_transition",
        `${status} is terminal`,
      );
    }
  });
});

describe("buildBoardyRequestEmail", () => {
  it("builds a context-rich draft with pinned copy", () => {
    const draft = buildBoardyRequestEmail({
      tenantName: "Tico Hamphill",
      targetName: "Alex Rivera",
      targetRole: "Partner, Sequoia",
      targetContext: "Alex led the fintech seed rounds I most admire and is actively investing in Raleigh.",
      offerSummary: "A warm customer base of 40 NC agencies who need fintech tooling.",
      mode: "funding",
    });
    assert.equal(draft.subject, "Intro request: Tico Hamphill → Alex Rivera");
    assert.ok(draft.body.includes("WHO: Alex Rivera — Partner, Sequoia"));
    assert.ok(draft.body.includes("WHY NOW: Alex led the fintech seed rounds"));
    assert.ok(draft.body.includes("WHAT I BRING THEM: A warm customer base"));
    assert.ok(draft.body.includes("for my raise"));
    assert.ok(draft.body.includes("double-opt-in norms"));
  });

  it("uses the leads line in leads mode", () => {
    const draft = buildBoardyRequestEmail({
      tenantName: "Tico",
      targetName: "Dana",
      targetContext: "Dana runs mid-market HVAC and buys software.",
      offerSummary: "Pilot customers in the Triad.",
      mode: "leads",
    });
    assert.ok(draft.body.includes("for leads"));
  });
});

describe("validateBoardyRequestInput", () => {
  it("requires context-rich fields (min length)", () => {
    const { value, errors } = validateBoardyRequestInput({
      targetName: "Alex",
      targetContext: "too short",
      offerSummary: "also way too short",
      tenantName: "Tico",
    });
    assert.ok(value === null);
    assert.ok(errors.some((e) => e.includes("targetContext")));
  });

  it("builds the draft copy when none is supplied", () => {
    const { value } = validateBoardyRequestInput({
      targetName: "Alex Rivera",
      targetContext: "Alex led the fintech seed rounds I most admire and invests in Raleigh.",
      offerSummary: "A warm customer base of 40 NC agencies needing fintech tooling.",
      tenantName: "Tico Hamphill",
      mode: "funding",
    });
    assert.ok(value);
    assert.equal(value.draftedSubject, "Intro request: Tico Hamphill → Alex Rivera");
    assert.ok(value.draftedBody.includes("WHY NOW:"));
  });
});

// ---------------------------------------------------------------------------
// DB: discoverability reversibility + tenant isolation.
// ---------------------------------------------------------------------------

describe("directory profile (DB)", () => {
  it("defaults to invisible; publish → unpublish → republish is reversible", async () => {
    const ws = await makeWorkspace("reversible");
    assert.equal(await dirStore.getDirectoryProfile(ws), null);

    let view = await dirStore.setDirectoryProfile(ws, {
      discoverable: false,
      name: "Tico Hamphill",
      role: "Founder",
    });
    assert.equal(view.discoverable, false);

    view = await dirStore.setDirectoryProfile(ws, { discoverable: true });
    assert.equal(view.discoverable, true);
    assert.equal(view.name, "Tico Hamphill"); // merged, not lost

    view = await dirStore.setDirectoryProfile(ws, { discoverable: false });
    assert.equal(view.discoverable, false);

    view = await dirStore.setDirectoryProfile(ws, { discoverable: true });
    assert.equal(view.discoverable, true);
  });

  it("publishing without any name fails, even via the merge", async () => {
    const ws = await makeWorkspace("noname");
    await dirStore.setDirectoryProfile(ws, { discoverable: false });
    await assertThrowsCode(
      () => dirStore.setDirectoryProfile(ws, { discoverable: true }),
      "publish_requires_name",
      "nameless publish",
    );
  });

  it("per-facet toggles persist", async () => {
    const ws = await makeWorkspace("facets");
    const view = await dirStore.setDirectoryProfile(ws, {
      discoverable: true,
      name: "Tico",
      shareNameRole: true,
      shareFull: true,
      bio: "Builder.",
    });
    assert.equal(view.shareFull, true);
    assert.equal(view.bio, "Builder.");
  });

  it("profiles are tenant-scoped", async () => {
    const a = await makeWorkspace("iso-a");
    const b = await makeWorkspace("iso-b");
    await dirStore.setDirectoryProfile(a, {
      discoverable: true,
      name: "Tenant A",
      role: "Founder",
    });
    assert.equal(await dirStore.getDirectoryProfile(b), null);
    const view = await dirStore.getDirectoryProfile(a);
    assert.equal(view?.name, "Tenant A");
  });
});

// ---------------------------------------------------------------------------
// DB: mutual-discoverability matching — never against the invisible.
// ---------------------------------------------------------------------------

describe("findDirectoryMatches (DB)", () => {
  it("throws when the searcher is not discoverable", async () => {
    const ws = await makeWorkspace("searcher-off");
    await dirStore.setDirectoryProfile(ws, { discoverable: false, name: "Seeker" });
    await assertThrowsCode(
      () => dirStore.findDirectoryMatches(ws, {}),
      "not_discoverable",
      "searcher gate",
    );
  });

  it("matches only mutually-discoverable users, with facet gating", async () => {
    const seeker = await makeWorkspace("seeker");
    const visible = await makeWorkspace("visible");
    const hidden = await makeWorkspace("hidden");

    await dirStore.setDirectoryProfile(seeker, {
      discoverable: true,
      name: "Tico Hamphill",
      role: "Founder",
      industries: ["SaaS"],
    });
    await dirStore.setDirectoryProfile(visible, {
      discoverable: true,
      name: "Dana Whitfield",
      role: "VP Sales",
      company: "Acme",
      bio: "Twenty years in SaaS sales.",
      industries: ["SaaS"],
      lookingFor: "partners",
      shareFull: true,
    });
    await dirStore.setDirectoryProfile(hidden, {
      discoverable: false, // opted OUT — must never match
      name: "Hidden Person",
      role: "CFO",
      industries: ["SaaS"],
    });

    const matches = await dirStore.findDirectoryMatches(seeker, {
      industries: ["SaaS"],
    });
    const names = matches.map((m) => m.profile.name);
    assert.ok(names.includes("Dana Whitfield"), "discoverable candidate matched");
    assert.ok(!names.includes("Hidden Person"), "non-discoverable candidate never matched");
    assert.ok(!names.includes("Tico Hamphill"), "self never matched");

    const dana = matches.find((m) => m.profile.name === "Dana Whitfield");
    assert.ok(dana);
    assert.equal(dana.score, 50);
    assert.equal(dana.profile.company, "Acme"); // full facet published
    assert.equal(dana.profile.bio, "Twenty years in SaaS sales.");
  });

  it("applies facet gating in matches — name+role only hides the rest", async () => {
    const seeker = await makeWorkspace("seeker2");
    const minimal = await makeWorkspace("minimal");
    await dirStore.setDirectoryProfile(seeker, {
      discoverable: true,
      name: "Seeker Two",
      role: "Founder",
    });
    await dirStore.setDirectoryProfile(minimal, {
      discoverable: true,
      name: "Minimal Max",
      role: "CTO",
      company: "Stealth",
      bio: "Secret bio.",
      shareFull: false, // name+role only
    });
    const matches = await dirStore.findDirectoryMatches(seeker, {});
    const max = matches.find((m) => m.profile.name === "Minimal Max");
    assert.ok(max);
    assert.equal(max.profile.role, "CTO");
    assert.equal(max.profile.company, null);
    assert.equal(max.profile.bio, null);
  });
});

// ---------------------------------------------------------------------------
// DB: Boardy escalation rail — approval gating + reply triage.
// ---------------------------------------------------------------------------

describe("boardy rail (DB)", () => {
  const goodInput = {
    targetName: "Alex Rivera",
    targetRole: "Partner, Sequoia",
    targetContext:
      "Alex led the fintech seed rounds I most admire and is actively investing in Raleigh.",
    offerSummary: "A warm customer base of 40 NC agencies who need fintech tooling.",
    tenantName: "Tico Hamphill",
    mode: "funding",
  };

  it("drafts are inert: status=draft, nothing sent, event recorded", async () => {
    const ws = await makeWorkspace("boardy-draft");
    const req = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });
    assert.equal(req.status, "draft");
    assert.equal(req.sentAt, null);
    assert.ok(req.draftedSubject.includes("Alex Rivera"));
    assert.ok(req.events.some((e) => e.kind === "boardy_request_drafted"));
  });

  it("no send without tenant approval — the money test of this rail", async () => {
    const ws = await makeWorkspace("boardy-gate");
    const req = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });
    await assertThrowsCode(
      () => boardy.sendBoardyRequest(ws, req.id, { actor: TENANT, sentVia: "gmail" }),
      "not_approved",
      "send from draft",
    );
    // Still a draft afterwards — the gate didn't move anything.
    const again = await boardy.getBoardyRequest(ws, req.id);
    assert.equal(again.status, "draft");
  });

  it("approve is human-only; send works after approval", async () => {
    const ws = await makeWorkspace("boardy-approve");
    const req = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });

    await assertThrowsCode(
      () => boardy.approveBoardyRequest(ws, req.id, { actor: AGENT }),
      "agent_cannot_act",
      "agent cannot approve",
    );

    const approved = await boardy.approveBoardyRequest(ws, req.id, { actor: TENANT });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, "tico@example.com");
    assert.ok(approved.events.some((e) => e.kind === "boardy_request_approved"));

    const sent = await boardy.sendBoardyRequest(ws, req.id, {
      actor: TENANT,
      sentVia: "gmail",
    });
    assert.equal(sent.status, "sent");
    assert.ok(sent.sentAt);
    const sendEvent = sent.events.find((e) => e.kind === "boardy_request_sent");
    assert.ok(sendEvent);
    assert.ok(sendEvent.message?.includes(BOARDY_EMAIL));
    assert.ok(sendEvent.message?.includes("tenant's own address"));
  });

  it("declined requests can never send", async () => {
    const ws = await makeWorkspace("boardy-decline");
    const req = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });
    const declined = await boardy.declineBoardyRequest(ws, req.id, {
      actor: TENANT,
      reason: "Wrong target.",
    });
    assert.equal(declined.status, "declined");
    await assertThrowsCode(
      () => boardy.sendBoardyRequest(ws, req.id, { actor: TENANT, sentVia: "gmail" }),
      "not_approved",
      "send from declined",
    );
  });

  it("Boardy replies are triaged as priority threads", async () => {
    const ws = await makeWorkspace("boardy-reply");
    let req = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });
    req = await boardy.approveBoardyRequest(ws, req.id, { actor: TENANT });
    req = await boardy.sendBoardyRequest(ws, req.id, { actor: TENANT, sentVia: "gmail" });

    // Reply triage is illegal before the send — covered by the transition law.
    const early = await boardy.draftBoardyRequest(ws, goodInput, { draftedBy: TENANT });
    await assertThrowsCode(
      () => boardy.markBoardyRequestReplied(ws, early.id, { triagedBy: "tico@example.com" }),
      "illegal_boardy_transition",
      "reply before send",
    );

    const replied = await boardy.markBoardyRequestReplied(ws, req.id, {
      summary: "Boardy knows Alex — double-opt-in ask going out Thursday.",
      triagedBy: "tico@example.com",
    });
    assert.equal(replied.status, "replied");
    assert.equal(replied.priorityThread, true);
    assert.ok(replied.repliedAt);
    const triage = replied.events.find((e) => e.kind === "boardy_reply_triaged");
    assert.ok(triage);
    assert.ok(triage.message?.includes("PRIORITY"));
  });

  it("cancel works from draft and approved; requests are tenant-scoped", async () => {
    const a = await makeWorkspace("boardy-a");
    const b = await makeWorkspace("boardy-b");
    const req = await boardy.draftBoardyRequest(a, goodInput, { draftedBy: TENANT });
    const cancelled = await boardy.cancelBoardyRequest(a, req.id, {
      actor: TENANT,
      reason: "Found a warm path instead.",
    });
    assert.equal(cancelled.status, "cancelled");

    await assertThrowsCode(
      () => boardy.getBoardyRequest(b, req.id),
      "boardy_request_not_found",
      "cross-tenant read",
    );
    const list = await boardy.listBoardyRequests(b);
    assert.equal(list.length, 0);
  });
});

// ---------------------------------------------------------------------------
// DB: the native loop never blocks on the Boardy rail.
// ---------------------------------------------------------------------------

describe("native loop never blocks on Boardy", () => {
  function pathSnapshot(mutualId: string, mutualName: string, targetId: string, targetName: string) {
    return {
      target: { kind: "person", id: targetId, name: targetName },
      mutual: { id: mutualId, name: mutualName },
      hops: [
        { kind: "tenant", id: null, name: "Tenant" },
        { kind: "person", id: mutualId, name: mutualName },
        { kind: "person", id: targetId, name: targetName },
      ],
      strength: 0.42,
      components: { tenantWarmth: 70, linkStrength: 0.8, freshness: 0.75 },
      explanation: {
        text: `via ${mutualName} — worked together at Acme (2022–24)`,
        facts: { mutualName, lastTouchText: "3 weeks ago" },
      },
    };
  }

  it("the full native intro lifecycle works with zero Boardy rows", async () => {
    const ws = await makeWorkspace("native-clean");
    const personA = await personStore.addPerson(ws, { name: "Dana", consentedBy: "slice6-test" });
    const personB = await personStore.addPerson(ws, { name: "Alex", consentedBy: "slice6-test" });
    const a = personA.id;
    const b = personB.id;
    let intro = await introStore.proposeIntroduction(
      ws,
      {
        personAId: a,
        personBId: b,
        introPath: pathSnapshot(a, "Dana", b, "Alex"),
        draftAskMessage: "Hi Dana — open to a brief intro to Alex?",
        draftOfferMessage: "Hi Alex — Dana agreed to a brief intro.",
      },
      { proposedBy: "connector-agent", proposerKind: "agent", now: NOW },
    );
    intro = await introStore.approveByTenant(ws, intro.id, {
      approvedBy: "tico@example.com",
      sentVia: "gmail",
    });
    intro = await introStore.acceptSideA(
      ws,
      intro.id,
      { kind: "human", identity: "dana@example.com" },
      { sentVia: "gmail" },
    );
    intro = await introStore.acceptSideB(ws, intro.id, {
      kind: "human",
      identity: "alex@example.com",
    });
    intro = await introStore.makeIntro(ws, intro.id, {
      message: "Dana, meet Alex — Alex, meet Dana.",
      sentVia: "gmail",
      sentBy: "tico@example.com",
    });
    assert.equal(intro.status, "made");
    assert.equal((await boardy.listBoardyRequests(ws)).length, 0);
  });

  it("a failed Boardy draft does not touch the native intro flow", async () => {
    const ws = await makeWorkspace("native-resilient");
    const personA = await personStore.addPerson(ws, { name: "Dana", consentedBy: "slice6-test" });
    const personB = await personStore.addPerson(ws, { name: "Alex", consentedBy: "slice6-test" });
    const a = personA.id;
    const b = personB.id;
    const intro = await introStore.proposeIntroduction(
      ws,
      {
        personAId: a,
        personBId: b,
        introPath: pathSnapshot(a, "Dana", b, "Alex"),
        draftAskMessage: "Hi Dana — open to a brief intro to Alex?",
        draftOfferMessage: "Hi Alex — Dana agreed to a brief intro.",
      },
      { proposedBy: "connector-agent", proposerKind: "agent", now: NOW },
    );
    // The rail rejects a context-poor draft — the native intro is unaffected.
    await assertThrowsCode(
      () =>
        boardy.draftBoardyRequest(
          ws,
          {
            targetName: "Nobody",
            targetContext: "x",
            offerSummary: "y",
            tenantName: "Tico",
          },
          { draftedBy: TENANT },
        ),
      "invalid_boardy_request",
      "context-poor draft",
    );
    const fetched = await introStore.getIntroductionDetail(ws, intro.id);
    assert.equal(fetched.status, "proposed");
    assert.equal((await boardy.listBoardyRequests(ws)).length, 0);
  });

  it("Boardy requests never create introduction rows", async () => {
    const ws = await makeWorkspace("native-untouched");
    const before = await introStore.listIntroductions(ws, {});
    await boardy.draftBoardyRequest(
      ws,
      {
        targetName: "Alex Rivera",
        targetContext: "Alex led the fintech seed rounds I most admire and invests in Raleigh.",
        offerSummary: "A warm customer base of 40 NC agencies needing fintech tooling.",
        tenantName: "Tico Hamphill",
      },
      { draftedBy: TENANT },
    );
    const after = await introStore.listIntroductions(ws, {});
    assert.equal(after.length, before.length);
  });
});
