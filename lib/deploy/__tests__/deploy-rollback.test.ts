// ShapesOS — Phase 9 (sites): the Netlify adapter, provider rollbacks and the
// rollback approval gate. No network: globalThis.fetch is stubbed with a
// recorder; the gate port is an in-memory fake. Real provider calls are
// UNVERIFIED-LIVE (scripts/live/*.mts).
// Run: npx tsx --test lib/deploy/__tests__/deploy-rollback.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NetlifyDeployTarget, encodeDeployPath, netlifySiteSlug } from "../netlify";
import { VercelDeployTarget } from "../vercel";
import { CloudflarePagesDeployTarget, pagesProjectSlug } from "../cloudflare";
import { MockNetlifyDeployTarget } from "../mock-netlify";
import { MockVercelDeployTarget } from "../mock-vercel";
import { MockCloudflarePagesDeployTarget } from "../mock-cloudflare";
import { buildDeployTarget, deployTargetEnum, deployTargetSlug, hostingKindLabel } from "../index";
import { normalizeStatus } from "../types";
import {
  RollbackError,
  approverOf,
  executeRollback,
  requestRollback,
  rollbackBinding,
  rollbackEligibility,
  verifyRollbackApproval,
  type RollbackApproval,
  type RollbackGatePort,
} from "../rollback";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch with a router; returns the recorded calls. */
function stubFetch(route: (c: Call) => { status?: number; json?: unknown; text?: string }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers, body: init?.body };
    calls.push(call);
    const r = route(call);
    const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex");

describe("Netlify adapter (file digest deploy)", () => {
  it("creates the site, posts the digest, uploads only the required files", async () => {
    const files = [
      { path: "index.html", content: "<h1>hi</h1>" },
      { path: "/about/index.html", content: "<h1>about</h1>" },
      { path: "copy.html", content: "<h1>hi</h1>" }, // same content as index.html
    ];
    const calls = stubFetch((c) => {
      if (c.url.includes("/sites?name=")) return { json: [{ id: "other", name: "acme-landing-old" }] };
      if (c.method === "POST" && c.url.endsWith("/sites")) return { json: { id: "site-1", name: "acme-landing" } };
      if (c.method === "POST" && c.url.endsWith("/sites/site-1/deploys")) {
        return { json: { id: "dep-1", state: "uploading", required: [sha1("<h1>about</h1>")], site_id: "site-1" } };
      }
      if (c.method === "PUT") return { json: {} };
      if (c.url.endsWith("/deploys/dep-1")) {
        return { json: { id: "dep-1", state: "processing", site_id: "site-1", deploy_ssl_url: "https://dep-1--acme-landing.netlify.app" } };
      }
      return { status: 404, json: { message: "unexpected" } };
    });
    const t = new NetlifyDeployTarget({ token: "nf-token", siteId: "", demo: false });
    const r = await t.deploy(files, { projectName: "Acme Landing!" });
    assert.equal(r.deploymentId, "dep-1");
    assert.equal(r.project, "site-1");
    assert.equal(r.status, "building");
    assert.equal(r.url, "https://dep-1--acme-landing.netlify.app");
    assert.equal(r.mock, false);
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/sites"))!;
    assert.deepEqual(JSON.parse(String(create.body)), { name: "acme-landing" });
    const digest = JSON.parse(String(calls.find((c) => c.url.endsWith("/sites/site-1/deploys"))!.body));
    assert.deepEqual(digest.files, {
      "/index.html": sha1("<h1>hi</h1>"),
      "/about/index.html": sha1("<h1>about</h1>"),
      "/copy.html": sha1("<h1>hi</h1>"),
    });
    const puts = calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 1, "only the file Netlify asked for is uploaded");
    assert.ok(puts[0]!.url.endsWith("/deploys/dep-1/files/about/index.html"));
    assert.equal(puts[0]!.headers["content-type"], "application/octet-stream");
    assert.equal(Buffer.from(puts[0]!.body as Uint8Array).toString("utf8"), "<h1>about</h1>");
    for (const c of calls) assert.equal(c.headers.authorization, "Bearer nf-token");
  });

  it("deploys into the known site without looking it up; a taken name gets a suffix", async () => {
    const calls = stubFetch((c) => {
      if (c.url.endsWith("/sites/known/deploys")) return { json: { id: "dep-2", state: "ready", required: [], site_id: "known", ssl_url: "https://x.netlify.app" } };
      return { status: 500, json: {} };
    });
    const t = new NetlifyDeployTarget({ token: "t", siteId: "", demo: false });
    const r = await t.deploy([{ path: "a.html", content: "a" }], { projectName: "x", project: "known" });
    assert.equal(r.status, "ready");
    assert.equal(calls.length, 1);

    let creates = 0;
    stubFetch((c) => {
      if (c.url.includes("/sites?name=")) return { json: [] };
      if (c.method === "POST" && c.url.endsWith("/sites")) {
        creates++;
        return creates === 1 ? { status: 422, json: { message: "name already taken" } } : { json: { id: "site-2" } };
      }
      if (c.url.endsWith("/sites/site-2/deploys")) return { json: { id: "dep-3", state: "new", required: [] } };
      return { status: 500, json: {} };
    });
    const r2 = await t.deploy([{ path: "a.html", content: "a" }], { projectName: "taken" });
    assert.equal(creates, 2);
    assert.equal(r2.project, "site-2");
  });

  it("test() reads the user; an API error carries the status and message", async () => {
    stubFetch(() => ({ json: { full_name: "Ada", email: "ada@example.com" } }));
    const t = new NetlifyDeployTarget({ token: "t", siteId: "s", demo: false });
    assert.match((await t.test()).info, /Ada/);
    stubFetch(() => ({ status: 401, json: { message: "Access Denied" } }));
    await assert.rejects(t.test(), /Netlify token check failed \(401\): Access Denied/);
    await assert.rejects(new NetlifyDeployTarget({ token: "", siteId: "", demo: false }).test(), /token is required/);
  });

  it("slugs and paths", () => {
    assert.equal(netlifySiteSlug("Acme Plumbing — Summer!"), "acme-plumbing-summer");
    assert.equal(encodeDeployPath("/a b/c#d.html"), "a%20b/c%23d.html");
  });
});

