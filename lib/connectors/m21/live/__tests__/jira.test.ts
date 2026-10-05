// Phase 11 (devtools): Jira Cloud adapter — site resolution through
// accessible-resources, REST v3 request shapes, startAt / nextPageToken
// pagination, ADF bodies, transitions by name, error envelopes, read backoff
// vs never-retried writes, the OAuth entry and the grant mapping. fetch is
// scripted against Atlassian's documented responses (no network).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/jira.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JiraAdapter } from "../../native/jira";
import { adfToText, textToAdf } from "../jira";
import { OAUTH_CONFIGS, startOAuthFlow } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

const CLOUD = "11223344-a1b2-4c3d-8e9f-001122334455";
const CLOUD2 = "99887766-a1b2-4c3d-8e9f-001122334455";
const BASE = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;
const sites = (extra: unknown[] = []) =>
  jsonResponse(200, [{ id: CLOUD, url: "https://acme.atlassian.net", name: "acme", scopes: ["read:jira-work", "write:jira-work"] }, ...extra]);

const raw = (n: number) => ({
  id: String(10000 + n),
  key: `OPS-${n}`,
  fields: {
    summary: `Issue ${n}`,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Task" },
    priority: { name: "High" },
    assignee: { displayName: "Ada" },
    updated: "2026-10-01T10:00:00.000+0000",
  },
});

function adapter(script: Parameters<typeof scriptedFetch>[0]) {
  const f = scriptedFetch(script);
  const { deps, sleeps } = liveDeps(f.fetchImpl);
  return { a: new JiraAdapter(deps), f, sleeps };
}

