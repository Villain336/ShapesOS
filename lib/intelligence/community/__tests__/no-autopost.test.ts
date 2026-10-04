// Marketr — Phase 10 M8 tests: the no-autopost invariant.
//
// STRUCTURAL: Marketr never holds credentials to post on the user's behalf
// and never autoposts. This test enforces it two ways:
//   1. STATIC: no source file under lib/intelligence/community may contain
//      a publish/submit sink (Reddit's token-refresh POST is allow-listed).
//   2. BEHAVIORAL: a full scanCommunity run with a spy fetch must never
//      issue a request to a publish endpoint — every outbound call is a
//      read (search/list/token), and the only write is the approval-inbox
//      creator.
// Run: npx tsx --test lib/intelligence/community/__tests__/no-autopost.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { scanCommunity } from "../scanner";
import { COMMUNITY_DRAFT_ACTION, COMMUNITY_DRAFT_TIER } from "../types";
import type { ExpertiseProfile } from "../types";
import type { MissionApprovalStore } from "@/lib/authority/executor";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(HERE, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "__tests__") continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("no-autopost invariant (static)", () => {
  // Substrings that would indicate a publishing code path. Reddit's
  // OAuth token refresh POST is the single allow-listed exception and is
  // asserted separately to stay a refresh-only call.
  const FORBIDDEN = [
    "/api/submit",
    "api/v1/submit",
    "action=submit",
    ".submit(",
    "compose?text",
    "/post.json",
    "publish(",
    "autoPost",
    "auto_post",
  ];

  it("no module source contains a publish/submit sink", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(MODULE_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const token of FORBIDDEN) {
        if (src.includes(token)) violations.push(`${file}: ${token}`);
      }
    }
    assert.deepEqual(violations, [], "publish sinks found — M8 must be draft-first");
  });

  it("the Reddit adapter's only POST is the OAuth token refresh", () => {
    const src = readFileSync(join(MODULE_DIR, "sources", "reddit.ts"), "utf8");
    const posts = [...src.matchAll(/method:\s*"POST"/g)];
    assert.equal(posts.length, 1, "exactly one POST allowed in the Reddit adapter");
    assert.ok(
      src.includes("https://www.reddit.com/api/v1/access_token"),
      "the single POST must be the token refresh",
    );
  });

  it("the module's only write sink is the approval-inbox creator", () => {
    const src = readFileSync(join(MODULE_DIR, "drafts.ts"), "utf8");
    assert.ok(src.includes("mission_approval.create") || src.includes("store.create"),
      "drafts.ts must create approvals via the store");
    assert.ok(
      !/fetch\s*\(/.test(src),
      "drafts.ts must not issue HTTP itself (no publish path)",
    );
  });
});

describe("no-autopost invariant (behavioral)", () => {
  const HN_FIXTURE = {
    hits: [
      {
        objectID: "99",
        title: "Ask HN: keyword research workflows?",
        url: null,
        author: "a",
        points: 10,
        num_comments: 5,
        created_at: "2026-09-26T10:00:00.000Z",
        story_text: "How do you do keyword research on a budget?",
        _tags: ["story"],
      },
    ],
  };

  const PROFILE: ExpertiseProfile = {
    trackedKeywords: ["keyword research"],
    competitorDomains: [],
    projectDomains: [],
  };

  function fakeStore(): MissionApprovalStore & { created: Record<string, unknown>[] } {
    const created: Record<string, unknown>[] = [];
    const store = {
      created,
      async get() { return null; },
      async create(input: {
        workspaceId: string; missionId?: string | null; action: string; tier: number;
        bindingJson: Record<string, unknown>; createdBy: string;
      }) {
        created.push(input);
        return { id: "ap_test_1", ...input, missionId: input.missionId ?? null,
          bindingHash: "hash", status: "pending", expiresAt: new Date(),
          decidedAt: null, createdBy: input.createdBy, createdAt: new Date() } as never;
      },
      async setStatus() { throw new Error("unused"); },
      async appendEvent() { throw new Error("unused"); },
    };
    return store as unknown as MissionApprovalStore & { created: Record<string, unknown>[] };
  }

  it("a full scan issues no publish request; drafts land in the inbox only", async () => {
    const requests: { method: string; url: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: (init?.method ?? "GET").toUpperCase(), url: String(url) });
      return new Response(JSON.stringify(HN_FIXTURE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const store = fakeStore();
    const report = await scanCommunity(
      { workspaceId: "ws_test", createdBy: "m8-test", reddit: null, rssFeeds: [], maxDrafts: 3 },
      {
        fetchImpl,
        approvalStore: store,
        // Pinned clock: ranking decays with thread age, so a wall clock would
        // age the fixture out (it did, on 2026-10-04).
        clock: () => new Date("2026-09-27T10:00:00.000Z"),
        loadProfile: async () => PROFILE,
        generate: async () =>
          "We do keyword research with a brief-first workflow. Happy to share the template.",
      },
    );

    // Every outbound HTTP call was a read (HN search GET). No POST/PUT/PATCH
    // to any community platform — publishing is impossible by construction.
    assert.ok(requests.length > 0, "scan should have issued read requests");
    for (const r of requests) {
      assert.equal(r.method, "GET", `non-GET request issued: ${r.method} ${r.url}`);
      assert.ok(
        !/submit|publish|post\.json|api\/v1\/me/i.test(r.url),
        `publish-like URL requested: ${r.url}`,
      );
    }

    // The draft reached exactly one sink: the Phase 9 approval inbox.
    assert.equal(report.queued.length, 1);
    assert.equal(store.created.length, 1);
    const created = store.created[0] as { action: string; tier: number; bindingJson: Record<string, unknown> };
    assert.equal(created.action, COMMUNITY_DRAFT_ACTION);
    assert.equal(created.tier, COMMUNITY_DRAFT_TIER);
    assert.ok(typeof created.bindingJson.draft === "string");
    assert.ok(typeof created.bindingJson.threadUrl === "string");
  });
});
