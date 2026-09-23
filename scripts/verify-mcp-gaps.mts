// Marketr Phase C gaps (G3) — adversarial battery for MCP hardening:
// distributed rate limiting, OAuth workspace picker, per-key usage.
//
// Run: DATABASE_URL=<db> npx tsx scripts/verify-mcp-gaps.mts
// Run it three times before declaring stability.
//
// Threat-model coverage:
//   T13 rate-limit bypass via multi-instance desync
//   T14 consent workspace-picker privilege escalation
//   T15 sealed-grant workspace tampering
//   T16 byKey usage enumeration
//
// Real Postgres throughout. Every run uses unique ids and cleans up after
// itself.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Test-only credential key for the sealed-grant round-trip (never production).
if (!process.env.MARKETR_CREDENTIALS_KEY) {
  process.env.MARKETR_CREDENTIALS_KEY = randomBytes(32).toString("hex");
}
import { prisma } from "@/lib/prisma";
import { handleMcpPost } from "@/lib/mcp/protocol";
import { mintApiKey, hashSecret } from "@/lib/mcp/auth";
import {
  checkMcpRateLimit,
  getRateLimiter,
  InMemoryRateLimiter,
  PostgresRateLimiter,
  cleanupRateLimits,
  __setRateLimiterForTest,
  MCP_RATE_LIMIT,
} from "@/lib/mcp/rateLimit";
import { __setMeteringForTest, readUsageSummary } from "@/lib/mcp/metering";
import {
  registerClient,
  beginAuthorize,
  bindWorkspaceToGrant,
  approveWorkspaceBoundGrant,
  exchangeCode,
} from "@/lib/mcp/oauth";
import { secrets } from "@/lib/secrets";
import { scopeForTool } from "@/lib/mcp/scopes";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = randomBytes(4).toString("hex");

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const wsA = `g3-ws-a-${RUN}`; // owner userA, mcp on
const wsB = `g3-ws-b-${RUN}`; // owner userB, mcp on; userA is a MEMBER (picker case)
const wsC = `g3-ws-c-${RUN}`; // owner userA, mcp OFF
const wsD = `g3-ws-d-${RUN}`; // owner userB; userA member, then removed (revocation case)
const wsE = `g3-ws-e-${RUN}`; // owner userB; userA has NO access (foreign)
const userA = `g3-user-a-${RUN}`;
const userB = `g3-user-b-${RUN}`;

// Fake metering service with observable behavior + byKey support.
const fakeMeter: {
  calls: unknown[];
  byKey: Record<string, number> | undefined;
  meter: (args: unknown) => Promise<unknown>;
  getUsageSummary: (args: unknown) => Promise<unknown>;
} = {
  calls: [],
  byKey: undefined,
  async meter(args: unknown) {
    (this.calls as unknown[]).push(args);
    return { ok: true, charged: 2, eventId: `evt-${RUN}` };
  },
  async getUsageSummary() {
    return {
      used: 12,
      included: 100,
      purchased: 0,
      remaining: 88,
      byAction: { mcp_tool_call: 12 },
      byProject: {},
      ...(this.byKey !== undefined ? { byKey: this.byKey } : {}),
      periodStart: new Date().toISOString(),
    };
  },
};

const sealPending = (pending: object) => secrets().encrypt(JSON.stringify(pending));

async function ensureRateLimitTable() {
  const existing = await prisma.$queryRaw<{ reg: string | null }[]>`
    SELECT to_regclass('public.mcp_rate_limits')::text AS reg`;
  if (existing[0]?.reg) return;
  const sql = readFileSync(join(HERE, "..", "prisma", "migrations", "20260922250000_mcp_ratelimit", "migration.sql"), "utf8");
  for (const stmt of sql.split(";\n")) {
    const s = stmt.trim();
    if (s) await prisma.$executeRawUnsafe(s);
  }
}

async function makeKey(workspaceId: string, userId: string, name: string, scopes: string[]) {
  const { raw, keyHash, keyPrefix } = mintApiKey();
  const row = await prisma.mcpApiKey.create({ data: { workspaceId, userId, name, keyHash, keyPrefix, scopes } });
  return { id: row.id, raw };
}