describe("Jira site resolution", () => {
  it("uses accessible-resources, then calls the site's /ex/jira/{cloudId} base with the bearer token", async () => {
    const { a, f } = adapter([sites(), jsonResponse(200, { values: [{ id: "1", key: "OPS", name: "Operations", projectTypeKey: "software" }], isLast: true })]);
    const r = await a.invoke("list_projects", {}, oauthCred("jtok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { site: "https://acme.atlassian.net", projects: [{ id: "1", key: "OPS", name: "Operations", type: "software" }] });
    assert.equal(f.calls[0].url.href, "https://api.atlassian.com/oauth/token/accessible-resources");
    assert.equal(f.calls[1].url.origin + f.calls[1].url.pathname, `${BASE}/project/search`);
    for (const c of f.calls) assert.equal(c.headers.authorization, "Bearer jtok");
  });

  it("projectConfig.site picks among several sites; an unknown one is not_found", async () => {
    const other = { id: CLOUD2, url: "https://beta.atlassian.net", name: "beta", scopes: ["read:jira-work"] };
    const { a, f } = adapter([sites([other]), jsonResponse(200, { values: [], isLast: true }), sites([other])]);
    await a.invoke("list_projects", {}, oauthCred(), ctxWith({ projectConfig: { site: "https://beta.atlassian.net/" } }));
    assert.match(f.calls[1].url.pathname, new RegExp(`/ex/jira/${CLOUD2}/`));
    const miss = await a.invoke("list_projects", {}, oauthCred(), ctxWith({ projectConfig: { cloudId: "nope" } }));
    assert.equal(miss.errorCode, "not_found");
  });

  it("a grant with no Jira site is forbidden, never an empty success", async () => {
    const { a } = adapter([jsonResponse(200, [{ id: CLOUD, url: "https://acme.atlassian.net", scopes: ["read:confluence-content.all"] }])]);
    const r = await a.invoke("search_issues", { projectKey: "OPS" }, oauthCred(), ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "forbidden");
  });
});

describe("Jira reads", () => {
  it("list_projects pages with startAt until isLast", async () => {
    const { a, f } = adapter([
      sites(),
      jsonResponse(200, { values: [{ id: "1", key: "AA", name: "A" }, { id: "2", key: "BB", name: "B" }], isLast: false }),
      jsonResponse(200, { values: [{ id: "3", key: "CC", name: "C" }], isLast: true }),
    ]);
    const r = await a.invoke("list_projects", { limit: 10 }, oauthCred(), ctxWith());
    assert.deepEqual((r.data as { projects: Array<{ key: string }> }).projects.map((p) => p.key), ["AA", "BB", "CC"]);
    assert.equal(f.calls[1].url.searchParams.get("startAt"), "0");
    assert.equal(f.calls[2].url.searchParams.get("startAt"), "2");
  });

  it("search_issues: enhanced /search/jql with fields, nextPageToken pagination, issue URLs", async () => {
    const { a, f } = adapter([
      sites(),
      jsonResponse(200, { issues: [raw(1), raw(2)], nextPageToken: "tok-p2", isLast: false }),
      jsonResponse(200, { issues: [raw(3)], isLast: true }),
    ]);
    const r = await a.invoke("search_issues", { jql: "project = OPS AND status != Done ORDER BY updated DESC", limit: 5 }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    const data = r.data as { issues: Array<{ key: string; status: string; url: string; assignee: string }>; nextPageToken: string | null };
    assert.deepEqual(data.issues.map((i) => i.key), ["OPS-1", "OPS-2", "OPS-3"]);
    assert.equal(data.issues[0].url, "https://acme.atlassian.net/browse/OPS-1");
    assert.equal(data.issues[0].assignee, "Ada");
    assert.equal(data.nextPageToken, null);
    const q1 = f.calls[1].url;
    assert.equal(q1.pathname, `/ex/jira/${CLOUD}/rest/api/3/search/jql`);
    assert.equal(q1.searchParams.get("jql"), "project = OPS AND status != Done ORDER BY updated DESC");
    assert.equal(q1.searchParams.get("fields"), "summary,status,issuetype,priority,assignee,updated");
    assert.equal(q1.searchParams.get("nextPageToken"), null);
    assert.equal(f.calls[2].url.searchParams.get("nextPageToken"), "tok-p2");
  });

  it("search_issues: a project key builds bounded JQL; neither jql nor key is bad_request", async () => {
    const { a, f } = adapter([sites(), jsonResponse(200, { issues: [], isLast: true }), sites()]);
    await a.invoke("search_issues", { projectKey: "ops" }, oauthCred(), ctxWith());
    assert.equal(f.calls[1].url.searchParams.get("jql"), 'project = "OPS" ORDER BY updated DESC');
    const bad = await a.invoke("search_issues", {}, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
  });

  it("get_issue renders the ADF description as text", async () => {
    const issue = { ...raw(4), fields: { ...raw(4).fields, description: textToAdf("Line one\nline two\n\nSecond para") } };
    const { a } = adapter([sites(), jsonResponse(200, issue)]);
    const r = await a.invoke("get_issue", { issueKey: "OPS-4" }, oauthCred(), ctxWith());
    assert.equal((r.data as { description: string }).description, "Line one\nline two\nSecond para");
  });

  it("429 on a read honours Retry-After, then succeeds", async () => {
    const { a, f, sleeps } = adapter([sites(), jsonResponse(429, { errorMessages: ["Rate limit exceeded"] }, { "retry-after": "2" }), jsonResponse(200, { values: [], isLast: true })]);
    const r = await a.invoke("list_projects", {}, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(f.calls.length, 3);
  });

  it("Jira's errorMessages envelope surfaces as the message with a closed code", async () => {
    const { a } = adapter([sites(), jsonResponse(400, { errorMessages: ["Error in the JQL Query: Expecting operator"], errors: {} })]);
    const r = await a.invoke("search_issues", { jql: "project ==" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.match(r.error ?? "", /Error in the JQL Query/);
  });

  it("401 on the site lookup → one vault refresh; the call after it carries the new token", async () => {
    const { a, f } = adapter([jsonResponse(401, { message: "Unauthorized" }), sites(), jsonResponse(200, { values: [], isLast: true })]);
    const ctx = refreshingCtx();
    const r = await a.invoke("list_projects", {}, oauthCred("old"), ctx);
    assert.equal(r.ok, true, r.error);
    assert.equal(ctx.refreshCalls(), 1);
    assert.deepEqual(f.calls.map((c) => c.headers.authorization), ["Bearer old", "Bearer tok-2", "Bearer tok-2"]);
  });
});

describe("Jira writes (never retried)", () => {
  it("create_issue: POST /issue with project key, summary, type and an ADF description", async () => {
    const { a, f } = adapter([sites(), jsonResponse(201, { id: "10042", key: "OPS-42", self: `${BASE}/issue/10042` })]);
    const r = await a.invoke(
      "create_issue",
      { projectKey: "ops", summary: "Renew\nSSL", description: "Expires soon.\n\nSee runbook.", priority: "High", labels: "infra, security team" },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { id: "10042", key: "OPS-42", url: "https://acme.atlassian.net/browse/OPS-42" });
    const c = f.calls[1];
    assert.equal(c.method, "POST");
    assert.equal(c.url.href, `${BASE}/issue`);
    assert.deepEqual(c.body, {
      fields: {
        project: { key: "OPS" },
        summary: "Renew SSL",
        issuetype: { name: "Task" },
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Expires soon." }] },
            { type: "paragraph", content: [{ type: "text", text: "See runbook." }] },
          ],
        },
        priority: { name: "High" },
        labels: ["infra", "security-team"],
      },
    });
  });

  it("create_issue: a 429 is NOT retried (a retry could create a duplicate)", async () => {
    const { a, f, sleeps } = adapter([sites(), jsonResponse(429, { errorMessages: ["slow down"] }, { "retry-after": "1" })]);
    const r = await a.invoke("create_issue", { projectKey: "OPS", summary: "x" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "rate_limited");
    assert.equal(f.calls.length, 2);
    assert.deepEqual(sleeps, []);
  });

  it("transition_issue: resolves a target status name to the transition id; adds the comment", async () => {
    const { a, f } = adapter([
      sites(),
      jsonResponse(200, { transitions: [{ id: "11", name: "Start progress", to: { name: "In Progress" } }, { id: "31", name: "Resolve", to: { name: "Done" } }] }),
      new Response(null, { status: 204 }),
    ]);
    const r = await a.invoke("transition_issue", { issueKey: "ops-7", transition: "done", comment: "Shipped." }, oauthCred(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { key: "OPS-7", transitioned: true, to: "Done" });
    assert.equal(f.calls[1].url.pathname, `/ex/jira/${CLOUD}/rest/api/3/issue/OPS-7/transitions`);
    assert.equal(f.calls[2].method, "POST");
    assert.deepEqual(f.calls[2].body, {
      transition: { id: "31" },
      update: { comment: [{ add: { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Shipped." }] }] } } }] },
    });
  });

  it("transition_issue: an unavailable transition is bad_request listing the options (no POST)", async () => {
    const { a, f } = adapter([sites(), jsonResponse(200, { transitions: [{ id: "11", name: "Start progress", to: { name: "In Progress" } }] })]);
    const r = await a.invoke("transition_issue", { issueKey: "OPS-7", transition: "Done" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.match(r.error ?? "", /Start progress \(→ In Progress\)/);
    assert.equal(f.calls.length, 2);
  });

  it("add_comment: POST /issue/{key}/comment with an ADF body; a 5xx is not retried", async () => {
    const { a, f } = adapter([sites(), jsonResponse(201, { id: "c9" }), sites(), jsonResponse(503, { errorMessages: ["down"] })]);
    const ok = await a.invoke("add_comment", { issueKey: "OPS-7", body: "Looks good" }, oauthCred(), ctxWith());
    assert.deepEqual(ok.data, { id: "c9", key: "OPS-7" });
    assert.deepEqual(f.calls[1].body, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }] } });
    const failed = await a.invoke("add_comment", { issueKey: "OPS-7", body: "x" }, oauthCred(), ctxWith());
    assert.equal(failed.errorCode, "provider_error");
    assert.equal(f.calls.length, 4);
  });

  it("bad keys are bad_request before any write", async () => {
    const { a, f } = adapter([sites()]);
    const r = await a.invoke("add_comment", { issueKey: "not a key", body: "x" }, oauthCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.equal(f.calls.length, 1, "only the site lookup ran");
  });
});

describe("Jira wiring", () => {
  it("ADF round-trip helpers", () => {
    assert.equal(adfToText(textToAdf("a\nb\n\nc")), "a\nb\nc");
    assert.deepEqual(textToAdf("   "), { type: "doc", version: 1, content: [] });
  });

  it("OAuth: 3LO authorize URL (audience, consent, space-separated scopes) and a JSON token request", () => {
    process.env.MARKETR_CREDENTIALS_KEY ||= "0".repeat(64);
    assert.equal(OAUTH_CONFIGS.jira.tokenRequest, "json");
    const prev = process.env.ATLASSIAN_OAUTH_CLIENT_ID;
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "atl-client";
    try {
      const u = new URL(startOAuthFlow("u1", "ws1", "jira", "https://app.example.com").url);
      assert.equal(u.origin + u.pathname, "https://auth.atlassian.com/authorize");
      assert.equal(u.searchParams.get("audience"), "api.atlassian.com");
      assert.equal(u.searchParams.get("prompt"), "consent");
      assert.equal(u.searchParams.get("scope"), "read:jira-work write:jira-work read:jira-user offline_access");
    } finally {
      if (prev === undefined) delete process.env.ATLASSIAN_OAUTH_CLIENT_ID;
      else process.env.ATLASSIAN_OAUTH_CLIENT_ID = prev;
    }
  });

  it("grants: ops group; writes are Tier-2 write_project_record", () => {
    assert.equal(connectorGroup("jira"), "ops");
    for (const t of ["create_issue", "transition_issue", "add_comment"]) assert.equal(connectorAction("jira", t), "write_project_record");
  });

  it("mock mode is labelled and writes nothing", async () => {
    const r = await new JiraAdapter().invoke("transition_issue", { issueKey: "OPS-1", transition: "Done" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal((r.data as { written: boolean }).written, false);
  });
});