describe("rollback per provider", () => {
  it("Vercel: instant rollback on the stored project", async () => {
    const calls = stubFetch((c) => {
      if (c.method === "POST") return { status: 201, text: "" };
      return { json: { id: "dpl_1", url: "acme.vercel.app", status: "READY" } };
    });
    const t = new VercelDeployTarget({ token: "vt", projectId: "", teamId: "team_1", demo: false });
    const s = await t.rollback("dpl_1", { project: "prj_1" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.vercel.com/v9/projects/prj_1/rollback/dpl_1?teamId=team_1");
    assert.equal(s.status, "ready");
    assert.equal(s.url, "https://acme.vercel.app");
  });

  it("Vercel: finds the project from the deployment when none is stored; errors surface", async () => {
    const calls = stubFetch((c) => {
      if (c.method === "POST") return { status: 201, text: "" };
      return { json: { id: "dpl_2", projectId: "prj_from_dep", status: "READY" } };
    });
    await new VercelDeployTarget({ token: "vt", projectId: "", teamId: "", demo: false }).rollback("dpl_2", {});
    assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/v9/projects/prj_from_dep/rollback/dpl_2")));
    stubFetch(() => ({ status: 403, json: { error: { message: "forbidden" } } }));
    await assert.rejects(new VercelDeployTarget({ token: "vt", projectId: "p", teamId: "", demo: false }).rollback("d", { project: "p" }), /forbidden/);
  });

  it("Cloudflare Pages: rollback on the stored / derived project", async () => {
    const calls = stubFetch(() => ({ json: { success: true, result: { id: "cf-1", url: "https://abc.acme.pages.dev", latest_stage: { status: "success" } } } }));
    const t = new CloudflarePagesDeployTarget({ token: "ct", accountId: "acc", projectName: "", demo: false });
    const s = await t.rollback("cf-1", { projectName: "Acme Site" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acc/pages/projects/acme-site/deployments/cf-1/rollback");
    assert.equal(s.status, "ready", "CF 'success' reads as ready");
    assert.equal(pagesProjectSlug("Acme Site"), "acme-site");
    stubFetch(() => ({ status: 400, json: { success: false, errors: [{ message: "not a production deployment" }] } }));
    await assert.rejects(t.rollback("cf-1", { project: "acme-site" }), /not a production deployment/);
  });

  it("Netlify: restore deploy", async () => {
    const calls = stubFetch(() => ({ json: { id: "dep-1", state: "ready", ssl_url: "https://acme.netlify.app" } }));
    const s = await new NetlifyDeployTarget({ token: "t", siteId: "", demo: false }).rollback("dep-1", { project: "site-1" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "https://api.netlify.com/api/v1/sites/site-1/deploys/dep-1/restore");
    assert.equal(s.url, "https://acme.netlify.app");
    assert.equal(s.status, "ready");
  });

  it("mocks roll back without the network and say so", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network used");
    }) as typeof fetch;
    for (const t of [
      new MockVercelDeployTarget({ token: "", projectId: "", teamId: "", demo: true }),
      new MockCloudflarePagesDeployTarget({ token: "", accountId: "", projectName: "", demo: true }),
      new MockNetlifyDeployTarget({ token: "", siteId: "", demo: true }),
    ]) {
      const s = await t.rollback("mock-dep-1", {});
      assert.equal(s.mock, true);
      assert.equal(s.status, "ready");
      assert.equal(t.isLive, false);
    }
  });
});

describe("provider registry", () => {
  it("builds every provider, live or mock, from one place", () => {
    assert.ok(buildDeployTarget("netlify", { token: "t" }) instanceof NetlifyDeployTarget);
    assert.ok(buildDeployTarget("netlify", { demo: true }) instanceof MockNetlifyDeployTarget);
    assert.ok(buildDeployTarget("vercel", { token: "t" }) instanceof VercelDeployTarget);
    assert.ok(buildDeployTarget("cloudflare-pages", { demo: true }) instanceof MockCloudflarePagesDeployTarget);
    assert.equal(deployTargetSlug("cloudflare_pages"), "cloudflare-pages");
    assert.equal(deployTargetEnum("cloudflare-pages"), "cloudflare_pages");
    assert.equal(deployTargetEnum("netlify"), "netlify");
    assert.throws(() => deployTargetSlug("heroku"), /Unknown deploy target/);
    assert.equal(hostingKindLabel("netlify"), "Netlify");
    assert.equal(hostingKindLabel("cloudflare_pages"), "Cloudflare Pages");
  });

  it("normalizes every provider's states", () => {
    assert.equal(normalizeStatus("success"), "ready");
    assert.equal(normalizeStatus("failure"), "error");
    assert.equal(normalizeStatus("uploading"), "building");
    assert.equal(normalizeStatus("prepared"), "building");
    assert.equal(normalizeStatus("READY"), "ready");
    assert.equal(normalizeStatus("weird"), "queued");
  });
});

describe("which deployments can be restored", () => {
  const t0 = new Date("2026-10-01T00:00:00Z").getTime();
  const row = (id: string, minutes: number, extra: Partial<Parameters<typeof rollbackEligibility>[0][number]> = {}) => ({
    id,
    connectionId: "c1",
    providerProject: "p1",
    deploymentId: `prov-${id}`,
    status: "ready",
    createdAt: new Date(t0 + minutes * 60_000),
    ...extra,
  });

  it("the newest ready one is live; older ready ones can be restored", () => {
    const e = rollbackEligibility([row("a", 0), row("b", 10), row("c", 20, { status: "error" })]);
    assert.equal(e.get("b")!.current, true);
    assert.equal(e.get("b")!.canRollBack, false);
    assert.equal(e.get("a")!.canRollBack, true);
    assert.equal(e.get("c")!.canRollBack, false);
    assert.match(e.get("c")!.reason!, /ready/);
  });

  it("after a rollback the restored deployment reads live, the newer one restorable", () => {
    const e = rollbackEligibility([row("a", 0), row("b", 10), row("r", 20, { deploymentId: "prov-a" })]);
    assert.equal(e.get("r")!.current, true);
    assert.equal(e.get("a")!.current, true);
    assert.equal(e.get("b")!.canRollBack, true);
  });

  it("no connection / no provider id → not restorable; live is per connection", () => {
    const e = rollbackEligibility([
      row("a", 0, { connectionId: null }),
      row("b", 1, { deploymentId: null }),
      row("c", 2, { connectionId: "c2" }),
      row("d", 3),
    ]);
    assert.equal(e.get("a")!.canRollBack, false);
    assert.equal(e.get("b")!.canRollBack, false);
    assert.equal(e.get("c")!.current, true, "c2's only deployment is live there");
    assert.equal(e.get("d")!.current, true);
  });
});

describe("rollback approval gate", () => {
  const dep = { id: "row-1", siteId: "site-1", connectionId: "conn-1", target: "netlify", deploymentId: "dep-1" };
  const binding = rollbackBinding(dep);

  function fakePort(initial: Partial<RollbackApproval> | null) {
    const state = {
      approval: initial
        ? ({ id: "ap-1", status: "approved", expiresAt: new Date(Date.now() + 3600_000), proposedArgs: binding, auditTrail: [], ...initial } as RollbackApproval)
        : null,
      proposed: [] as unknown[],
      released: [] as string[],
    };
    const port: RollbackGatePort = {
      async propose(input) {
        state.proposed.push(input);
        return { id: "ap-new", status: "pending", riskTier: "high" };
      },
      async getApproval() {
        if (!state.approval) {
          const { NotFoundError } = await import("@/lib/api/errors");
          throw new NotFoundError("Approval not found");
        }
        return state.approval;
      },
      async claim() {
        if (state.approval!.status !== "approved") throw new Error("lost");
        state.approval!.status = "executed";
      },
      async release(_ws, id, _actor, detail) {
        state.released.push(`${id}:${detail}`);
        state.approval!.status = "approved";
      },
    };
    return { port, state };
  }

  const target = (fail = false) => {
    const calls: string[] = [];
    const t = new MockNetlifyDeployTarget({ token: "", siteId: "", demo: true });
    t.rollback = async (id) => {
      calls.push(id);
      if (fail) throw new Error("provider down");
      return { id, url: "https://x", status: "ready", mock: true };
    };
    return { t, calls };
  };

  it("step 1 proposes exactly this rollback", async () => {
    const { port, state } = fakePort(null);
    const a = await requestRollback(port, { workspaceId: "ws", binding, actor: "u1", summary: "Roll back" });
    assert.equal(a.status, "pending");
    assert.deepEqual((state.proposed[0] as { binding: unknown }).binding, binding);
    await assert.rejects(
      requestRollback(port, { workspaceId: "ws", binding: rollbackBinding({ ...dep, deploymentId: null }), actor: "u1", summary: "x" }),
      (e: unknown) => e instanceof RollbackError && e.code === "not_restorable",
    );
  });

  it("never runs without an approved, unexpired, matching approval", async () => {
    const cases: Array<[Partial<RollbackApproval> | null, string]> = [
      [null, "approval_not_found"],
      [{ status: "pending" }, "approval_pending"],
      [{ status: "denied" }, "approval_not_approved"],
      [{ status: "executed" }, "approval_replayed"],
      [{ expiresAt: new Date(Date.now() - 1000) }, "approval_expired"],
      [{ proposedArgs: { ...binding, providerDeploymentId: "dep-OTHER" } }, "binding_mismatch"],
    ];
    for (const [a, code] of cases) {
      const { port } = fakePort(a);
      const { t, calls } = target();
      await assert.rejects(
        executeRollback(port, { workspaceId: "ws", binding, approvalId: "ap-1", actor: "u1", target: t, place: {} }),
        (e: unknown) => e instanceof RollbackError && e.code === code,
        code,
      );
      assert.equal(calls.length, 0, `${code}: provider never called`);
    }
  });

  it("an approved rollback runs once; a replay is refused", async () => {
    const { port, state } = fakePort({});
    const { t, calls } = target();
    const out = await executeRollback(port, { workspaceId: "ws", binding, approvalId: "ap-1", actor: "u1", target: t, place: { project: "site-1" } });
    assert.equal(out.result.status, "ready");
    assert.deepEqual(calls, ["dep-1"]);
    assert.equal(state.approval!.status, "executed");
    await assert.rejects(
      executeRollback(port, { workspaceId: "ws", binding, approvalId: "ap-1", actor: "u1", target: t, place: {} }),
      (e: unknown) => e instanceof RollbackError && e.code === "approval_replayed",
    );
    assert.equal(calls.length, 1);
  });

  it("a provider failure re-arms the approval for a retry", async () => {
    const { port, state } = fakePort({});
    const { t } = target(true);
    await assert.rejects(
      executeRollback(port, { workspaceId: "ws", binding, approvalId: "ap-1", actor: "u1", target: t, place: {} }),
      (e: unknown) => e instanceof RollbackError && e.code === "provider_failed" && e.status === 502,
    );
    assert.equal(state.approval!.status, "approved");
    assert.match(state.released[0]!, /provider down/);
    assert.ok(await verifyRollbackApproval(port, { workspaceId: "ws", binding, approvalId: "ap-1" }));
  });

  it("approverOf reads the approval trail", () => {
    assert.equal(approverOf([{ event: "proposed", actor: "u1" }, { event: "approved", actor: "u2" }]), "u2");
    assert.equal(approverOf(null), null);
  });
});
