// Deploy PR: scripts/deploy/render-release.mjs against a FAKE Render API (an
// in-memory fetch double — not Render). Proves the order (migrate job before
// worker before web), that a failed migration touches nothing else, that a
// failed deploy or smoke rolls web and worker back, and the 202/429 paths.
// Run: npx tsx --test scripts/deploy/__tests__/render-release.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MIGRATE_COMMAND, ReleaseError, imageRef, parseArgs, release } from "../render-release.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OPTS = {
  sha: SHA,
  registry: "ghcr.io/villain336",
  web: "srv-web",
  worker: "srv-worker",
  migrate: "crn-migrate",
  healthUrl: "https://app.shapesos.com/api/health",
  timeoutMinutes: 30,
};

type Scenario = {
  previous?: boolean;
  jobOutcome?: "succeeded" | "failed";
  failDeployOf?: string; // service id whose new deploy ends update_failed
  queued?: string; // service id whose trigger answers 202
  rateLimitOnce?: boolean;
  smokeCommit?: string;
};

function fakeRender(s: Scenario = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let clock = 1_700_000_000_000;
  let seq = 0;
  let limited = false;
  const deploys = new Map<string, { id: string; service: string; status: string; polls: number; image?: string; createdAt: string; rollback?: boolean }>();
  const jobs = new Map<string, { polls: number }>();
  if (s.previous !== false) {
    for (const svc of ["srv-web", "srv-worker"]) {
      deploys.set(`dep-prev-${svc}`, { id: `dep-prev-${svc}`, service: svc, status: "live", polls: 0, image: "old", createdAt: new Date(clock - 1e6).toISOString() });
    }
  }
  const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, "") + u.search;
    calls.push(`${method} ${path}`);
    if (init.body) bodies.push(JSON.parse(init.body as string));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer rnd_test");
    if (s.rateLimitOnce && !limited) {
      limited = true;
      return json(429, { message: "slow down" }, { "retry-after": "1" });
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/services\/([^/]+)\/deploys\?status=live&limit=1$/.exec(path))) {
      const live = [...deploys.values()].filter((d) => d.service === m![1] && d.status === "live").reverse();
      return json(200, live.slice(0, 1).map((d) => ({ deploy: d, cursor: "c" })));
    }
    if ((m = /^\/services\/([^/]+)\/deploys\?limit=10$/.exec(path))) {
      const list = [...deploys.values()].filter((d) => d.service === m![1]).reverse();
      return json(200, list.map((d) => ({ deploy: { ...d, image: { ref: d.image } }, cursor: "c" })));
    }
    if ((m = /^\/services\/([^/]+)\/deploys$/.exec(path)) && method === "POST") {
      const id = `dep-${++seq}`;
      const image = (JSON.parse(init.body as string) as { imageUrl: string }).imageUrl;
      deploys.set(id, { id, service: m[1]!, status: "created", polls: 0, image, createdAt: new Date(clock).toISOString() });
      if (s.queued === m[1]) return new Response(null, { status: 202 });
      return json(201, { id, status: "created" });
    }
    if ((m = /^\/services\/([^/]+)\/deploys\/([^/]+)$/.exec(path))) {
      const d = deploys.get(m[2]!)!;
      d.polls += 1;
      if (d.status !== "live" && d.polls >= 2) {
        d.status = s.failDeployOf === d.service && !d.rollback ? "update_failed" : "live";
      } else if (d.status === "created") d.status = "update_in_progress";
      return json(200, d);
    }
    if ((m = /^\/services\/([^/]+)\/rollback$/.exec(path))) {
      const id = `dep-rb-${++seq}`;
      deploys.set(id, { id, service: m[1]!, status: "created", polls: 0, rollback: true, createdAt: new Date(clock).toISOString() });
      return json(201, { id, status: "created" });
    }
    if ((m = /^\/services\/([^/]+)\/jobs$/.exec(path)) && method === "POST") {
      jobs.set("job-1", { polls: 0 });
      return json(201, { id: "job-1", serviceId: m[1], startCommand: MIGRATE_COMMAND, planId: "plan-crn-005", createdAt: "x" });
    }
    if (/^\/services\/[^/]+\/jobs\/job-1$/.test(path)) {
      const j = jobs.get("job-1")!;
      j.polls += 1;
      return json(200, { id: "job-1", status: j.polls < 2 ? "running" : (s.jobOutcome ?? "succeeded") });
    }
    return json(404, { message: `no route ${path}` });
  }) as unknown as typeof fetch;

  const smokeFetch = (async () =>
    json(200, { status: "ok", commit: s.smokeCommit ?? SHA.slice(0, 12) })) as unknown as typeof fetch;

  const deps = {
    apiKey: "rnd_test",
    base: "https://api.render.test/v1",
    fetchImpl,
    smokeFetch,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    log: (_: string) => {},
  };
  const posts = () => calls.filter((c) => c.startsWith("POST"));
  return { deps, calls, bodies, posts };
}

