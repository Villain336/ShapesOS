// Phase 11 (devtools): Linear adapter — GraphQL request shapes, cursor
// pagination, GraphQL error mapping, read backoff vs never-retried writes,
// refresh-on-401, the OAuth entry and the grant mapping. fetch is scripted
// against Linear's documented GraphQL envelopes (no network).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/linear.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LinearAdapter } from "../../native/linear";
import { LINEAR_GRAPHQL, linearClassify, linearErrorCode } from "../linear";
import { OAUTH_CONFIGS, startOAuthFlow } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const TEAM = "9cfb482a-81e3-4154-b5b9-2c805e70a02d";
const STATE = "1f0c2b6e-7f1d-4c1e-9a0b-3e3f1d2c4b5a";

const issueNode = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  identifier: `ENG-${n}`,
  title: `Issue ${n}`,
  priority: 2,
  url: `https://linear.app/acme/issue/ENG-${n}`,
  updatedAt: "2026-10-01T00:00:00Z",
  state: { name: "Todo", type: "unstarted" },
  assignee: { name: "Ada" },
  team: { key: "ENG" },
  project: null,
});

function adapter(script: Parameters<typeof scriptedFetch>[0]) {
  const f = scriptedFetch(script);
  const { deps, sleeps } = liveDeps(f.fetchImpl);
  return { a: new LinearAdapter(deps), f, sleeps };
}

