// ShapesOS — Phase 1: MCP OAuth / API key authorization by CURRENT role.
//   - consent needs editor+; minted scopes are capped by role;
//   - membership is re-checked on every MCP call (removed → denied, demoted →
//     scopes shrink; API key stops once its creator is no longer an admin);
//   - API keys always expire (90-day default, 1-year max);
//   - re-approving a client for another workspace doesn't strand the first
//     workspace's tokens out of its admins' reach;
//   - the consent page names the app, the redirect host and says "unverified".
// DB-backed (listed in scripts/test/db-tests.txt). Session stubbed with
// node:test mock.module (scripts/test/run.mjs passes the flag).

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { WorkspaceRole } from "@prisma/client";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { capScopesToRole, MCP_TOOL_NAMES, scopeForTool, TOOL_MIN_ROLE } from "@/lib/mcp/scopes";

const WS_A = "p1-mcp-ws-a";
const WS_B = "p1-mcp-ws-b";
const OWNER = "p1-mcp-owner";
const EDITOR = "p1-mcp-editor";
const VIEWER = "p1-mcp-viewer";
const ADMIN_A = "p1-mcp-admin-a";
const REDIRECT = "https://agent.example.test/callback";
const ALL = MCP_TOOL_NAMES.map(scopeForTool);
const READ_ONLY = MCP_TOOL_NAMES.filter((t) => TOOL_MIN_ROLE[t] === "viewer").map(scopeForTool);

let actor = { id: OWNER, email: "owner@mcp.test" };
let activeWs = WS_A;
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: activeWs } }),
  },
});

let oauth: typeof import("@/lib/mcp/oauth");
let auth: typeof import("@/lib/mcp/auth");

async function setRole(ws: string, userId: string, role: WorkspaceRole | null) {
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: ws, userId } });
  if (role) await prisma.workspaceMember.create({ data: { workspaceId: ws, userId, role, email: `${userId}@mcp.test` } });
}

async function token(userId: string, ws: string, scope = ALL.join(" ")) {
  const reg = await oauth.registerClient({ redirect_uris: [REDIRECT], client_name: "Agent" }, null);
  assert.ok(reg.ok);
  const clientId = reg.client.client_id;
  const begun = await oauth.beginAuthorize({ clientId, redirectUri: REDIRECT, scope });
  assert.ok(begun.ok);
  const { code } = await oauth.approveAuthorization(begun.pending, userId, ws);
  const ex = await oauth.exchangeCode({ code, clientId, redirectUri: REDIRECT });
  assert.ok(ex.ok);
  return { clientId, raw: ex.token.access_token, scope: ex.token.scope, pending: begun.pending };
}

