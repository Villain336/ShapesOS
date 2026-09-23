// Marketr Phase C (W5) — adversarial battery for the MCP server (lib/mcp).
//
// Run: DATABASE_URL=<local pg> npx tsx scripts/verify-mcp.mts
// Run it three times before declaring stability.
//
// Real Postgres (like verify-filesystem.mts): auth lookups, tenant scoping,
// single-use codes, and audit rows are all exercised against the real schema.
// Every run uses unique ids and cleans up after itself.
//
// Threat-model coverage:
//   T1 tenant confusion (workspaceId from args vs auth)
//   T2 scope escalation
//   T3 key leakage (storage, logs, error messages)
//   T4 rate-limit bypass
//   T5 DCR abuse (redirect_uri validation, open redirect)
//   T6 token/code replay
//   T7 consent scope tampering
//   T8 disabled-workspace access
//   T9 unmetered execution (fail-closed)
//   T10 audit tenant tags

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
import { mintApiKey, hashSecret, requireMcpAuth } from "@/lib/mcp/auth";
import { checkMcpRateLimit, resetMcpRateLimits } from "@/lib/mcp/rateLimit";
import { __setMeteringForTest } from "@/lib/mcp/metering";
import {
  registerClient,
  validateRedirectUri,
  beginAuthorize,
  approveAuthorization,
  exchangeCode,
} from "@/lib/mcp/oauth";
import { secrets } from "@/lib/secrets";
import { MCP_TOOL_NAMES, scopeForTool } from "@/lib/mcp/scopes";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = randomBytes(4).toString("hex");
const RUN_START = new Date();

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

const wsA = `mcp-test-ws-a-${RUN}`;
const wsB = `mcp-test-ws-b-${RUN}`;
const wsC = `mcp-test-ws-c-${RUN}`;
const userA = `mcp-test-user-a-${RUN}`;
const userB = `mcp-test-user-b-${RUN}`;
const pA = `mcp-test-pa-${RUN}`;
const pB = `mcp-test-pb-${RUN}`;

interface KeyRec {
  id: string;
  raw: string;
}

// Fake metering service with observable behavior.
const fakeMeter: {
  calls: unknown[];
  behavior: "ok" | "throw" | "cap";
  meter: (args: unknown) => Promise<unknown>;
  getUsageSummary: (args: unknown) => Promise<unknown>;
} = {
  calls: [],
  behavior: "ok",
  async meter(args: unknown) {
    (this.calls as unknown[]).push(args);
    if (this.behavior === "throw") throw new Error("meter exploded");
    if (this.behavior === "cap") return { ok: false, reason: "cap_exceeded", charged: 0 };
    return { ok: true, charged: 1, eventId: `evt-${RUN}` };
  },
  async getUsageSummary() {
    return {
      used: 10,
      included: 100,
      purchased: 0,
      remaining: 90,
      byAction: { mcp_tool_call: 10 },
      byProject: {},
      periodStart: new Date().toISOString(),
    };
  },
};

async function makeKey(workspaceId: string, userId: string, name: string, scopes: string[], extra: Record<string, unknown> = {}): Promise<KeyRec> {
  const { raw, keyHash, keyPrefix } = mintApiKey();
  const row = await prisma.mcpApiKey.create({
    data: { workspaceId, userId, name, keyHash, keyPrefix, scopes, ...extra },
  });
  return { id: row.id, raw };
}

async function setup() {
  await prisma.workspace.createMany({
    data: [
      { id: wsA, name: "mcp test a", ownerUserId: userA, mcpEnabled: true },
      { id: wsB, name: "mcp test b", ownerUserId: userB, mcpEnabled: true },
      { id: wsC, name: "mcp test c", ownerUserId: userA, mcpEnabled: false },
    ],
  });
  await prisma.project.createMany({
    data: [
      { id: pA, workspaceId: wsA, domain: "a.example.com", locale: "en-US" },
      { id: pB, workspaceId: wsB, domain: "b.example.com", locale: "en-US" },
    ],
  });
}