describe("render-release", () => {
  it("happy path: migrate image, migrate job, worker, web, smoke — in that order", async () => {
    const f = fakeRender();
    await release(OPTS, f.deps);
    assert.deepEqual(f.posts(), [
      "POST /services/crn-migrate/deploys",
      "POST /services/crn-migrate/jobs",
      "POST /services/srv-worker/deploys",
      "POST /services/srv-web/deploys",
    ]);
    assert.deepEqual(f.bodies, [
      { imageUrl: `ghcr.io/villain336/shapesos-migrate:${SHA}` },
      { startCommand: "sh scripts/db/migrate.sh" },
      { imageUrl: `ghcr.io/villain336/shapesos-worker:${SHA}` },
      { imageUrl: `ghcr.io/villain336/shapesos-runner:${SHA}` },
    ]);
    // The migrate job only starts after the migrate image is live.
    const firstJob = f.calls.indexOf("POST /services/crn-migrate/jobs");
    assert.ok(f.calls.slice(0, firstJob).some((c) => /^GET \/services\/crn-migrate\/deploys\/dep-1$/.test(c)));
  });

  it("a failed migration stops the release before worker and web are touched", async () => {
    const f = fakeRender({ jobOutcome: "failed" });
    await assert.rejects(release(OPTS, f.deps), (e: unknown) => e instanceof ReleaseError && /migration job job-1 failed/.test((e as Error).message));
    assert.ok(!f.calls.some((c) => /srv-(web|worker)\/(deploys$|rollback)/.test(c) && c.startsWith("POST")), f.calls.join("\n"));
  });

  it("a failed web deploy rolls web and worker back to their previous deploys", async () => {
    const f = fakeRender({ failDeployOf: "srv-web" });
    await assert.rejects(release(OPTS, f.deps), /shapesos-web deploy dep-\d+ ended update_failed; rolled back web and worker/);
    assert.ok(f.calls.includes("POST /services/srv-web/rollback"));
    assert.ok(f.calls.includes("POST /services/srv-worker/rollback"));
    const rb = f.bodies.filter((b) => "deployId" in b);
    assert.deepEqual(rb, [{ deployId: "dep-prev-srv-web" }, { deployId: "dep-prev-srv-worker" }]);
  });

  it("a failed worker deploy rolls back the worker only (web was never changed)", async () => {
    const f = fakeRender({ failDeployOf: "srv-worker" });
    await assert.rejects(release(OPTS, f.deps), /rolled back worker$/);
    assert.ok(!f.calls.includes("POST /services/srv-web/deploys"));
    assert.ok(!f.calls.includes("POST /services/srv-web/rollback"));
  });

  it("a smoke test that never sees this commit rolls both back", async () => {
    const f = fakeRender({ smokeCommit: "ffffffffffff" });
    await assert.rejects(release(OPTS, f.deps), /smoke test failed: .*commit ffffffffffff.*rolled back web and worker/);
  });

  it("first release with nothing to roll back to says so and still fails", async () => {
    const f = fakeRender({ previous: false, failDeployOf: "srv-web" });
    await assert.rejects(release(OPTS, f.deps), (e: unknown) => /ended update_failed$/.test((e as Error).message));
    assert.ok(!f.calls.some((c) => c.includes("/rollback")));
  });

  it("a queued deploy (HTTP 202) is found by its image and awaited", async () => {
    const f = fakeRender({ queued: "srv-worker" });
    await release(OPTS, f.deps);
    assert.ok(f.calls.includes("GET /services/srv-worker/deploys?limit=10"));
  });

  it("retries a rate-limited call", async () => {
    const f = fakeRender({ rateLimitOnce: true });
    await release(OPTS, f.deps);
    assert.equal(f.calls.filter((c) => c === "GET /services/srv-web/deploys?status=live&limit=1").length, 2);
  });

  it("refuses to run without an API key", async () => {
    const f = fakeRender();
    await assert.rejects(release(OPTS, { ...f.deps, apiKey: "" }), /RENDER_API_KEY is not set/);
  });
});

describe("parseArgs", () => {
  const base = ["--sha", SHA, "--registry", "ghcr.io/villain336", "--web-service", "srv-a1", "--worker-service", "srv-b2", "--migrate-service", "crn-c3", "--health-url", "https://app.shapesos.com/api/health"];
  it("accepts a full command line", () => {
    const o = parseArgs(base);
    assert.equal(o.web, "srv-a1");
    assert.equal(o.timeoutMinutes, 30);
    assert.equal(imageRef(o.registry, "runner", o.sha), `ghcr.io/villain336/shapesos-runner:${SHA}`);
  });
  it("rejects missing or malformed values", () => {
    assert.throws(() => parseArgs(base.slice(2)), /missing --sha/);
    assert.throws(() => parseArgs(base.map((a) => (a === SHA ? "main" : a))), /--sha must be/);
    assert.throws(() => parseArgs(base.map((a) => (a === "srv-a1" ? "web" : a))), /Render service id/);
    assert.throws(() => parseArgs(base.map((a) => (a.startsWith("https://") ? "http://app.shapesos.com/api/health" : a))), /must be https/);
    assert.throws(() => parseArgs([...base, "--sha"]), /needs a value/);
    assert.throws(() => parseArgs(["oops", ...base]), /unexpected argument/);
  });
});
