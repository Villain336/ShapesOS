// ShapesOS — dev-preview browser isolation battery (v2, capability URLs).
// REAL STACK: the actual route handler (app/api/projects/[id]/dev-preview/
// [port]/[[...path]]/route.ts), the real token lib (real lib/secrets
// envelope), real authz RBAC (requireProjectRole/getMembership), the real
// proxy (real fetch to a real loopback HTTP upstream), real HTML rewriting.
// Only the outer boundaries are faked in memory: prisma rows, the RLS tx
// handle, the session user, and the sandbox provider handle. No paid
// upstream; the "dev server" is a local http.Server.
// Run: npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/browser-isolation.local.test.ts

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------- boundary fakes
const WS = "ws1";
const projects = new Map<string, { id: string; workspaceId: string }>([
  ["p1", { id: "p1", workspaceId: WS }],
  ["p2", { id: "p2", workspaceId: WS }],
]);
const members = new Map<string, { workspaceId: string; userId: string; role: string }>([
  [`${WS}:u1`, { workspaceId: WS, userId: "u1", role: "viewer" }],
  [`${WS}:u2`, { workspaceId: WS, userId: "u2", role: "editor" }],
]);
let sessionUser: { id: string } | null = null;

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      project: {
        findFirst: async ({ where }: { where: { id: string; workspace?: { OR: { ownerUserId?: string; members?: { some: { userId: string } } }[] } } }) => {
          const p = projects.get(where.id) ?? null;
          if (!p) return null;
          const or = where.workspace?.OR;
          if (!or) return p;
          // accessibleWorkspaceWhere(userId): owner (no owner rows here) OR member.
          const uid = or[0]?.ownerUserId ?? or[1]?.members?.some?.userId;
          return uid && members.has(`${p.workspaceId}:${uid}`) ? p : null;
        },
      },
      workspaceMember: {
        findFirst: async ({ where }: { where: { workspaceId: string; userId: string } }) => {
          const m = members.get(`${where.workspaceId}:${where.userId}`) ?? null;
          return m ? { ...m, workspace: { requireTwoFactor: false } } : null;
        },
        create: async ({ data }: { data: { workspaceId: string; userId: string; role: string } }) => data,
      },
      workspace: {
        findUnique: async () => null, // no owner backfill in fixtures
      },
    },
  },
});

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => sessionUser,
    getAccessibleWorkspaces: async () => [],
    getOrCreateWorkspace: async () => null,
    defaultWorkspaceName: () => "ws",
    ACTIVE_WORKSPACE_COOKIE: "marketr_active_workspace",
  },
});

interface TokRow {
  id: string; workspaceId: string; projectId: string; port: number; sandboxId: string; userId: string;
  tokenHash: string; tokenEnc: string; createdAt: Date; expiresAt: Date; lastRenewedAt: Date | null; revokedAt: Date | null;
}
const tokens = new Map<string, TokRow>();
let tokSeq = 0;
let sandboxRow = {
  id: "pds1", workspaceId: WS, projectId: "p1", provider: "docker", sandboxId: "sb1",
  status: "running", ttlSeconds: 900, mode: "production", createCount: 1,
  exposedPorts: [3000], secretEnc: null as string | null,
  createdAt: new Date(), lastResumedAt: null as Date | null, pausedAt: null as Date | null, destroyedAt: null as Date | null,
};

