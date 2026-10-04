// ShapesOS — Phase 8 (ship): GitHub connector request shapes with fetch
// stubbed (branches, compare, pull requests, checks, reviews), the GitHub App
// JWT (RS256, verified with the matching public key) and installation-token
// caching, and the mock connector kept in sync with the live contract.
// Run: npx tsx --test lib/connectors/__tests__/github-ship.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GitHubSiteFileProvider, rollUpChecks } from "../github";
import { MockGitHubConnector } from "../mock-github";
import { GitHubAppAuth, createAppJwt, githubAppCredentialsFromEnv, normalizePrivateKey } from "../github-app";
import type { GitHubShipOps } from "../types";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(routes: Array<[RegExp, (m: RegExpMatchArray, s: Seen) => { status?: number; json: unknown }]>) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const s: Seen = {
      url,
      method,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    for (const [re, h] of routes) {
      const m = `${method} ${url}`.match(re);
      if (m) {
        const r = h(m, s);
        return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { fn, seen };
}

const API = "https://api.github.com/repos/acme/site";
const pull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  html_url: `https://github.com/acme/site/pull/${n}`,
  title: "T",
  body: null,
  state: "open",
  draft: false,
  mergeable: null,
  head: { ref: "shapes/r1", sha: "headsha" },
  base: { ref: "main" },
  ...extra,
});

function gh(fetchImpl: typeof fetch, getToken?: () => Promise<string>) {
  return new GitHubSiteFileProvider({ token: "pat_x", owner: "acme", repo: "site", branch: "main", demo: false, getToken }, { fetch: fetchImpl });
}

