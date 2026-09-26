// Marketr — Phase 10 M8 tests: draft queueing (taste gate + inbox sink).
// Run: npx tsx --test lib/intelligence/community/__tests__/drafts.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { queueCommunityDraft } from "../drafts";
import { COMMUNITY_DRAFT_ACTION, COMMUNITY_DRAFT_TIER } from "../types";
import type { ExpertiseProfile, ScoredOpportunity } from "../types";
import type { MissionApprovalStore } from "@/lib/authority/executor";

const OPPORTUNITY: ScoredOpportunity = {
  source: "hacker_news",
  externalId: "42424242",
  title: "Ask HN: How do you do keyword research in 2026?",
  url: "https://news.ycombinator.com/item?id=42424242",
  author: "indiehacker",
  text: "Looking for workflows that don't cost $200/mo.",
  points: 87,
  createdAt: new Date("2026-09-26T10:00:00Z"),
  score: 62,
  signals: ["expertise_match"],
  matchedKeywords: ["keyword research"],
  relevanceReason: "matches your expertise: keyword research",
};

const PROFILE: ExpertiseProfile = {
  trackedKeywords: ["keyword research"],
  competitorDomains: [],
  projectDomains: [],
};

const GOOD_DRAFT =
  "We do keyword research brief-first: the writer sees the target query " +
  "before drafting. Cut our rewrite rate roughly in half last quarter. " +
  "Happy to share the template structure if useful.";

function fakeStore() {
  const created: {
    workspaceId: string;
    action: string;
    tier: number;
    bindingJson: Record<string, unknown>;
    createdBy: string;
    missionId: string | null;
  }[] = [];
  const store = {
    async create(input: {
      workspaceId: string;
      missionId?: string | null;
      action: string;
      tier: number;
      bindingJson: Record<string, unknown>;
      createdBy: string;
    }) {
      const row = {
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        action: input.action,
        tier: input.tier,
        bindingJson: input.bindingJson,
        createdBy: input.createdBy,
      };
      created.push(row);
      return { id: `ap_${created.length}`, ...row } as never;
    },
  };
  return { store: store as unknown as MissionApprovalStore, created };
}

describe("queueCommunityDraft", () => {
  it("queues a passing draft as a Tier-2 community_reply_draft approval", async () => {
    const { store, created } = fakeStore();
    const r = await queueCommunityDraft(
      {
        workspaceId: "ws_1",
        createdBy: "m8-test",
        opportunity: OPPORTUNITY,
        draft: GOOD_DRAFT,
      },
      { approvalStore: store },
    );
    assert.equal(r.queued, true);
    assert.equal(r.approvalId, "ap_1");
    assert.equal(r.taste.ok, true);
    assert.equal(created.length, 1);
    const [row] = created;
    assert.equal(row.action, COMMUNITY_DRAFT_ACTION);
    assert.equal(row.tier, COMMUNITY_DRAFT_TIER);
    assert.equal(row.workspaceId, "ws_1");
    assert.equal(row.missionId, null);
    // bindingJson key order: source → thread → reason → draft (inbox summary)
    const keys = Object.keys(row.bindingJson);
    assert.deepEqual(keys.slice(0, 4), ["source", "thread", "reason", "draft"]);
    assert.equal(row.bindingJson.draft, GOOD_DRAFT);
    assert.equal(row.bindingJson.threadUrl, OPPORTUNITY.url);
  });

  it("NEVER queues a draft that fails taste — reported, not created", async () => {
    const { store, created } = fakeStore();
    const rejected: { failures: string[] }[] = [];
    const r = await queueCommunityDraft(
      {
        workspaceId: "ws_1",
        createdBy: "m8-test",
        opportunity: OPPORTUNITY,
        draft: "🚀 Great question! Our cutting-edge platform is a game-changer!!",
      },
      { approvalStore: store, onTasteReject: (x) => rejected.push(x) },
    );
    assert.equal(r.queued, false);
    assert.equal(r.approvalId, null);
    assert.equal(r.taste.ok, false);
    assert.equal(created.length, 0, "failing draft must not create an approval");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].failures.length >= 2);
  });

  it("generates via the LLM path and re-checks taste before queueing", async () => {
    const { store, created } = fakeStore();
    let prompts = 0;
    const r = await queueCommunityDraft(
      {
        workspaceId: "ws_1",
        createdBy: "m8-test",
        opportunity: OPPORTUNITY,
        profile: PROFILE,
      },
      {
        approvalStore: store,
        generate: async (prompt: string) => {
          prompts++;
          assert.match(prompt, /keyword research/, "prompt carries thread context");
          return GOOD_DRAFT;
        },
      },
    );
    assert.equal(prompts, 1);
    assert.equal(r.queued, true);
    assert.equal(created.length, 1);
  });

  it("throws without workspaceId (fail-closed tenancy)", async () => {
    const { store } = fakeStore();
    await assert.rejects(
      () =>
        queueCommunityDraft(
          { workspaceId: "", createdBy: "x", opportunity: OPPORTUNITY, draft: GOOD_DRAFT },
          { approvalStore: store },
        ),
      /workspaceId is required/,
    );
  });
});