async function cleanup() {
  for (const ws of [WS_A, WS_B]) {
    await prisma.mcpOAuthToken.deleteMany({ where: { workspaceId: ws } });
    await prisma.mcpOAuthCode.deleteMany({ where: { workspaceId: ws } });
    await prisma.mcpApiKey.deleteMany({ where: { workspaceId: ws } });
  }
  await prisma.mcpOAuthClient.deleteMany({ where: { redirectUris: { has: REDIRECT } } });
  await prisma.$executeRaw`DELETE FROM file_change_log WHERE workspace_id IN (${WS_A}, ${WS_B})`.catch(() => {});
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id IN (${WS_A}, ${WS_B})`;
}

describe("scope caps (pure)", () => {
  it("viewer keeps read-only tools only; editor+ keep everything", () => {
    assert.deepEqual(capScopesToRole(ALL, "viewer"), READ_ONLY);
    assert.ok(READ_ONLY.length > 0 && READ_ONLY.length < ALL.length);
    assert.deepEqual(capScopesToRole(ALL, "editor"), ALL);
    assert.deepEqual(capScopesToRole(["tools:nope", "tools:list_projects"], "owner"), ["tools:list_projects"]);
  });
});

describe("MCP authorization by current role (DB)", () => {
  before(async () => {
    await cleanup();
    for (const ws of [WS_A, WS_B]) {
      await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at, mcp_enabled)
        VALUES (${ws}, ${ws}, ${OWNER}, now(), true)`;
      await setRole(ws, OWNER, "owner");
    }
    await setRole(WS_A, ADMIN_A, "admin");
    oauth = await import("@/lib/mcp/oauth");
    auth = await import("@/lib/mcp/auth");
  });
  after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("a viewer can't approve (consent gate) — bind and approve both refuse", async () => {
    await setRole(WS_A, VIEWER, "viewer");
    const gate = await oauth.consentGate(VIEWER, WS_A);
    assert.deepEqual(gate, { ok: false, error: "insufficient_role" });
    await assert.rejects(() => token(VIEWER, WS_A), /insufficient_role/);
    assert.deepEqual(await oauth.consentGate("p1-mcp-stranger", WS_A), {
      ok: false,
      error: "workspace_not_accessible",
    });
  });

  it("OAuth token: removed member is denied; demoted member's scopes shrink", async () => {
    await setRole(WS_A, EDITOR, "editor");
    const t = await token(EDITOR, WS_A);
    let r = await auth.requireMcpAuth(`Bearer ${t.raw}`);
    assert.ok(r.ok);
    assert.deepEqual(r.ctx.scopes, ALL);

    await setRole(WS_A, EDITOR, "viewer");
    r = await auth.requireMcpAuth(`Bearer ${t.raw}`);
    assert.ok(r.ok);
    assert.deepEqual(r.ctx.scopes, READ_ONLY);

    await setRole(WS_A, EDITOR, null);
    r = await auth.requireMcpAuth(`Bearer ${t.raw}`);
    assert.deepEqual(r, { ok: false, reason: "not_member" });
  });

  it("API key stops working once its creator is no longer an admin", async () => {
    await setRole(WS_A, ADMIN_A, "admin");
    actor = { id: ADMIN_A, email: "admin-a@mcp.test" };
    activeWs = WS_A;
    const keys = await import("@/app/api/mcp/keys/route");
    const res = await keys.POST(
      new Request("http://x/api/mcp/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ci", scopes: ALL }),
      }) as unknown as NextRequest,
    );
    assert.ok(res);
    assert.equal(res.status, 201);
    const created = (await res.json()) as { key: string; expiresAt: string | null };

    // Always expires: 90 days by default.
    assert.ok(created.expiresAt);
    const days = (new Date(created.expiresAt!).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 89 && days <= 90, `expected ~90 days, got ${days}`);

    let r = await auth.requireMcpAuth(`Bearer ${created.key}`);
    assert.ok(r.ok);

    await setRole(WS_A, ADMIN_A, "editor");
    r = await auth.requireMcpAuth(`Bearer ${created.key}`);
    assert.deepEqual(r, { ok: false, reason: "insufficient_role" });

    await setRole(WS_A, ADMIN_A, null);
    r = await auth.requireMcpAuth(`Bearer ${created.key}`);
    assert.deepEqual(r, { ok: false, reason: "not_member" });
    await setRole(WS_A, ADMIN_A, "admin");
  });

  it("API key expiry: more than a year away is rejected", async () => {
    actor = { id: ADMIN_A, email: "admin-a@mcp.test" };
    activeWs = WS_A;
    const keys = await import("@/app/api/mcp/keys/route");
    const res = await keys.POST(
      new Request("http://x/api/mcp/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "forever",
          scopes: ALL,
          expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        }),
      }) as unknown as NextRequest,
    );
    assert.ok(res);
    assert.equal(res.status, 400);
  });

  it("re-approving a client for workspace B doesn't strand workspace A's token", async () => {
    // Owner approves the same client for A, then for B (client rebinds to B).
    const reg = await oauth.registerClient({ redirect_uris: [REDIRECT], client_name: "Agent" }, null);
    assert.ok(reg.ok);
    const clientId = reg.client.client_id;
    const mint = async (ws: string) => {
      const begun = await oauth.beginAuthorize({ clientId, redirectUri: REDIRECT, scope: "tools:list_projects" });
      assert.ok(begun.ok);
      const { code } = await oauth.approveAuthorization(begun.pending, OWNER, ws);
      const ex = await oauth.exchangeCode({ code, clientId, redirectUri: REDIRECT });
      assert.ok(ex.ok);
      return ex.token.access_token;
    };
    const tokA = await mint(WS_A);
    const tokB = await mint(WS_B);
    const client = await prisma.mcpOAuthClient.findUniqueOrThrow({ where: { clientId } });
    assert.equal(client.workspaceId, WS_B);

    // A's token still authenticates for A.
    const rA = await auth.requireMcpAuth(`Bearer ${tokA}`);
    assert.ok(rA.ok);
    assert.equal(rA.ctx.workspaceId, WS_A);

    // A's admin (not the client owner, not an admin of B) can revoke A's
    // access — previously forbidden because the client now points at B.
    actor = { id: ADMIN_A, email: "admin-a@mcp.test" };
    const revoke = await import("@/app/api/mcp/oauth/clients/[id]/route");
    const res = await revoke.DELETE(new Request("http://x"), { params: Promise.resolve({ id: clientId }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await auth.requireMcpAuth(`Bearer ${tokA}`), { ok: false, reason: "unknown" });
    // …and only A's: B's token is untouched.
    const rB = await auth.requireMcpAuth(`Bearer ${tokB}`);
    assert.ok(rB.ok);
    assert.equal(rB.ctx.workspaceId, WS_B);
  });

  it("an admin of an unrelated workspace still can't revoke", async () => {
    const t = await token(OWNER, WS_B, "tools:list_projects");
    actor = { id: ADMIN_A, email: "admin-a@mcp.test" };
    const revoke = await import("@/app/api/mcp/oauth/clients/[id]/route");
    const res = await revoke.DELETE(new Request("http://x"), { params: Promise.resolve({ id: t.clientId }) });
    assert.equal(res.status, 403);
  });
});

describe("consent page contract (text-level pin)", () => {
  const page = readFileSync("app/mcp/authorize/page.tsx", "utf8");
  it("names the app, the redirect host and says it's unverified, as ShapesOS", () => {
    assert.match(page, /clientName/);
    assert.match(page, /redirectHost\(pending\.redirectUri\)/);
    assert.match(page, /ShapesOS hasn&apos;t verified this app/);
    assert.match(page, /Connect an app to ShapesOS/);
    assert.doesNotMatch(page, /Marketr/);
    assert.match(page, /MCP_CONSENT_MIN_ROLE/);
  });
});
