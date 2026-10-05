// ShapesOS — Phase 10 (portal): a portal session NEVER grants workspace
// access. A live portal cookie is sent to the REAL /api/ops/[entity] route,
// which resolves the caller through the REAL Auth.js auth() (requireUser):
// it is refused (401), under its own name and even when planted under the
// Auth.js cookie name. Positive control: a genuine Auth.js session for the
// workspace owner on the same route succeeds, so the refusal is not an
// artefact of the test harness. And the reverse: a workspace session alone
// gets nothing from /api/portal.
//
// Only `next/headers` is replaced (node:test has no Next request scope): it
// hands auth() and lib/session the test request's headers and cookies.
// Run: DATABASE_URL=<app role url> npx tsx --test --experimental-test-module-mocks lib/portal/__tests__/portal-isolation-db.test.ts

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

process.env.AUTH_SECRET = randomBytes(32).toString("hex");
delete process.env.AUTH_URL;
delete process.env.NEXTAUTH_URL;

// The current test request's headers, served to auth() / cookies().
let current = new Headers();
mock.module("next/headers", {
  namedExports: {
    headers: async () => current,
    cookies: async () => {
      const jar = new Map<string, string>();
      for (const part of (current.get("cookie") ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
      }
      return {
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
      };
    },
  },
});

const tag = randomUUID().replace(/-/g, "").slice(0, 10);
const WS = `portalisows${tag}`;
const OWNER = `test:${WS}`;
const EMAIL = `iso.${tag}@client.test`;

type Mod = {
  prisma: typeof import("@/lib/prisma").prisma;
  withWorkspaceScope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
  opsRoute: typeof import("@/app/api/ops/[entity]/route");
  ticketsRoute: typeof import("@/app/api/portal/tickets/route");
  store: typeof import("../store");
  core: typeof import("../core");
  encode: typeof import("next-auth/jwt").encode;
  readSessionToken: typeof import("@/lib/auth/mfa/token").readSessionToken;
};
let m: Mod;
let portalToken = "";
let workspaceJwt = "";

function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown): NextRequest {
  // host + x-forwarded-proto as Next sets them (Auth.js derives the cookie name from the protocol).
  const headers = new Headers({
    host: "localhost:3000",
    "x-forwarded-proto": "http",
    cookie,
    ...(body === undefined ? {} : { "content-type": "application/json", origin: "http://localhost:3000" }),
  });
  current = headers;
  return new NextRequest(`http://localhost:3000${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const entity = (e: string) => ({ params: Promise.resolve({ entity: e }) });

before(async () => {
  m = {
    prisma: (await import("@/lib/prisma")).prisma,
    withWorkspaceScope: (await import("@/lib/substrate/memory/rls")).withWorkspaceScope,
    opsRoute: await import("@/app/api/ops/[entity]/route"),
    ticketsRoute: await import("@/app/api/portal/tickets/route"),
    store: await import("../store"),
    core: await import("../core"),
    encode: (await import("next-auth/jwt")).encode,
    readSessionToken: (await import("@/lib/auth/mfa/token")).readSessionToken,
  };
  await m.prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${OWNER}, now()) ON CONFLICT DO NOTHING`;
  const client = await m.prisma.client.create({ data: { workspaceId: WS, name: "Iso Co", loginEmail: EMAIL, viewerRole: "admin", portalEnabled: true } });
  await m.withWorkspaceScope(WS, (tx) =>
    tx.opsInvoice.create({ data: { workspaceId: WS, lineItems: [{ description: "x", qty: 1, priceCents: 100 }], totalCents: 100, status: "sent" } }),
  );
  // A live portal session for this workspace's client (minted the way
  // consumePortalLink does, without a mail round trip).
  const s = m.core.mintPortalToken("session", WS);
  await m.withWorkspaceScope(WS, (tx) =>
    tx.portalSession.create({ data: { workspaceId: WS, clientId: client.id, tokenHash: s.hash, expiresAt: m.core.portalExpiry("session") } }),
  );
  portalToken = s.raw;
  assert.ok(await m.store.resolvePortalSession(portalToken), "the portal session is live");
  // A genuine Auth.js session JWT for the workspace owner (positive control).
  const now = Math.floor(Date.now() / 1000);
  workspaceJwt = await m.encode({
    token: { sub: OWNER, name: "Owner", email: `owner.${tag}@agency.test`, authAt: now },
    secret: process.env.AUTH_SECRET!,
    salt: "authjs.session-token",
  });
});

after(async () => {
  await m.prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await m.prisma.$disconnect();
});

describe("portal session vs workspace access (real auth(), real /api/ops route)", () => {
  it("positive control: a genuine workspace session reads /api/ops/invoices", async () => {
    const res = await m.opsRoute.GET(call("GET", "/api/ops/invoices", `authjs.session-token=${workspaceJwt}`), entity("invoices"));
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { rows?: unknown[]; items?: unknown[] };
    assert.ok(Array.isArray(body.rows ?? body.items ?? Object.values(body)[0]));
  });

  it("a portal cookie is refused on /api/ops/* (reads and writes)", async () => {
    for (const e of ["invoices", "tickets", "quotes", "contacts"]) {
      const res = await m.opsRoute.GET(call("GET", `/api/ops/${e}`, `${m.core.PORTAL_COOKIE}=${portalToken}`), entity(e));
      assert.equal(res.status, 401, e);
    }
    const post = await m.opsRoute.POST(
      call("POST", "/api/ops/tickets", `${m.core.PORTAL_COOKIE}=${portalToken}`, { subject: "x" }),
      entity("tickets"),
    );
    assert.equal(post.status, 401);
  });

  it("a portal token planted under the Auth.js cookie name is refused too", async () => {
    for (const name of ["authjs.session-token", "__Secure-authjs.session-token"]) {
      const res = await m.opsRoute.GET(call("GET", "/api/ops/invoices", `${name}=${portalToken}`), entity("invoices"));
      assert.equal(res.status, 401, name);
    }
    // The proxy's user resolution (rate-limit key, pending-2FA bounce) sees no user either.
    assert.equal(await m.readSessionToken({ headers: new Headers({ cookie: `authjs.session-token=${portalToken}; ${m.core.PORTAL_COOKIE}=${portalToken}` }) }), null);
  });

  it("the reverse: a workspace session alone gets nothing from /api/portal", async () => {
    const res = await m.ticketsRoute.POST(call("POST", "/api/portal/tickets", `authjs.session-token=${workspaceJwt}`, { subject: "s", body: "b" }));
    assert.equal(res.status, 401);
  });
});
