// Marketr — Phase 10 M4: robots.txt parsing + enforcement tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/robots.test.ts
//
// The flagship assertion: a URL disallowed by robots.txt is NEVER fetched.
// That is enforced at the detect.ts integration level with a mocked fetcher.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  crawlDelayFor,
  isAllowed,
  parseRobots,
  selectGroup,
  FLEET_BOT_TOKEN,
} from "../robots";
import { runChangeDetection } from "../detect";
import { PoliteFetcher } from "../polite-fetch";
import { createRobotsCache } from "../robots";
import type { TxClient } from "@/lib/substrate/graph/rls";

const ROBOTS_FIXTURE = `
User-agent: *
Disallow: /private/
Disallow: /tmp/*.pdf$
Allow: /private/public-page
Crawl-delay: 3

User-agent: marketr-competitorfleet
Disallow: /blocked-for-us/
`;

describe("parseRobots", () => {
  it("parses groups, allow/disallow, crawl-delay", () => {
    const rules = parseRobots(ROBOTS_FIXTURE);
    assert.equal(rules.groups.length, 2);
    assert.deepEqual(rules.groups[0].agents, ["*"]);
    assert.deepEqual(rules.groups[0].disallow, ["/private/", "/tmp/*.pdf$"]);
    assert.equal(rules.groups[0].crawlDelay, 3);
  });

  it("ignores comment text and blank lines", () => {
    const rules = parseRobots(`# comment\nUser-agent: * # inline\nDisallow: /x # trailing`);
    assert.deepEqual(rules.groups[0].agents, ["*"]);
    assert.deepEqual(rules.groups[0].disallow, ["/x"]);
  });
});

describe("selectGroup", () => {
  it("prefers the most specific matching group over *", () => {
    const rules = parseRobots(ROBOTS_FIXTURE);
    const g = selectGroup(rules, FLEET_BOT_TOKEN);
    assert.ok(g, "expected a group");
    assert.deepEqual(g.disallow, ["/blocked-for-us/"]);
  });

  it("falls back to * when no specific group matches", () => {
    const rules = parseRobots(`User-agent: otherbot\nDisallow: /a\n\nUser-agent: *\nDisallow: /b`);
    const g = selectGroup(rules, FLEET_BOT_TOKEN);
    assert.ok(g);
    assert.deepEqual(g.disallow, ["/b"]);
  });

  it("returns null when nothing matches → allow-all", () => {
    const rules = parseRobots(`User-agent: otherbot\nDisallow: /a`);
    assert.equal(selectGroup(rules, FLEET_BOT_TOKEN), null);
  });
});

describe("isAllowed", () => {
  const rules = parseRobots(ROBOTS_FIXTURE);
  // Our bot token matches the specific group → only /blocked-for-us/ is
  // disallowed for us.
  it("longest match wins; Allow beats Disallow on ties", () => {
    assert.equal(isAllowed(rules, FLEET_BOT_TOKEN, "https://comp.example/blocked-for-us/x"), false);
    assert.equal(isAllowed(rules, FLEET_BOT_TOKEN, "https://comp.example/anything-else"), true);
  });

  it("wildcard group semantics: prefix, * and $ patterns", () => {
    const wildcard = parseRobots(`User-agent: *\nDisallow: /private/\nAllow: /private/public-page\nDisallow: /tmp/*.pdf$`);
    assert.equal(isAllowed(wildcard, "some-other-bot", "https://x.example/private/secret"), false);
    // longer Allow (/private/public-page, 20 chars) beats Disallow (/private/, 9)
    assert.equal(isAllowed(wildcard, "some-other-bot", "https://x.example/private/public-page"), true);
    assert.equal(isAllowed(wildcard, "some-other-bot", "https://x.example/tmp/doc.pdf"), false);
    assert.equal(isAllowed(wildcard, "some-other-bot", "https://x.example/tmp/doc.pdf?a=1"), true, "$ anchors the pattern");
  });
});

describe("crawlDelayFor", () => {
  it("reads crawl-delay from the winning group", () => {
    const rules = parseRobots(ROBOTS_FIXTURE);
    assert.equal(crawlDelayFor(rules, FLEET_BOT_TOKEN), undefined, "our group has no delay");
    assert.equal(crawlDelayFor(rules, "some-other-bot"), 3);
  });
});

describe("runChangeDetection robots enforcement", () => {
  function fakeTx() {
    return {
      graphNode: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
      competitorChange: {
        create: async () => ({}),
      },
    } as unknown as TxClient;
  }

  it("a disallowed URL is NEVER fetched — robots.txt is authoritative", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      fetched.push(u);
      const text =
        u === "https://comp.example/robots.txt"
          ? "User-agent: *\nDisallow: /private/\n"
          : "<html><title>T</title><body>hello world</body></html>";
      return new Response(text, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    const fetcher = new PoliteFetcher({
      fetchImpl,
      minDelayMs: 0, // speed up the test; the politeness suite covers delays
      sleep: async () => {},
    });

    const result = await runChangeDetection({
      tx: fakeTx(),
      workspaceId: "ws_test",
      watch: { id: "watch_1", competitorDomain: "comp.example" },
      trackedUrls: [
        "https://comp.example/private/secret-page", // disallowed
        "https://comp.example/public-page", // allowed
      ],
      fetcher,
      robotsCache: createRobotsCache(),
    });

    assert.ok(
      fetched.every((u) => !u.includes("/private/")),
      `disallowed URL must never be fetched; got: ${fetched.join(", ")}`,
    );
    assert.deepEqual(result.skippedRobots, ["https://comp.example/private/secret-page"]);
    // public page fetched → baseline snapshot stored, not a change
    assert.equal(result.checked, 1);
    assert.equal(result.changed, 0);
  });

  it("second pass over unchanged content emits no change rows", async () => {
    const html = "<html><title>T</title><body>stable content</body></html>";
    let snapshots: Record<string, unknown> = {};
    const tx = {
      graphNode: {
        findUnique: async () => (snapshots ? { properties: { snapshots } } : null),
        upsert: async (args: { create: { properties: unknown } }) => {
          snapshots = (args.create.properties as { snapshots: Record<string, unknown> }).snapshots;
          return {};
        },
      },
      competitorChange: { create: async () => ({}) },
    } as unknown as TxClient;

    const mkFetcher = () =>
      new PoliteFetcher({
        fetchImpl: (async () =>
          new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch,
        minDelayMs: 0,
        sleep: async () => {},
      });

    const first = await runChangeDetection({
      tx,
      workspaceId: "ws_test",
      watch: { id: "watch_2", competitorDomain: "comp.example" },
      trackedUrls: ["https://comp.example/page"],
      fetcher: mkFetcher(),
      robotsCache: createRobotsCache(),
    });
    assert.equal(first.changed, 0, "first sighting stores baseline, no change row");

    const second = await runChangeDetection({
      tx,
      workspaceId: "ws_test",
      watch: { id: "watch_2", competitorDomain: "comp.example" },
      trackedUrls: ["https://comp.example/page"],
      fetcher: mkFetcher(),
      robotsCache: createRobotsCache(),
    });
    assert.equal(second.changed, 0, "unchanged content → no change row");
    assert.equal(second.checked, 1);
  });
});