async function setup() {
  await ensureRateLimitTable();
  await prisma.workspace.createMany({
    data: [
      { id: wsA, name: "g3 a", ownerUserId: userA, mcpEnabled: true },
      { id: wsB, name: "g3 b", ownerUserId: userB, mcpEnabled: true },
      { id: wsC, name: "g3 c", ownerUserId: userA, mcpEnabled: false },
      { id: wsD, name: "g3 d", ownerUserId: userB, mcpEnabled: true },
      { id: wsE, name: "g3 e", ownerUserId: userB, mcpEnabled: true },
    ],
  });
  // userA is a member (not owner) of wsB and wsD.
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: wsB, userId: userA, role: "editor" },
      { workspaceId: wsD, userId: userA, role: "editor" },
    ],
  });
}

async function cleanup() {
  const ids = [wsA, wsB, wsC, wsD, wsE];
  await prisma.$executeRaw`DELETE FROM "mcp_rate_limits" WHERE "bucket_key" LIKE ${`g3-%${RUN}`}`;
  await prisma.mcpOAuthToken.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpOAuthCode.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpApiKey.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { OR: [{ userId: { in: [userA, userB] } }] } });
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
}

const authz = (raw: string) => `Bearer ${raw}`;
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

async function main() {
  await setup();
  __setMeteringForTest(fakeMeter as never);

  console.log("T13 limiter selection");
  {
    delete process.env.MCP_RATE_LIMITER;
    __setRateLimiterForTest(undefined);
    ok("default is InMemoryRateLimiter", getRateLimiter() instanceof InMemoryRateLimiter);
    process.env.MCP_RATE_LIMITER = "postgres";
    __setRateLimiterForTest(undefined);
    ok("MCP_RATE_LIMITER=postgres selects PostgresRateLimiter", getRateLimiter() instanceof PostgresRateLimiter);
    process.env.MCP_RATE_LIMITER = "bogus-value";
    __setRateLimiterForTest(undefined);
    ok("bogus value falls back to memory (safe default)", getRateLimiter() instanceof InMemoryRateLimiter);
    delete process.env.MCP_RATE_LIMITER;
    __setRateLimiterForTest(undefined);
  }

  console.log("T13 in-memory behavior preserved");
  {
    __setRateLimiterForTest(new InMemoryRateLimiter());
    const bucket = `g3-mem-${RUN}`;
    let allowed = 0;
    for (let i = 0; i < MCP_RATE_LIMIT; i++) {
      if ((await checkMcpRateLimit(bucket)).allowed) allowed++;
    }
    ok("60 calls allowed in window", allowed === MCP_RATE_LIMIT);
    const over = await checkMcpRateLimit(bucket);
    ok("61st call denied", over.allowed === false && over.retryAfterMs > 0);
  }

  console.log("T13 postgres limiter: atomic agreement across instances");
  {
    __setRateLimiterForTest(new PostgresRateLimiter());
    const bucket = `g3-pg-${RUN}`;
    let allowed = 0;
    for (let i = 0; i < MCP_RATE_LIMIT; i++) {
      if ((await checkMcpRateLimit(bucket)).allowed) allowed++;
    }
    ok("postgres: 60 allowed in window", allowed === MCP_RATE_LIMIT);
    const over = await checkMcpRateLimit(bucket);
    ok("postgres: 61st denied with retry-after", over.allowed === false && over.retryAfterMs > 0);

    // Simulate two app instances racing on the same bucket.
    const bucket2 = `g3-pg-race-${RUN}`;
    const instA = new PostgresRateLimiter();
    const instB = new PostgresRateLimiter();
    const results = await Promise.all(
      Array.from({ length: 70 }, (_, i) =>
        (i % 2 === 0 ? instA : instB).check(bucket2, MCP_RATE_LIMIT, 60_000),
      ),
    );
    const totalAllowed = results.filter((r) => r.allowed).length;
    ok("70 concurrent checks across 2 instances → exactly 60 allowed", totalAllowed === MCP_RATE_LIMIT, `got ${totalAllowed}`);
  }

  console.log("T13 expired-window cleanup");
  {
    // Deterministic: drive cleanup with a fixed `now` instead of the wall clock.
    const limiter = new PostgresRateLimiter();
    const windowMs = 60_000;
    const fixedNow = 1_800_000_000_000; // fixed instant
    const curWindow = Math.floor(fixedNow / windowMs) * windowMs;
    const staleKey = `g3-pg-stale-${RUN}`;
    const liveKey = `g3-pg-live-${RUN}`;
    await prisma.$executeRaw`
      INSERT INTO "mcp_rate_limits" ("bucket_key", "window_start", "count")
      VALUES (${staleKey}, ${(curWindow - 5 * windowMs).toString()}::bigint, 999),
             (${liveKey}, ${curWindow.toString()}::bigint, 3)`;
    const removed = await limiter.cleanup(windowMs, fixedNow);
    ok("cleanup removes stale rows", removed >= 1);
    const staleLeft = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "mcp_rate_limits" WHERE "bucket_key" = ${staleKey}`;
    ok("stale row actually gone", Number(staleLeft[0].n) === 0);
    const liveLeft = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "mcp_rate_limits" WHERE "bucket_key" = ${liveKey}`;
    ok("current-window row kept", Number(liveLeft[0].n) === 1);
    await prisma.$executeRaw`DELETE FROM "mcp_rate_limits" WHERE "bucket_key" = ${liveKey}`;
  }

  console.log("T13 protocol gate honors the postgres limiter end-to-end");
  {
    __setRateLimiterForTest(new PostgresRateLimiter());
    const key = await makeKey(wsA, userA, "g3-ratelimit-key", [scopeForTool("list_projects")]);
    let last = { status: 200 };
    for (let i = 0; i <= MCP_RATE_LIMIT; i++) {
      last = await handleMcpPost(authz(key.raw), rpc("initialize", {}, i));
    }
    ok("61st /mcp call → 429 through the postgres backend", last.status === 429);
    __setRateLimiterForTest(new InMemoryRateLimiter());
  }

  console.log("T14 workspace picker: select step");
  let boundGrantWsB = "";
  {
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, null);
    if (!reg.ok) throw new Error("registerClient failed");
    const begun = await beginAuthorize({
      clientId: reg.client.client_id,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
    });
    if (!begun.ok) throw new Error("beginAuthorize failed");
    const grant = sealPending(begun.pending);

    // userA is a MEMBER (not owner) of wsB → allowed.
    const selB = await bindWorkspaceToGrant(grant, userA, wsB);
    ok("member workspace selectable", selB.ok);
    if (selB.ok) {
      boundGrantWsB = selB.grant;
      const inner = JSON.parse(secrets().decrypt(selB.grant));
      ok("re-sealed grant binds the chosen workspaceId", inner.workspaceId === wsB);
    }
    // userA owns wsA → allowed.
    const selA = await bindWorkspaceToGrant(grant, userA, wsA);
    ok("owned workspace selectable", selA.ok);
    // wsE belongs to userB only → rejected.
    const selE = await bindWorkspaceToGrant(grant, userA, wsE);
    ok("foreign workspace rejected", !selE.ok && selE.error === "workspace_not_accessible");
    // Empty workspaceId → rejected.
    const selEmpty = await bindWorkspaceToGrant(grant, userA, "");
    ok("empty workspaceId rejected", !selEmpty.ok);
    // Tampered outer grant → invalid_grant.
    const tamperedOuter = grant.slice(0, -4) + (grant.endsWith("AAAA") ? "BBBB" : "AAAA");
    const selT = await bindWorkspaceToGrant(tamperedOuter, userA, wsA);
    ok("tampered grant fails closed at select", !selT.ok && selT.error === "invalid_grant");
    // NOTE: the client row is deleted after the T15 block — the bound grant
    // above is still needed there.
    (globalThis as { __g3ClientId?: string }).__g3ClientId = reg.client.client_id;
  }

  console.log("T15 sealed-grant approval");
  {
    // Valid bound grant approves for exactly the bound workspace.
    const res = await approveWorkspaceBoundGrant(boundGrantWsB, userA);
    ok("bound grant approves", res.ok);
    if (res.ok) {
      const row = await prisma.mcpOAuthCode.findUnique({ where: { code: res.code } });
      ok("code bound to the SELECTED workspace (not the default)", !!row && row.workspaceId === wsB);
      ok("code carries the sealed scopes", !!row && row.scopes.join(" ") === "tools:list_projects");
      // Full exchange works and the token inherits the workspace.
      const x = await exchangeCode({ code: res.code, clientId: row!.clientId, redirectUri: "https://app.example.com/cb" });
      ok("code exchanges", x.ok);
      if (x.ok) {
        const tok = await prisma.mcpOAuthToken.findUnique({ where: { tokenHash: hashSecret(x.token.access_token) } });
        ok("token inherits the selected workspace", !!tok && tok.workspaceId === wsB);
        await prisma.mcpOAuthToken.delete({ where: { tokenHash: tok!.tokenHash } });
      }
      await prisma.mcpOAuthCode.delete({ where: { code: res.code } }).catch(() => {});
    }
    // Byte-flipped bound grant → fail closed.
    const tampered = boundGrantWsB.slice(0, -4) + (boundGrantWsB.endsWith("AAAA") ? "BBBB" : "AAAA");
    const resT = await approveWorkspaceBoundGrant(tampered, userA);
    ok("tampered bound grant rejected", !resT.ok && (resT as { error: string }).error === "invalid_grant");
    // Pre-picker grant shape (no workspaceId) cannot approve.
    const legacy = sealPending({ clientId: "x", redirectUri: "https://app.example.com/cb", scopes: ["tools:list_projects"] });
    const resL = await approveWorkspaceBoundGrant(legacy, userA);
    ok("grant without bound workspace rejected", !resL.ok && (resL as { error: string }).error === "workspace_not_selected");
    const cid = (globalThis as { __g3ClientId?: string }).__g3ClientId;
    if (cid) await prisma.mcpOAuthClient.delete({ where: { clientId: cid } }).catch(() => {});
  }

  console.log("T14 membership revoked between select and approve");
  {
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, null);
    if (!reg.ok) throw new Error("registerClient failed");
    const begun = await beginAuthorize({
      clientId: reg.client.client_id,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
    });
    if (!begun.ok) throw new Error("beginAuthorize failed");
    const sel = await bindWorkspaceToGrant(sealPending(begun.pending), userA, wsD);
    if (!sel.ok) throw new Error("select failed unexpectedly");
    // Revoke the membership, then approve.
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: wsD, userId: userA } });
    const res = await approveWorkspaceBoundGrant(sel.grant, userA);
    ok("approve after membership removal rejected", !res.ok && (res as { error: string }).error === "workspace_not_accessible");
    await prisma.mcpOAuthClient.delete({ where: { clientId: reg.client.client_id } });
  }

  console.log("T14/T8 disabled workspace cannot receive a token");
  {
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, null);
    if (!reg.ok) throw new Error("registerClient failed");
    const begun = await beginAuthorize({
      clientId: reg.client.client_id,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
    });
    if (!begun.ok) throw new Error("beginAuthorize failed");
    const sel = await bindWorkspaceToGrant(sealPending(begun.pending), userA, wsC);
    ok("select on disabled-MCP workspace succeeds (check is at mint time)", sel.ok);
    if (sel.ok) {
      const res = await approveWorkspaceBoundGrant(sel.grant, userA);
      ok("approve on disabled-MCP workspace rejected", !res.ok && (res as { status: number }).status === 403);
    }
    await prisma.mcpOAuthClient.delete({ where: { clientId: reg.client.client_id } });
  }

  console.log("T16/G3 per-key attribution end-to-end");
  {
    fakeMeter.calls = [];
    const key1 = await makeKey(wsA, userA, "g3-attr-1", [scopeForTool("list_projects")]);
    const key2 = await makeKey(wsA, userA, "g3-attr-2", [scopeForTool("list_projects")]);
    const r = await handleMcpPost(authz(key1.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    ok("tool call succeeds", (r.response?.result as { isError?: boolean } | undefined)?.isError !== true);
    const meteredArgs = fakeMeter.calls[fakeMeter.calls.length - 1] as { keyId?: string };
    ok("meter() receives the calling API key's ID", meteredArgs?.keyId === key1.id, JSON.stringify(meteredArgs?.keyId));
    ok("key2 not attributed for key1's call", meteredArgs?.keyId !== key2.id);

    // OAuth token call → no keyId (only API keys attribute).
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, null);
    if (!reg.ok) throw new Error("registerClient failed");
    const begun = await beginAuthorize({
      clientId: reg.client.client_id,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
    });
    if (!begun.ok) throw new Error("beginAuthorize failed");
    const selTok = await bindWorkspaceToGrant(sealPending(begun.pending), userA, wsA);
    if (!selTok.ok) throw new Error("select failed");
    const appr = await approveWorkspaceBoundGrant(selTok.grant, userA);
    if (!appr.ok) throw new Error("approve failed");
    const x = await exchangeCode({ code: appr.code, clientId: reg.client.client_id, redirectUri: "https://app.example.com/cb" });
    if (!x.ok) throw new Error("exchange failed");
    fakeMeter.calls = [];
    await handleMcpPost(authz(x.token.access_token), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const tokArgs = fakeMeter.calls[fakeMeter.calls.length - 1] as { keyId?: string };
    ok("OAuth token call passes no keyId", tokArgs != null && tokArgs.keyId === undefined, JSON.stringify(tokArgs?.keyId));
    await prisma.mcpOAuthClient.delete({ where: { clientId: reg.client.client_id } });

    // byKey consumption: present → mapped; absent → degrade to 0, no crash.
    fakeMeter.byKey = { [key1.id]: 7, "revoked-key-id": 3 };
    const sum = await readUsageSummary({ workspaceId: wsA });
    type SumShape = { summary: { byKey?: Record<string, number> } };
    ok("byKey surfaces from getUsageSummary", sum.ok && (sum as SumShape).summary.byKey?.[key1.id] === 7);
    const joinRow = { id: key1.id, usageCredits: ((sum.ok ? (sum as SumShape).summary.byKey : undefined) ?? {})[key1.id] ?? 0 };
    ok("UI join maps byKey id → usage", joinRow.usageCredits === 7);
    const revokedJoin = (((sum.ok ? (sum as SumShape).summary.byKey : undefined) ?? {})["revoked-key-id"] ?? 0);
    ok("revoked key keeps historical attribution by id", revokedJoin === 3);
    fakeMeter.byKey = undefined;
    const sum2 = await readUsageSummary({ workspaceId: wsA });
    const degraded = sum2.ok ? (((sum2 as SumShape).summary.byKey ?? {})[key1.id] ?? 0) : -1;
    ok("absent byKey degrades to 0 without crashing", degraded === 0);
  }

  console.log("migration SQL sanity");
  {
    const sql = readFileSync(join(HERE, "..", "prisma", "migrations", "20260922250000_mcp_ratelimit", "migration.sql"), "utf8");
    ok("migration creates mcp_rate_limits", sql.includes('"mcp_rate_limits"'));
    ok("migration has composite primary key", sql.includes("PRIMARY KEY"));
    ok("migration indexes window_start", sql.includes("window_start_idx"));
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_rate_limits'`;
    const names = cols.map((c) => c.column_name).sort().join(",");
    ok("table actually exists with expected columns", names === "bucket_key,count,updated_at,window_start", names);
  }

  console.log(`\nverify-mcp-gaps: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("battery crashed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    __setMeteringForTest(undefined);
    __setRateLimiterForTest(undefined);
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  });
