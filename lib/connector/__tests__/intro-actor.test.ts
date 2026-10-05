// ShapesOS — Phase 1: connector intro actions take the actor from the
// session, never the request body. DB-backed (scripts/test/db-tests.txt);
// the session is stubbed with node:test mock.module.

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../prisma";
import { PrismaConnectorStore } from "../prisma-store";
import { PrismaIntroductionStore } from "../introduction-store";

const USER = { id: "p1-intro-editor", email: "editor@intro.test" };
let wsId = "";

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => USER,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: wsId } }),
  },
});

const people = new PrismaConnectorStore(prisma);
const store = new PrismaIntroductionStore(prisma);

async function approvedIntro() {
  const a = await people.addPerson(wsId, { name: "Dana Whitfield", consentedBy: "p1-test" });
  const b = await people.addPerson(wsId, { name: "Alex Rivera", consentedBy: "p1-test" });
  const intro = await store.proposeIntroduction(
    wsId,
    {
      personAId: a.id,
      personBId: b.id,
      introPath: {
        target: { kind: "person", id: b.id, name: "Alex Rivera" },
        mutual: { id: a.id, name: "Dana Whitfield" },
        hops: [
          { kind: "tenant", id: null, name: "Tenant" },
          { kind: "person", id: a.id, name: "Dana Whitfield" },
          { kind: "person", id: b.id, name: "Alex Rivera" },
        ],
        strength: 0.42,
        components: { tenantWarmth: 70, linkStrength: 0.8, freshness: 0.75 },
        explanation: {
          text: "via Dana Whitfield — worked together at Acme",
          facts: {
            mutualName: "Dana Whitfield",
            sharedCompany: "Acme",
            overlapStart: 2022,
            overlapEnd: 2024,
            lastTouchText: "3 weeks ago",
            notes: null,
          },
        },
      },
      draftAskMessage:
        "Hi Dana — would you be open to a brief intro to Alex Rivera at Northwind? No worries at all if the timing is off.",
      draftOfferMessage:
        "Hi Alex — Dana Whitfield agreed to a brief intro. Open to a 20-minute chat next week?",
    },
    { proposedBy: "connector-agent", proposerKind: "agent" },
  );
  return store.approveByTenant(wsId, intro.id, { approvedBy: USER.email, sentVia: "gmail" });
}

const post = (body: unknown) =>
  new Request("http://x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("connector intro actor comes from the session", () => {
  before(async () => {
    const ws = await prisma.workspace.create({ data: { name: "p1-intro-ws", ownerUserId: "p1-intro-owner" } });
    wsId = ws.id;
    await prisma.workspaceMember.create({ data: { workspaceId: wsId, userId: USER.id, role: "editor", email: USER.email } });
  });
  after(async () => {
    await prisma.workspace.delete({ where: { id: wsId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it("a forged body identity is recorded as the respondent, not as the actor", async () => {
    const { handleAcceptA } = await import("@/app/api/connector/intros/action-handlers");
    const intro = await approvedIntro();
    const res = await handleAcceptA(
      post({ actor: { kind: "human", identity: "ceo@victim.test" }, sentVia: "gmail", note: "keen" }),
      intro.id,
    );
    assert.equal(res.status, 200);
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id: intro.id } });
    assert.equal(row.sideAAcceptedBy, USER.email);
    const events = await prisma.connectorIntroductionEvent.findMany({ where: { introductionId: intro.id } });
    const accepted = events.find((e) => e.kind === "side_a_accepted");
    assert.ok(accepted);
    assert.equal(accepted.actorIdentity, USER.email);
    assert.match(accepted.message ?? "", /Response from ceo@victim\.test\. keen/);
  });

  it("a body can't switch the actor kind to agent", async () => {
    const { handleDeclineA } = await import("@/app/api/connector/intros/action-handlers");
    const intro = await approvedIntro();
    const res = await handleDeclineA(post({ actor: { kind: "agent", identity: "connector-agent" } }), intro.id);
    assert.equal(res.status, 200);
    const row = await prisma.connectorIntroduction.findUniqueOrThrow({ where: { id: intro.id } });
    assert.equal(row.status, "declined");
    const events = await prisma.connectorIntroductionEvent.findMany({ where: { introductionId: intro.id } });
    const declined = events.filter((e) => e.actorKind === "side_a");
    assert.ok(declined.length > 0);
    for (const e of declined) assert.equal(e.actorIdentity, USER.email);
  });
});