const tx = {
  projectDevPreviewToken: {
    findUnique: async ({ where: { tokenHash } }: { where: { tokenHash: string } }) =>
      [...tokens.values()].find((r) => r.tokenHash === tokenHash) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      [...tokens.values()]
        .filter((r) =>
          r.workspaceId === where.workspaceId && r.projectId === where.projectId && r.port === where.port &&
          r.sandboxId === where.sandboxId && r.userId === where.userId && r.revokedAt === null &&
          r.expiresAt > (where.expiresAt as { gt: Date }).gt && r.createdAt > (where.createdAt as { gt: Date }).gt)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
    update: async ({ where: { id }, data }: { where: { id: string }; data: Partial<TokRow> }) => {
      const r = tokens.get(id); if (r) Object.assign(r, data); return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<TokRow> }) => {
      let n = 0;
      for (const r of tokens.values()) if (r.workspaceId === where.workspaceId && r.projectId === where.projectId && r.revokedAt === null) { Object.assign(r, data); n++; }
      return { count: n };
    },
    create: async ({ data }: { data: Omit<TokRow, "id" | "createdAt" | "lastRenewedAt" | "revokedAt"> }) => {
      const row: TokRow = { ...data, id: `t${++tokSeq}`, createdAt: new Date(), lastRenewedAt: null, revokedAt: null };
      tokens.set(row.id, row); return row;
    },
  },
  projectDevSandbox: {
    findFirst: async ({ where }: { where: { workspaceId: string; projectId: string } }) =>
      sandboxRow.workspaceId === where.workspaceId && sandboxRow.projectId === where.projectId ? sandboxRow : null,
  },
};