describe("Linear reads", () => {
  it("list_teams: POST /graphql with the bearer token and a teams query", async () => {
    const { a, f } = adapter([jsonResponse(200, { data: { teams: { nodes: [{ id: TEAM, key: "ENG", name: "Engineering" }] } } })]);
    const r = await a.invoke("list_teams", {}, oauthCred("lin-tok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(r.mock, false);
    assert.deepEqual(r.data, [{ id: TEAM, key: "ENG", name: "Engineering" }]);
    const c = f.calls[0];
    assert.equal(c.url.href, LINEAR_GRAPHQL);
    assert.equal(c.method, "POST");
    assert.equal(c.headers.authorization, "Bearer lin-tok");
    assert.match((c.body as { query: string }).query, /teams\(first: 100\)/);
  });

  it("list_issues: team + state-type filter, pages the cursor connection up to the limit", async () => {
    const page1 = { data: { issues: { nodes: [issueNode(1), issueNode(2)], pageInfo: { hasNextPage: true, endCursor: "c1" } } } };
    const page2 = { data: { issues: { nodes: [issueNode(3)], pageInfo: { hasNextPage: true, endCursor: "c2" } } } };
    const { a, f } = adapter([jsonResponse(200, page1), jsonResponse(200, page2)]);
    const r = await a.invoke("list_issues", { teamId: TEAM, stateType: "Started", limit: 3 }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    const data = r.data as { issues: Array<{ identifier: string; state: string; team: string }>; nextCursor: string | null };
    assert.deepEqual(data.issues.map((i) => i.identifier), ["ENG-1", "ENG-2", "ENG-3"]);
    assert.equal(data.issues[0].state, "Todo");
    assert.equal(data.nextCursor, "c2", "more remain → cursor to continue");
    const v1 = (f.calls[0].body as { variables: Record<string, unknown> }).variables;
    assert.deepEqual(v1.filter, { team: { id: { eq: TEAM } }, state: { type: { eq: "started" } } });
    assert.equal(v1.first, 3);
    assert.equal(v1.after, null);
    const v2 = (f.calls[1].body as { variables: Record<string, unknown> }).variables;
    assert.equal(v2.after, "c1");
    assert.equal(v2.first, 1);
  });

  it("list_issues: stops when hasNextPage is false; a bad stateType or teamId is bad_request (no call)", async () => {
    const { a, f } = adapter([jsonResponse(200, { data: { issues: { nodes: [issueNode(1)], pageInfo: { hasNextPage: false, endCursor: "x" } } } })]);
    const r = await a.invoke("list_issues", { limit: 50 }, oauthCred(), ctxWith());
    assert.equal((r.data as { nextCursor: unknown }).nextCursor, null);
    assert.equal((f.calls[0].body as { variables: { filter: unknown } }).variables.filter, null);
    for (const args of [{ stateType: "doing" }, { teamId: "ENG" }]) {
      const bad = await a.invoke("list_issues", args, oauthCred(), ctxWith());
      assert.equal(bad.ok, false);
      assert.equal(bad.errorCode, "bad_request", JSON.stringify(args));
    }
    assert.equal(f.calls.length, 1);
  });

  it("search_issues: searchIssues(term) and requires a query", async () => {
    const { a, f } = adapter([jsonResponse(200, { data: { searchIssues: { nodes: [issueNode(7)] } } })]);
    const r = await a.invoke("search_issues", { query: "signup bug", limit: 5 }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal((r.data as Array<{ identifier: string }>)[0].identifier, "ENG-7");
    const body = f.calls[0].body as { query: string; variables: Record<string, unknown> };
    assert.match(body.query, /searchIssues\(term: \$term, first: \$first\)/);
    assert.deepEqual(body.variables, { term: "signup bug", first: 5 });
    const missing = await a.invoke("search_issues", {}, oauthCred(), ctxWith());
    assert.equal(missing.errorCode, "bad_request");
  });

  it("RATELIMITED (HTTP 400 GraphQL envelope) on a read backs off and retries", async () => {
    const limited = jsonResponse(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] });
    const { a, f, sleeps } = adapter([limited, jsonResponse(200, { data: { projects: { nodes: [{ id: "p1", name: "Relaunch", state: "started", progress: 0.5 }] } } })]);
    const r = await a.invoke("list_projects", {}, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls.length, 2);
    assert.equal(sleeps.length, 1);
    assert.deepEqual(r.data, [{ id: "p1", name: "Relaunch", state: "started", progress: 0.5, targetDate: null, url: null }]);
  });

  it("a GraphQL error with HTTP 200 becomes a closed error code (no retry)", async () => {
    const { a, f } = adapter([jsonResponse(200, { errors: [{ message: "Entity not found", extensions: { code: "ENTITY_NOT_FOUND" } }] })]);
    const r = await a.invoke("list_teams", {}, oauthCred(), ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "not_found");
    assert.equal(f.calls.length, 1);
  });

  it("401 → one refresh through the vault, then the retry carries the new token", async () => {
    const { a, f } = adapter([
      jsonResponse(401, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
      jsonResponse(200, { data: { viewer: { id: "u1", name: "Ada" } } }),
    ]);
    const ctx = refreshingCtx();
    const r = await a.healthCheck(oauthCred("old"), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.equal(f.calls[1].headers.authorization, "Bearer tok-2");
  });

  it("a token refreshed on page 1 is reused for page 2 (refresh is one-shot)", async () => {
    const { a, f } = adapter([
      jsonResponse(401, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] }),
      jsonResponse(200, { data: { issues: { nodes: [issueNode(1)], pageInfo: { hasNextPage: true, endCursor: "c1" } } } }),
      jsonResponse(200, { data: { issues: { nodes: [issueNode(2)], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    ]);
    const ctx = refreshingCtx();
    const r = await a.invoke("list_issues", { limit: 10 }, oauthCred("old"), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.deepEqual(f.calls.map((c) => c.headers.authorization), ["Bearer old", "Bearer tok-2", "Bearer tok-2"]);
  });
});

describe("Linear writes (never retried)", () => {
  it("create_issue: issueCreate with a validated input", async () => {
    const { a, f } = adapter([jsonResponse(200, { data: { issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-9", title: "Fix signup", url: "https://linear.app/acme/issue/ENG-9" } } } })]);
    const r = await a.invoke("create_issue", { teamId: TEAM, title: "  Fix signup ", description: "Steps…", priority: 2, stateId: STATE }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { id: "i1", identifier: "ENG-9", title: "Fix signup", url: "https://linear.app/acme/issue/ENG-9" });
    const body = f.calls[0].body as { query: string; variables: { input: Record<string, unknown> } };
    assert.match(body.query, /issueCreate\(input: \$input\)/);
    assert.deepEqual(body.variables.input, { teamId: TEAM, title: "Fix signup", description: "Steps…", priority: 2, stateId: STATE });
  });

  it("create_issue: a rate limit is NOT retried (a retry could create the issue twice)", async () => {
    const { a, f, sleeps } = adapter([jsonResponse(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] })]);
    const r = await a.invoke("create_issue", { teamId: TEAM, title: "x" }, oauthCred(), ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "rate_limited");
    assert.equal(f.calls.length, 1);
    assert.equal(sleeps.length, 0);
  });

  it("create_issue: a 5xx is not retried either", async () => {
    const { a, f } = adapter([jsonResponse(503, { message: "unavailable" })]);
    const r = await a.invoke("create_issue", { teamId: TEAM, title: "x" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "provider_error");
    assert.equal(f.calls.length, 1);
  });

  it("create_issue: input checks are bad_request and make no call", async () => {
    const { a, f } = adapter([]);
    for (const args of [{ teamId: TEAM }, { title: "t" }, { teamId: TEAM, title: "t", priority: 9 }]) {
      const r = await a.invoke("create_issue", args, oauthCred(), ctxWith());
      assert.equal(r.errorCode, "bad_request", JSON.stringify(args));
    }
    assert.equal(f.calls.length, 0);
  });

  it("update_issue: accepts an issue key, needs at least one change", async () => {
    const { a, f } = adapter([jsonResponse(200, { data: { issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-9", title: "T", url: null, state: { name: "In Progress", type: "started" } } } } })]);
    const r = await a.invoke("update_issue", { issueId: "ENG-9", stateId: STATE }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal((r.data as { state: string }).state, "In Progress");
    assert.deepEqual((f.calls[0].body as { variables: unknown }).variables, { id: "ENG-9", input: { stateId: STATE } });
    const none = await a.invoke("update_issue", { issueId: "ENG-9" }, oauthCred(), ctxWith());
    assert.equal(none.errorCode, "bad_request");
  });

  it("add_comment: commentCreate; success:false is a failure, not a fake success", async () => {
    const { a, f } = adapter([
      jsonResponse(200, { data: { commentCreate: { success: true, comment: { id: "c1", url: "https://linear.app/c1" } } } }),
      jsonResponse(200, { data: { commentCreate: { success: false } } }),
    ]);
    const ok = await a.invoke("add_comment", { issueId: "ENG-9", body: "Done in #42" }, oauthCred(), ctxWith());
    assert.deepEqual(ok.data, { id: "c1", url: "https://linear.app/c1" });
    assert.deepEqual((f.calls[0].body as { variables: unknown }).variables, { input: { issueId: "ENG-9", body: "Done in #42" } });
    const bad = await a.invoke("add_comment", { issueId: "ENG-9", body: "x" }, oauthCred(), ctxWith());
    assert.equal(bad.ok, false);
    assert.equal(bad.errorCode, "provider_error");
  });
});

describe("Linear wiring", () => {
  it("error code mapping and classifier", () => {
    assert.equal(linearErrorCode("RATELIMITED"), "rate_limited");
    assert.equal(linearErrorCode("AUTHENTICATION_ERROR"), "auth_rejected");
    assert.equal(linearErrorCode("FORBIDDEN"), "forbidden");
    assert.equal(linearErrorCode("whatever"), "bad_request");
    assert.equal(linearClassify(400, { errors: [{ extensions: { code: "RATELIMITED" } }] }).retryable, true);
    assert.equal(linearClassify(401, null).authExpired, true);
  });

  it("mock mode (no credential) is labelled and writes nothing", async () => {
    const a = new LinearAdapter();
    const r = await a.invoke("create_issue", { teamId: TEAM, title: "x" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal((r.data as { written: boolean }).written, false);
  });

  it("OAuth: Linear authorize URL with comma-separated read,write scopes", () => {
    assert.equal(OAUTH_CONFIGS.linear.tokenUrl, "https://api.linear.app/oauth/token");
    process.env.MARKETR_CREDENTIALS_KEY ||= "0".repeat(64);
    const prev = process.env.LINEAR_OAUTH_CLIENT_ID;
    process.env.LINEAR_OAUTH_CLIENT_ID = "lin-client";
    try {
      const { url } = startOAuthFlow("u1", "ws1", "linear", "https://app.example.com");
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, "https://linear.app/oauth/authorize");
      assert.equal(u.searchParams.get("scope"), "read,write");
      assert.equal(u.searchParams.get("client_id"), "lin-client");
      assert.equal(u.searchParams.get("code_challenge"), null, "Linear does not use PKCE here");
    } finally {
      if (prev === undefined) delete process.env.LINEAR_OAUTH_CLIENT_ID;
      else process.env.LINEAR_OAUTH_CLIENT_ID = prev;
    }
  });

  it("grants: ops group; issue writes are Tier-2 write_project_record", () => {
    assert.equal(connectorGroup("linear"), "ops");
    for (const t of ["create_issue", "update_issue", "add_comment"]) assert.equal(connectorAction("linear", t), "write_project_record");
  });
});