async function cleanup() {
  const ids = [wsA, wsB, wsC];
  await prisma.mcpOAuthToken.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpOAuthCode.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.mcpApiKey.deleteMany({ where: { workspaceId: { in: ids } } });
  // OAuth clients are user-owned, not workspace-owned: catch stragglers from
  // any test that threw between register and its inline delete — including
  // unowned public-DCR clients created during this run.
  await prisma.mcpOAuthClient.deleteMany({
    where: { OR: [{ userId: { in: [userA, userB] } }, { userId: null, createdAt: { gte: RUN_START } }] },
  });
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: [pA, pB] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
}

const authz = (raw: string) => `Bearer ${raw}`;
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});
const textOf = (resp: { result?: unknown } | null): string => {
  const r = resp?.result as { content?: { text?: string }[] } | undefined;
  return r?.content?.[0]?.text ?? "";
};
const isErr = (resp: { result?: unknown } | null): boolean =>
  (resp?.result as { isError?: boolean } | undefined)?.isError === true;

async function main() {
  await setup();
  // The battery controls metering deterministically via the test seam.
  __setMeteringForTest(fakeMeter as never);
  resetMcpRateLimits();

  const keyA = await makeKey(wsA, userA, "key-a", [scopeForTool("list_projects")]);
  const keyAFull = await makeKey(wsA, userA, "key-a-full", MCP_TOOL_NAMES.map(scopeForTool));
  const keyB = await makeKey(wsB, userB, "key-b", MCP_TOOL_NAMES.map(scopeForTool));
  const keyRevoked = await makeKey(wsA, userA, "key-revoked", MCP_TOOL_NAMES.map(scopeForTool), {
    revokedAt: new Date(),
  });
  const keyExpired = await makeKey(wsA, userA, "key-expired", MCP_TOOL_NAMES.map(scopeForTool), {
    expiresAt: new Date(Date.now() - 1000),
  });
  const keyC = await makeKey(wsC, userA, "key-c", MCP_TOOL_NAMES.map(scopeForTool));

  console.log("auth + protocol gates");
  {
    const r = await handleMcpPost(null, rpc("initialize", { protocolVersion: "2025-06-18" }));
    ok("missing auth → 401", r.status === 401);
    ok("401 body is generic", JSON.stringify(r.response).includes("Authentication failed"));
  }
  {
    const r = await handleMcpPost("Bearer not-a-real-key", rpc("initialize"));
    ok("garbage bearer → 401", r.status === 401);
    ok("no reason leaked to client", !JSON.stringify(r.response).match(/revoked|expired|unknown/));
  }
  {
    const r = await handleMcpPost(authz(keyRevoked.raw), rpc("initialize"));
    ok("revoked key → 401", r.status === 401);
  }
  {
    const r = await handleMcpPost(authz(keyExpired.raw), rpc("initialize"));
    ok("expired key → 401", r.status === 401);
  }
  {
    const r = await handleMcpPost(authz(keyA.raw), rpc("initialize", { protocolVersion: "2025-06-18" }));
    ok("valid key initialize → 200", r.status === 200);
    const result = r.response?.result as { protocolVersion?: string };
    ok("protocol version negotiated", result?.protocolVersion === "2025-06-18");
  }
  {
    const r = await handleMcpPost(authz(keyA.raw), { jsonrpc: "2.0", id: 1, method: "nope" });
    ok("unknown method → -32601", (r.response?.error as { code?: number })?.code === -32601);
  }
  {
    const r = await handleMcpPost(authz(keyA.raw), [rpc("initialize")]);
    ok("batch request rejected", r.status === 400);
  }
  {
    // lastUsedAt is touched on successful auth (best-effort).
    await new Promise((res) => setTimeout(res, 50));
    const row = await prisma.mcpApiKey.findUnique({ where: { id: keyA.id } });
    ok("lastUsedAt tracked", row?.lastUsedAt != null);
  }

  console.log("T8 disabled-workspace gate");
  {
    const r = await handleMcpPost(authz(keyC.raw), rpc("initialize"));
    ok("disabled workspace → 403", r.status === 403);
    await prisma.workspace.update({ where: { id: wsC }, data: { mcpEnabled: true } });
    const r2 = await handleMcpPost(authz(keyC.raw), rpc("initialize"));
    ok("enabled workspace → 200", r2.status === 200);
    await prisma.workspace.update({ where: { id: wsC }, data: { mcpEnabled: false } });
    const r3 = await handleMcpPost(authz(keyC.raw), rpc("initialize"));
    ok("re-disabled → 403 again", r3.status === 403);
  }

  console.log("T2 scope enforcement + tools/list filtering");
  {
    const r = await handleMcpPost(authz(keyA.raw), rpc("tools/list"));
    const tools = (r.response?.result as { tools?: { name: string }[] })?.tools ?? [];
    ok("tools/list shows only granted tool", tools.length === 1 && tools[0].name === "list_projects");
  }
  {
    fakeMeter.calls = [];
    const r = await handleMcpPost(
      authz(keyA.raw),
      rpc("tools/call", { name: "get_usage_summary", arguments: {} }),
    );
    ok("scope escalation denied", (r.response?.error as { message?: string })?.message === "Insufficient scope for this tool");
    ok("denied call not metered", fakeMeter.calls.length === 0);
    const denied = await prisma.fileChangeLog.findFirst({
      where: { workspaceId: wsA, action: "mcp_tool_denied" },
      orderBy: { createdAt: "desc" },
    });
    ok("denial audited tenant-tagged", !!denied && denied.summary.includes(wsA) && denied.summary.includes(keyA.id));
  }

  console.log("T1 tenant confusion");
  {
    // Forged workspaceId in args: the list_projects schema is strict → rejected.
    const r = await handleMcpPost(
      authz(keyAFull.raw),
      rpc("tools/call", { name: "list_projects", arguments: { workspaceId: wsB } }),
    );
    ok("forged workspaceId arg rejected", r.response?.error != null || isErr(r.response));
  }
  {
    const r = await handleMcpPost(authz(keyAFull.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const data = JSON.parse(textOf(r.response));
    const ids = (data.projects as { id: string }[]).map((p) => p.id);
    ok("tenant A sees only its projects", ids.includes(pA) && !ids.includes(pB));
  }
  {
    // Cross-tenant project id → project_not_found, B's data never leaks.
    const r = await handleMcpPost(
      authz(keyAFull.raw),
      rpc("tools/call", { name: "get_rank_report", arguments: { projectId: pB } }),
    );
    ok("cross-tenant project id → error", isErr(r.response));
    ok("no cross-tenant data in error", !textOf(r.response).includes("b.example.com"));
  }
  {
    // Tenant B's key cannot reach A's data either.
    const r = await handleMcpPost(authz(keyB.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const data = JSON.parse(textOf(r.response));
    const ids = (data.projects as { id: string }[]).map((p) => p.id);
    ok("tenant B isolated", ids.includes(pB) && !ids.includes(pA));
  }

  console.log("T9 metering fail-closed");
  {
    __setMeteringForTest(null); // module missing
    const before = await prisma.fileChangeLog.count({ where: { workspaceId: wsA, action: "mcp_tool_called" } });
    const r = await handleMcpPost(authz(keyAFull.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const msg = (r.response?.error as { message?: string } | undefined)?.message ?? "";
    ok("missing metering module → call fails", r.response?.error != null);
    ok("fail-closed message is plain", msg.includes("Metering is temporarily unavailable") && !msg.includes("mcp:"));
    const after = await prisma.fileChangeLog.count({ where: { workspaceId: wsA, action: "mcp_tool_called" } });
    ok("handler never ran unmetered", after === before);
  }
  {
    __setMeteringForTest({ ...fakeMeter, behavior: "throw", calls: fakeMeter.calls } as never);
    const r = await handleMcpPost(authz(keyAFull.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const msg = (r.response?.error as { message?: string } | undefined)?.message ?? "";
    ok("throwing meter() → fail closed", msg.includes("Metering is temporarily unavailable"));
  }
  {
    fakeMeter.behavior = "cap";
    __setMeteringForTest(fakeMeter as never);
    const r = await handleMcpPost(authz(keyAFull.raw), rpc("tools/call", { name: "list_projects", arguments: {} }));
    const msg = (r.response?.error as { message?: string } | undefined)?.message ?? "";
    ok("cap_exceeded → plain denial, no execution", msg.includes("Spend cap exceeded"));
    fakeMeter.behavior = "ok";
  }
  {
    // Success path: meter called BEFORE execution with the documented passthrough.
    fakeMeter.calls = [];
    __setMeteringForTest(fakeMeter as never);
    const r = await handleMcpPost(authz(keyAFull.raw), rpc("tools/call", { name: "get_rank_report", arguments: { projectId: pA } }));
    ok("metered call executes", !isErr(r.response) && !r.response?.error);
    const call = fakeMeter.calls[0] as { action?: string; evidenceRef?: string; idempotencyKey?: string; workspaceId?: string };
    ok("meter action is mcp_tool_call", call?.action === "mcp_tool_call");
    ok("passthrough in evidenceRef", call?.evidenceRef === "mcp:get_rank_report:1");
    ok("meter tenant = auth tenant", call?.workspaceId === wsA);
    ok("idempotency key present", typeof call?.idempotencyKey === "string" && call.idempotencyKey.startsWith("mcp:"));
  }

  console.log("T4 rate limits");
  {
    resetMcpRateLimits();
    let last = { status: 200 };
    for (let i = 0; i < 61; i++) {
      last = await handleMcpPost(authz(keyAFull.raw), rpc("initialize", {}, i));
    }
    ok("61st call in window → 429", last.status === 429);
    // Independent budgets: keyA still has room.
    const other = await checkMcpRateLimit(keyA.id);
    ok("budgets are per-credential", other.allowed === true);
    resetMcpRateLimits();
  }

  console.log("T3 key material hygiene");
  {
    // Only the hash is stored; the raw key is not recoverable from the DB.
    const byRaw = await prisma.mcpApiKey.findFirst({ where: { keyHash: keyA.raw } });
    ok("raw key is not the stored hash", byRaw === null);
    const auth = await requireMcpAuth(authz(keyA.raw));
    ok("hash lookup authenticates", auth.ok === true);
    // Logs/audit never carry raw material.
    const audit = await prisma.fileChangeLog.findFirst({
      where: { workspaceId: wsA, action: "mcp_tool_called" },
      orderBy: { createdAt: "desc" },
    });
    ok("audit has no raw key", !!audit && !audit.summary.includes(keyAFull.raw));
    ok("audit carries key id + prefix", !!audit && audit.summary.includes(keyAFull.id));
  }

  console.log("T10 audit tenant tags");
  {
    const rows = await prisma.fileChangeLog.findMany({
      where: { workspaceId: wsA, filePath: { startsWith: "mcp:" } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    ok("mcp audit rows exist", rows.length > 0);
    ok(
      "rows carry tenant tags",
      rows.every((r) => r.summary.includes(wsA) && (r.summary.includes("key:") || r.summary.includes("oauth:"))),
    );
    const rpcRows = await prisma.fileChangeLog.findMany({
      where: { workspaceId: wsA, action: "mcp_rpc" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    ok("initialize/tools/list audited as mcp_rpc", rpcRows.length >= 2);
    ok(
      "rpc rows carry tenant + credential tags",
      rpcRows.every((r) => r.summary.includes(wsA) && r.summary.includes("key:")),
    );
  }

  console.log("T5 DCR redirect_uri validation");
  {
    const cases: [string, boolean][] = [
      ["https://app.example.com/callback", true],
      ["http://localhost:8080/cb", true],
      ["http://127.0.0.1:9000/cb", true],
      // DCR is OPEN registration: any well-formed https URI is accepted at
      // registration. The security is exact-match at authorize time + the
      // signed-in user's approval — not URI reputation.
      ["https://evil.example.com/", true],
      ["http://evil.example.com/cb", false],
      ["javascript:alert(1)", false],
      ["https://good.example.com@evil.example.com/cb", false],
      ["https://1.2.3.4/cb", false],
      ["https://app.example.com/cb#frag", false],
      ["not a url", false],
    ];
    let allOk = true;
    for (const [uri, want] of cases) {
      const got = validateRedirectUri(uri).ok;
      if (got !== want) {
        allOk = false;
        console.log(`    redirect case mismatch: ${uri} → ${got}, want ${want}`);
      }
    }
    ok("redirect_uri allow/deny matrix", allOk);
  }
  {
    // Open registration accepts well-formed https URIs (protection is the
    // exact-match + user approval at authorize time); it rejects dangerous schemes.
    const bad = await registerClient({ redirect_uris: ["javascript:alert(1)"] }, userA);
    ok("DCR rejects dangerous redirect_uri", bad.ok === false && bad.status === 400);
    const good = await registerClient({ redirect_uris: ["https://attacker.example/cb"] }, userA);
    ok("DCR accepts well-formed https redirect_uri", good.ok === true);
    if (good.ok) await prisma.mcpOAuthClient.delete({ where: { clientId: good.client.client_id } });
  }
  {
    // Public DCR: registration with NO owner (RFC 7591). Nothing sensitive is bound.
    const pub = await registerClient({ redirect_uris: ["https://app.example.com/cb"], client_name: "public-dcr" }, null);
    ok("public DCR (no owner) accepted", pub.ok === true);
    if (pub.ok) {
      const row = await prisma.mcpOAuthClient.findUnique({ where: { clientId: pub.client.client_id } });
      ok("public client unowned until approval", !!row && row.userId === null && row.workspaceId === null);
      await prisma.mcpOAuthClient.delete({ where: { clientId: pub.client.client_id } });
    }
  }
  {
    // Ownership claim: first approver wins; a different user cannot hijack.
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, null);
    const clientId = reg.ok ? reg.client.client_id : "";
    const begun = await beginAuthorize({ clientId, redirectUri: "https://app.example.com/cb", scope: "tools:list_projects" });
    if (!begun.ok) throw new Error("beginAuthorize failed in test");
    await approveAuthorization(begun.pending, userA, wsA);
    const claimed = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
    ok("first approver claims ownership", !!claimed && claimed.userId === userA && claimed.workspaceId === wsA);
    let hijacked = false;
    try {
      await approveAuthorization(begun.pending, userB, wsB);
    } catch {
      hijacked = true;
    }
    ok("second user cannot hijack client", hijacked);
    const still = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
    ok("ownership unchanged after hijack attempt", !!still && still.userId === userA);
    await prisma.mcpOAuthCode.deleteMany({ where: { clientId } });
    await prisma.mcpOAuthClient.delete({ where: { clientId } });
  }
  {
    const res = await registerClient({ redirect_uris: ["https://app.example.com/cb"], client_name: "test-client" }, userA);
    ok("DCR accepts valid registration", res.ok === true);
    const clientId = res.ok ? res.client.client_id : "";
    // Authorize with an UNREGISTERED redirect_uri → hard error, no redirect.
    const bad = await beginAuthorize({ clientId, redirectUri: "https://attacker.example/cb", scope: "tools:list_projects" });
    ok("unregistered redirect_uri → no code", bad.ok === false);
    // Registered URI + valid scope → pending for the consent screen.
    const good = await beginAuthorize({
      clientId,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
      state: "s1",
    });
    ok("valid authorize request → pending", good.ok === true);
    // Unknown scope rejected at authorize time.
    const badScope = await beginAuthorize({ clientId, redirectUri: "https://app.example.com/cb", scope: "tools:drop_tables" });
    ok("unknown scope rejected", badScope.ok === false);
    await prisma.mcpOAuthClient.delete({ where: { clientId } });
  }

  console.log("T6 code/token replay + PKCE");
  {
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, userA);
    const clientId = reg.ok ? reg.client.client_id : "";
    const begun = await beginAuthorize({
      clientId,
      redirectUri: "https://app.example.com/cb",
      scope: "tools:list_projects",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256",
    });
    if (!begun.ok) throw new Error("beginAuthorize failed in test");
    const { code } = await approveAuthorization(begun.pending, userA, wsA);
    // Wrong verifier → PKCE fails.
    const wrong = await exchangeCode({ code, clientId, redirectUri: "https://app.example.com/cb", codeVerifier: "wrong" });
    ok("wrong PKCE verifier rejected", wrong.ok === false);
    // Right verifier (RFC 7636 example: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").
    const first = await exchangeCode({
      code,
      clientId,
      redirectUri: "https://app.example.com/cb",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    ok("correct exchange succeeds", first.ok === true);
    const token = first.ok ? first.token.access_token : "";
    // Replay the same code → rejected.
    const replay = await exchangeCode({
      code,
      clientId,
      redirectUri: "https://app.example.com/cb",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    ok("code replay rejected", replay.ok === false);
    // The minted token works on /mcp with its granted scope.
    const r = await handleMcpPost(authz(token), rpc("tools/list"));
    const tools = (r.response?.result as { tools?: { name: string }[] })?.tools ?? [];
    ok("oauth token authenticates", r.status === 200 && tools.length === 1 && tools[0].name === "list_projects");
    // …but cannot escalate beyond its granted scope.
    const esc = await handleMcpPost(authz(token), rpc("tools/call", { name: "get_usage_summary", arguments: {} }));
    ok("oauth token scope-bound", (esc.response?.error as { message?: string })?.message === "Insufficient scope for this tool");
    await prisma.mcpOAuthToken.deleteMany({ where: { clientId } });
    await prisma.mcpOAuthClient.delete({ where: { clientId } });
  }

  console.log("T6b concurrent exchange race");
  {
    // Two simultaneous exchanges of the same code: exactly one wins (the
    // conditional updateMany claim is the atomic gate).
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, userA);
    const clientId = reg.ok ? reg.client.client_id : "";
    const begun = await beginAuthorize({ clientId, redirectUri: "https://app.example.com/cb", scope: "tools:list_projects" });
    if (!begun.ok) throw new Error("beginAuthorize failed in test");
    const { code } = await approveAuthorization(begun.pending, userA, wsA);
    const params = { code, clientId, redirectUri: "https://app.example.com/cb" };
    const [r1, r2] = await Promise.all([exchangeCode(params), exchangeCode(params)]);
    const wins = [r1, r2].filter((r) => r.ok).length;
    ok("concurrent exchange: exactly one winner", wins === 1);
    const tokens = await prisma.mcpOAuthToken.count({ where: { clientId } });
    ok("exactly one token minted", tokens === 1);
    await prisma.mcpOAuthToken.deleteMany({ where: { clientId } });
    await prisma.mcpOAuthCode.deleteMany({ where: { clientId } });
    await prisma.mcpOAuthClient.delete({ where: { clientId } });
  }

  console.log("T7 consent scope tamper");
  {
    // The grant is AES-GCM sealed: flipping a byte breaks decryption.
    const grant = secrets().encrypt(JSON.stringify({ clientId: "x", scopes: ["tools:list_projects"] }));
    const tampered = grant.slice(0, -4) + (grant.endsWith("AAAA") ? "BBBB" : "AAAA");
    let threw = false;
    try {
      secrets().decrypt(tampered);
    } catch {
      threw = true;
    }
    ok("tampered grant fails decryption", threw);
    // approveAuthorization mints EXACTLY the sealed scope set.
    const reg = await registerClient({ redirect_uris: ["https://app.example.com/cb"] }, userA);
    const clientId = reg.ok ? reg.client.client_id : "";
    const begun = await beginAuthorize({ clientId, redirectUri: "https://app.example.com/cb", scope: "tools:list_projects" });
    if (!begun.ok) throw new Error("beginAuthorize failed in test");
    const { code } = await approveAuthorization(begun.pending, userA, wsA);
    const row = await prisma.mcpOAuthCode.findUnique({ where: { code } });
    ok(
      "minted code scopes == sealed scopes",
      !!row && row.scopes.length === 1 && row.scopes[0] === "tools:list_projects",
    );
    ok("code bound to approver workspace", !!row && row.workspaceId === wsA);
    await prisma.mcpOAuthCode.delete({ where: { code } });
    await prisma.mcpOAuthClient.delete({ where: { clientId } });
  }

  console.log("migration SQL sanity");
  {
    const sql = readFileSync(join(HERE, "..", "prisma", "migrations", "20260922220000_mcp_server", "migration.sql"), "utf8");
    for (const t of ["mcp_api_keys", "mcp_oauth_clients", "mcp_oauth_codes", "mcp_oauth_tokens"]) {
      ok(`migration creates ${t}`, sql.includes(`"${t}"`));
    }
    ok("migration adds mcp_enabled", sql.includes("mcp_enabled"));
    for (const a of ["mcp_tool_called", "mcp_tool_denied", "mcp_key_created", "mcp_key_revoked", "mcp_oauth_authorized"]) {
      ok(`migration adds audit action ${a}`, sql.includes(a));
    }
  }

  console.log(`\nverify-mcp: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("battery crashed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    __setMeteringForTest(undefined);
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  });