describe("branches", () => {
  it("creates a branch from the default branch (repo → ref → POST refs)", async () => {
    const { fn, seen } = stubFetch([
      [/^GET https:\/\/api\.github\.com\/repos\/acme\/site$/, () => ({ json: { owner: { login: "acme" }, name: "site", full_name: "acme/site", private: true, default_branch: "trunk", updated_at: null } })],
      [/^GET .*\/git\/ref\/heads\/trunk$/, () => ({ json: { object: { sha: "basesha" } } })],
      [/^POST .*\/git\/refs$/, () => ({ status: 201, json: { ref: "refs/heads/shapes/r1", object: { sha: "basesha" } } })],
    ]);
    const b = await gh(fn).createBranch("shapes/r1");
    assert.deepEqual(b, { name: "shapes/r1", sha: "basesha", url: "https://github.com/acme/site/tree/shapes/r1" });
    const post = seen.find((s) => s.method === "POST")!;
    assert.equal(post.url, `${API}/git/refs`);
    assert.deepEqual(post.body, { ref: "refs/heads/shapes/r1", sha: "basesha" });
    assert.equal(post.headers.Authorization, "Bearer pat_x");
    assert.equal(post.headers["X-GitHub-Api-Version"], "2022-11-28");
  });

  it("gets a branch (null when absent) and refuses bad names before any request", async () => {
    const { fn, seen } = stubFetch([[/^GET .*\/git\/ref\/heads\/shapes\/r1$/, () => ({ json: { object: { sha: "s1" } } })]]);
    assert.equal((await gh(fn).getBranch("shapes/r1"))!.sha, "s1");
    assert.equal(await gh(fn).getBranch("shapes/none"), null);
    const n = seen.length;
    for (const bad of ["a..b", "-x", "x y", "x~1", "x:y", "a/", "a.lock"]) {
      await assert.rejects(() => gh(fn).getBranch(bad), /Invalid branch name/);
    }
    assert.equal(seen.length, n);
  });

  it("compares base...head", async () => {
    const { fn, seen } = stubFetch([
      [/^GET .*\/compare\/main\.\.\.shapes\/r1\?per_page=100$/, () => ({
        json: { status: "ahead", ahead_by: 2, behind_by: 0, total_commits: 2, html_url: "https://github.com/acme/site/compare/main...shapes/r1", files: [{ filename: "a.js", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b" }] },
      })],
    ]);
    const c = await gh(fn).compare("main", "shapes/r1");
    assert.equal(seen[0]!.url, `${API}/compare/main...shapes/r1?per_page=100`);
    assert.equal(c.aheadBy, 2);
    assert.deepEqual(c.files[0], { filename: "a.js", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" });
  });
});

describe("pull requests", () => {
  it("opens a PR with title/head/base/body/draft", async () => {
    const { fn, seen } = stubFetch([[/^POST .*\/pulls$/, () => ({ status: 201, json: pull(5, { draft: true }) })]]);
    const pr = await gh(fn).openPullRequest({ title: " Fix it ", body: "why", head: "shapes/r1", base: "main", draft: true });
    assert.deepEqual(seen[0]!.body, { title: "Fix it", head: "shapes/r1", base: "main", body: "why", draft: true, maintainer_can_modify: true });
    assert.equal(pr.number, 5);
    assert.equal(pr.url, "https://github.com/acme/site/pull/5");
    assert.equal(pr.headSha, "headsha");
    assert.equal(pr.draft, true);
    await assert.rejects(() => gh(fn).openPullRequest({ title: "x", head: "main", base: "main" }), /different from its base/);
  });

  it("updates, gets and finds a PR by branch (head=owner:branch)", async () => {
    const { fn, seen } = stubFetch([
      [/^PATCH .*\/pulls\/5$/, () => ({ json: pull(5, { title: "New" }) })],
      [/^GET .*\/pulls\/5$/, () => ({ json: pull(5, { merged: true, state: "closed" }) })],
      [/^GET .*\/pulls\?state=open&head=acme%3Ashapes%2Fr1&per_page=10$/, () => ({ json: [pull(5)] })],
    ]);
    const c = gh(fn);
    assert.equal((await c.updatePullRequest(5, { title: "New", state: "closed" })).title, "New");
    assert.deepEqual(seen[0]!.body, { title: "New", state: "closed" });
    const got = await c.getPullRequest(5);
    assert.equal(got.merged, true);
    assert.equal((await c.findPullRequestForBranch("shapes/r1"))!.number, 5);
    await assert.rejects(() => c.getPullRequest(0), /Invalid pull request number/);
  });

  it("reads status: check runs + commit statuses on the head commit, rolled up", async () => {
    const { fn, seen } = stubFetch([
      [/^GET .*\/pulls\/5$/, () => ({ json: pull(5) })],
      [/^GET .*\/commits\/headsha\/check-runs\?per_page=100$/, () => ({
        json: { total_count: 2, check_runs: [
          { name: "build", status: "completed", conclusion: "success", html_url: "h1", details_url: null, output: { title: null, summary: null } },
          { name: "test", status: "completed", conclusion: "failure", html_url: "h2", details_url: null, output: { title: "3 failed", summary: "" } },
        ] },
      })],
      [/^GET .*\/commits\/headsha\/status$/, () => ({ json: { state: "pending", statuses: [{ context: "deploy", state: "pending", description: "Waiting", target_url: null }] } })],
    ]);
    const st = await gh(fn).getPullRequestStatus(5);
    assert.deepEqual(seen.map((s) => s.url), [`${API}/pulls/5`, `${API}/commits/headsha/check-runs?per_page=100`, `${API}/commits/headsha/status`]);
    assert.equal(st.state, "failure");
    assert.deepEqual(st.failing.map((c) => [c.name, c.summary]), [["test", "3 failed"]]);
    assert.equal(st.checks.find((c) => c.name === "deploy")!.conclusion, null);
  });

  it("lists review comments and reviews", async () => {
    const { fn, seen } = stubFetch([
      [/^GET .*\/pulls\/5\/comments\?per_page=100&sort=created&direction=asc$/, () => ({
        json: [{ id: 1, path: "a.js", line: null, original_line: 4, body: "nit", user: { login: "r" }, html_url: "u", created_at: "t", in_reply_to_id: 9, diff_hunk: "@@" }],
      })],
      [/^GET .*\/pulls\/5\/reviews\?per_page=100$/, () => ({ json: [{ id: 2, user: null, body: null, state: "CHANGES_REQUESTED", html_url: "u2", submitted_at: "t2" }] })],
    ]);
    const [c] = await gh(fn).listReviewComments(5);
    assert.deepEqual(c, { id: 1, path: "a.js", line: 4, body: "nit", author: "r", url: "u", createdAt: "t", inReplyTo: 9, diffHunk: "@@" });
    const [r] = await gh(fn).listReviews(5);
    assert.deepEqual(r, { id: 2, author: "unknown", state: "CHANGES_REQUESTED", body: "", url: "u2", submittedAt: "t2" });
    assert.equal(seen.length, 2);
  });

  it("rolls up: none / pending / success / failure", () => {
    const c = (conclusion: string | null) => ({ name: "x", source: "check_run" as const, status: "s", conclusion, url: null, summary: null });
    assert.equal(rollUpChecks([]).state, "none");
    assert.equal(rollUpChecks([c("success"), c(null)]).state, "pending");
    assert.equal(rollUpChecks([c("success"), c("skipped")]).state, "success");
    assert.equal(rollUpChecks([c(null), c("timed_out")]).state, "failure");
  });
});

describe("GitHub App mode", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  it("signs an RS256 JWT: iat 60 s back, exp ≤ 10 min, iss = app id", () => {
    const now = Date.UTC(2026, 9, 4, 12, 0, 0);
    const jwt = createAppJwt({ appId: "12345", privateKey: pem.replace(/\n/g, "\\n") }, now);
    const [h, p, sig] = jwt.split(".");
    const dec = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    assert.deepEqual(dec(h!), { alg: "RS256", typ: "JWT" });
    const payload = dec(p!);
    assert.equal(payload.iss, "12345");
    assert.equal(payload.iat, now / 1000 - 60);
    assert.ok(payload.exp - now / 1000 <= 600 && payload.exp > now / 1000);
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    assert.ok(v.verify(publicKey, Buffer.from(sig!, "base64url")), "signature verifies with the public key");
  });

  it("finds the installation, mints a token and caches it until shortly before expiry", async () => {
    let now = Date.UTC(2026, 9, 4, 12, 0, 0);
    let mints = 0;
    const { fn, seen } = stubFetch([
      [/^GET https:\/\/api\.github\.com\/repos\/acme\/site\/installation$/, () => ({ json: { id: 777 } })],
      [/^POST https:\/\/api\.github\.com\/app\/installations\/777\/access_tokens$/, () => {
        mints += 1;
        return { status: 201, json: { token: `ghs_token${mints}`, expires_at: new Date(now + 60 * 60 * 1000).toISOString() } };
      }],
    ]);
    const app = new GitHubAppAuth({ appId: "12345", privateKey: pem }, { fetch: fn, now: () => now });
    assert.equal((await app.tokenFor("acme", "site")).token, "ghs_token1");
    assert.equal((await app.tokenFor("acme", "site")).token, "ghs_token1", "cached");
    assert.equal(mints, 1);
    assert.match(seen[0]!.headers.Authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "JWT auth for app endpoints");
    now += 56 * 60 * 1000; // within 5 minutes of expiry → refresh
    assert.equal((await app.tokenFor("acme", "site")).token, "ghs_token2");
    assert.equal(seen.filter((s) => s.url.endsWith("/installation")).length, 1, "installation id cached");
    // Concurrent callers share one mint.
    now += 60 * 60 * 1000;
    const [a, b] = await Promise.all([app.tokenFor("acme", "site"), app.tokenFor("acme", "site")]);
    assert.equal(a.token, b.token);
    assert.equal(mints, 3);
  });

  it("the connector uses the installation token when getToken is set", async () => {
    const { fn, seen } = stubFetch([[/^GET https:\/\/api\.github\.com\/repos\/acme\/site$/, () => ({ json: { owner: { login: "acme" }, name: "site", full_name: "acme/site", private: true, default_branch: "main", updated_at: null } })]]);
    await gh(fn, async () => "ghs_install").getRepo();
    assert.equal(seen[0]!.headers.Authorization, "Bearer ghs_install");
  });

  it("is configured only when both env vars are set; keys accept \\n escapes", () => {
    assert.equal(githubAppCredentialsFromEnv({}), null);
    assert.equal(githubAppCredentialsFromEnv({ GITHUB_APP_ID: "1" }), null);
    assert.deepEqual(githubAppCredentialsFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" }), { appId: "1", privateKey: "k" });
    assert.equal(normalizePrivateKey('"a\\nb"'), "a\nb");
  });

  it("a missing installation says the app is not installed", async () => {
    const { fn } = stubFetch([]);
    const app = new GitHubAppAuth({ appId: "1", privateKey: pem }, { fetch: fn });
    await assert.rejects(() => app.tokenFor("acme", "other"), /not installed/);
  });
});

describe("mock connector stays in sync", () => {
  it("implements every ship operation, labelled mock", async () => {
    const m = new MockGitHubConnector();
    const ops: Array<keyof GitHubShipOps> = [
      "getRepo", "createBranch", "getBranch", "compare", "openPullRequest", "updatePullRequest",
      "getPullRequest", "findPullRequestForBranch", "getPullRequestStatus", "listReviewComments", "listReviews",
    ];
    for (const op of ops) assert.equal(typeof m[op], "function", op);
    const b = await m.createBranch("shapes/r1");
    assert.equal(b.mock, true);
    await assert.rejects(() => m.createBranch("shapes/r1"), /already exists/);
    const pr = await m.openPullRequest({ title: "Demo", head: "shapes/r1" });
    assert.equal(pr.mock, true);
    assert.equal((await m.findPullRequestForBranch("shapes/r1"))!.number, pr.number);
    const st = await m.getPullRequestStatus(pr.number);
    assert.equal(st.mock, true);
    assert.equal(st.state, "success");
    assert.ok((await m.listReviews(pr.number)).every((r) => r.mock && /MOCK/.test(r.body)));
    assert.ok((await m.listReviewComments(pr.number)).every((c) => c.mock));
    assert.equal((await m.compare("main", "shapes/r1")).mock, true);
    // The existing repo operations still work (websites/github routes).
    assert.equal((await m.listRepos()).length, 2);
    assert.equal((await m.pushFiles([{ path: "/x.html", content: "x" }], "m")).mock, true);
  });
});