mock.module("@/lib/substrate/memory/rls", {
  namedExports: { withWorkspaceScope: async (_ws: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
});

// Real secrets envelope for the token lib (dynamic import is not mockable).
process.env.MARKETR_CREDENTIALS_KEY = "0".repeat(64);
process.env.SHAPES_DEV_PREVIEW = "1";

// ---------------------------------------------------------------- upstream dev server
const BASE = "/api/projects/p1/dev-preview/3000/";
const seen: { method: string; url: string; cookie: string | null; authorization: string | null; body: string }[] = [];
let upstreamOrigin = "";
let server: http.Server;

mock.module("../index", {
  namedExports: {
    getSandboxProvider: () => ({
      name: "docker",
      get: async (id: string) =>
        id === sandboxRow.sandboxId
          ? { id, previewUpstream: async () => ({ kind: "loopback" as const, origin: upstreamOrigin, headers: {} }) }
          : null,
    }),
  },
});

type Route = typeof import("../../../app/api/projects/[id]/dev-preview/[port]/[[...path]]/route");
let route: Route;
let tokenMod: typeof import("../dev-preview-token");

function req(path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  // Params come FROM THE PATH, exactly as Next derives them from the URL.
  const parts = path.split("/").filter(Boolean);
  const ctx = { params: Promise.resolve({ id: parts[2], port: parts[4], path: parts.slice(5) }) };
  const r = new Request(`http://localhost${path}`, init);
  const m = (init?.method ?? "GET").toUpperCase();
  const fn = (route as unknown as Record<string, (q: unknown, c: unknown) => Promise<Response>>)[m] ?? route.GET;
  return fn(r, ctx);
}

before(async () => {
  route = await import("../../../app/api/projects/[id]/dev-preview/[port]/[[...path]]/route");
  tokenMod = await import("../dev-preview-token");
  server = http.createServer((q, res) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      seen.push({ method: q.method ?? "?", url: q.url ?? "?", cookie: q.headers.cookie ?? null, authorization: q.headers.authorization ?? null, body });
      const u = q.url ?? "";
      if (u === `${BASE}redir-in`) { res.writeHead(302, { location: `${BASE}about` }).end(); return; }
      if (u === `${BASE}redir-ext`) { res.writeHead(302, { location: "https://evil.example/x" }).end(); return; }
      if (u === BASE || u === `${BASE}index.html`) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><link rel="stylesheet" href="${BASE}assets/style.css"></head><body><script type="module" src="${BASE}src/main.js"></script></body></html>`);
        return;
      }
      if (u === `${BASE}assets/style.css`) { res.writeHead(200, { "content-type": "text/css" }); res.end("body{color:red}"); return; }
      if (u === `${BASE}src/main.js`) {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(`import { msg } from "${BASE}src/dep.js"; import "${BASE}node_modules/vite/dist/client/env.mjs"; export default msg;`);
        return;
      }
      if (u === `${BASE}api/data`) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
      res.writeHead(404).end("nf");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstreamOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise((r) => server.close(r)); });

async function mint(user = "u1", project = "p1", port = 3000) {
  const t = await tokenMod.issueOrRenewDevPreviewToken({ workspaceId: WS, projectId: project, port, sandboxId: sandboxRow.sandboxId, userId: user });
  assert.ok(t, "minted");
  return t.raw;
}
const capPath = (raw: string, rest = "", project = "p1", port = 3000) =>
  `/api/projects/${project}/dev-preview/${port}/cap/${raw}/${rest}`;

before(async () => { seen.length = 0; });

describe("capability bearer requests", () => {
  it("T1 valid cap GET proxies 200; NO cookie/authorization headers reach upstream; credentialless CORS + no-referrer on response", async () => {
    const raw = await mint();
    seen.length = 0;
    const res = await req(capPath(raw), { headers: { cookie: "session=SECRET", authorization: "Bearer X" } });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].cookie, null, "app cookies never forwarded");
    assert.equal(seen[0].authorization, null, "authorization never forwarded");
    assert.ok(!seen[0].url.includes(raw), "upstream never sees the bearer");
    assert.equal(res.headers.get("access-control-allow-origin"), "null");
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  it("T1b served HTML is rewritten to the token-full prefix and carries the bootstrap", async () => {
    const raw = await mint();
    const res = await req(capPath(raw));
    const html = await res.text();
    assert.ok(html.includes(`/cap/${raw}/`), "links carry the cap prefix");
    assert.ok(html.includes("window.fetch"), "fetch/XHR rewrite bootstrap injected");
  });

  it("T1c served JS modules are rewritten to the token-full prefix (module graph can't be bootstrap-intercepted)", async () => {
    const raw = await mint();
    const res = await req(capPath(raw, "src/main.js"));
    assert.equal(res.status, 200);
    const js = await res.text();
    const capPrefix = `/api/projects/p1/dev-preview/3000/cap/${raw}/`;
    assert.ok(js.includes(`"${capPrefix}src/dep.js"`), "static import specifier rewritten to token-full URL");
    assert.ok(js.includes(`"${capPrefix}node_modules/vite/dist/client/env.mjs"`), "vite-internal import rewritten");
    assert.ok(!js.includes(`"/api/projects/p1/dev-preview/3000/src/`), "no tokenless base-prefixed URL survives");
  });

  it("T2/T3 cap POST/PUT/DELETE are 401 and the upstream NEVER sees a write", async () => {
    const raw = await mint();
    for (const method of ["POST", "PUT", "DELETE"]) {
      seen.length = 0;
      const res = await req(capPath(raw, "api/data"), { method, body: "x" });
      assert.equal(res.status, 401, method);
      assert.equal(seen.length, 0, `${method} never reached upstream`);
    }
  });

  it("T4 expired token -> 404", async () => {
    const raw = await mint();
    for (const r of tokens.values()) if (r.tokenHash === tokenMod.hashDevPreviewToken(raw)) r.expiresAt = new Date(Date.now() - 1000);
    const res = await req(capPath(raw));
    assert.equal(res.status, 404);
  });

  it("T5 tampered token -> 404", async () => {
    const raw = await mint();
    const bad = (raw[0] === "A" ? "B" : "A") + raw.slice(1);
    const res = await req(capPath(bad));
    assert.equal(res.status, 404);
  });

  it("T6 revoked token -> 404 (pause revokes the generation)", async () => {
    const raw = await mint();
    await tokenMod.revokeDevPreviewTokens(WS, "p1");
    const res = await req(capPath(raw));
    assert.equal(res.status, 404);
  });

  it("T7 removed member: CURRENT membership is re-checked uncached -> 404 immediately", async () => {
    const raw = await mint("u1");
    members.delete(`${WS}:u1`); // membership revoked AFTER mint
    const res = await req(capPath(raw));
    assert.equal(res.status, 404);
    members.set(`${WS}:u1`, { workspaceId: WS, userId: "u1", role: "viewer" });
  });

  it("T8 generation change (destroy/recreate) kills old tokens -> 404", async () => {
    const raw = await mint();
    sandboxRow.sandboxId = "sb2";
    const res = await req(capPath(raw));
    assert.equal(res.status, 404);
    sandboxRow.sandboxId = "sb1";
  });

  it("T9 token minted for port 3000 does not open port 3001 -> 404", async () => {
    const raw = await mint();
    const res = await req(capPath(raw, "", "p1", 3001));
    assert.equal(res.status, 404);
  });

  it("T10 token minted for project p1 does not open project p2 -> 404", async () => {
    const raw = await mint("u1", "p1");
    const res = await req(capPath(raw, "", "p2"));
    assert.equal(res.status, 404);
  });

  it("T11 bearer requests NEVER extend expiry (leaked token dies at its current expiry)", async () => {
    const raw = await mint();
    const before = [...tokens.values()].find((r) => r.tokenHash === tokenMod.hashDevPreviewToken(raw))!;
    const exp = before.expiresAt.getTime();
    await req(capPath(raw));
    await req(capPath(raw));
    const after = [...tokens.values()].find((r) => r.tokenHash === tokenMod.hashDevPreviewToken(raw))!;
    assert.equal(after.expiresAt.getTime(), exp, "no sliding touch from bearer traffic");
  });

  it("redirects: in-base Location rewritten WITH the token; external Location dropped", async () => {
    const raw = await mint();
    const resIn = await req(capPath(raw, "redir-in"));
    assert.equal(resIn.status, 302);
    assert.ok(resIn.headers.get("location")?.includes(`/cap/${raw}/about`), "in-base redirect preserves auth");
    const resExt = await req(capPath(raw, "redir-ext"));
    assert.equal(resExt.headers.get("location"), null, "external redirect never bounces the pane off-origin with its token");
  });

  it("paused sandbox -> 409 (never woken by traffic)", async () => {
    const raw = await mint();
    sandboxRow.status = "paused";
    const res = await req(capPath(raw));
    assert.equal(res.status, 409);
    sandboxRow.status = "running";
  });

  it("OPTIONS on a cap URL is 401 (read-only means GET/HEAD only)", async () => {
    const raw = await mint();
    seen.length = 0;
    const res = await req(capPath(raw), { method: "OPTIONS" });
    assert.equal(res.status, 401);
    assert.equal(seen.length, 0);
  });
});

describe("session fallback (canonical mint+redirect)", () => {
  it("session GET on the pretty URL redirects to this session's OWN capability URL", async () => {
    sessionUser = { id: "u1" };
    const res = await req("/api/projects/p1/dev-preview/3000/");
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") ?? "";
    assert.match(loc, /\/cap\/[A-Za-z0-9_-]{43}\//, "redirect mints+sends the canonical cap URL");
    // Following the redirect works (whole graph rides the bearer prefix):
    const followed = await req(new URL(loc).pathname);
    assert.equal(followed.status, 200);
    sessionUser = null;
  });

  it("no session on the pretty path -> 401, never an ambient document", async () => {
    sessionUser = null;
    const res = await req("/api/projects/p1/dev-preview/3000/");
    assert.equal(res.status, 401);
  });

  it("session fallback preserves raw @ pchar in the redirect target (Vite-internal paths)", async () => {
    sessionUser = { id: "u1" };
    const res = await req("/api/projects/p1/dev-preview/3000/@vite/client");
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") ?? "";
    assert.ok(loc.includes("/@vite/client"), `redirect must keep @ raw, got ${loc}`);
    assert.ok(!loc.includes("%40vite"), `redirect must not percent-encode @, got ${loc}`);
    sessionUser = null;
  });

  it("non-member session -> 404 (project invisible through accessibleWorkspaceWhere)", async () => {
    sessionUser = { id: "intruder" };
    const res = await req("/api/projects/p1/dev-preview/3000/");
    assert.equal(res.status, 404);
    sessionUser = null;
  });
});
