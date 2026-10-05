// Marketr milestone 21 (part B) — connectors + vault verification.
//
// Run: npx tsx scripts/verify-m21-connectors.mts
// Run 3x green before calling this done.
//
// Part 1 (no DB, no network): all 27 native adapters resolve; listTools()
// non-empty with unique names and honest mutating flags; mock invoke on 3+
// adapters returns mock:true; secrets() encrypt→decrypt round-trip; OAuth
// state sign/verify + tamper rejection + expiry rejection.
//
// Part 2 (ephemeral local Postgres + prisma db push): storeApiKey round-trip,
// getDecryptedCredential, handleOAuthCallback with an injected fake token
// endpoint (no network), refreshConnection success ("refreshed") and
// failure ("needs_reauth") with an injected stub fetch, deleteConnection.
//
// No live third-party calls anywhere. No network at all.

import { execSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Test-only env before any lib imports.
if (!process.env.MARKETR_CREDENTIALS_KEY) {
  process.env.MARKETR_CREDENTIALS_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}
process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

async function main() {
  console.log("== M21 connectors + vault verification ==");

  // ---------------------------------------------------------------- part 1
  const { resolveAdapter, listBuiltinConnectors, getBuiltinMeta } = await import(
    "@/lib/connectors/m21/registry"
  );
  const { secrets } = await import("@/lib/secrets");
  const { signOAuthState, parseOAuthState, startOAuthFlow } = await import(
    "@/lib/vault/oauth"
  );
  const { isStdioAllowed, mcpToolToDef } = await import("@/lib/connectors/m21/mcp");

  const metas = listBuiltinConnectors();
  // 11 original + Gmail/Calendar (Connector Agent slice 2) + Google Business Profile (Phase 4b).
  check("27 built-in connectors registered", metas.length === 27); // Phase 11: +5 devtools, +3 bizsync; Phase 14: +gusto
  const expectedKeys = [
    "google-search-console", "ga4", "wordpress", "webflow", "google-drive",
    "notion", "buffer", "resend", "dataforseo", "meta-ads", "google-ads",
    "gmail", "google-calendar", "google-business-profile",
    // Phase 11 (conncore).
    "outlook", "outlook-calendar", "slack", "hubspot",
    // Phase 11 (devtools).
    "linear", "jira", "airtable", "supabase", "netlify",
    // Phase 11 (bizsync).
    "shopify", "quickbooks", "xero",
  ];
  for (const k of expectedKeys) {
    check(`registry has ${k}`, metas.some((m) => m.key === k));
    check(`getBuiltinMeta(${k})`, getBuiltinMeta(k).key === k);
  }

  const ctx = { workspaceId: "ws-test", userId: "user-test" };
  const mustMutate: Record<string, string[]> = {
    wordpress: ["save_content"],
    webflow: ["publish_site"],
    buffer: ["create_post", "schedule_post", "delete_post"],
    resend: ["send_test_email"],
    "google-business-profile": ["reply_to_review", "create_post"],
  };
  const adapters: Record<string, { listTools(): unknown[]; key: string; authType: string }> = {};

  for (const k of expectedKeys) {
    let adapter: { listTools(): Array<{ name: string; mutating: boolean; argsSchema: unknown }>; key: string; authType: string };
    try {
      adapter = resolveAdapter(k) as typeof adapter;
      check(`resolveAdapter(${k})`, adapter.key === k);
    } catch {
      check(`resolveAdapter(${k})`, false);
      continue;
    }
    adapters[k] = adapter;
    const tools = adapter.listTools();
    check(`${k}: listTools() non-empty`, tools.length > 0 && tools.length <= 8);
    const names = tools.map((t) => t.name);
    check(`${k}: tool names unique`, new Set(names).size === names.length);
    check(`${k}: tool names non-empty strings`, names.every((n) => typeof n === "string" && n.length > 0));
    for (const t of tools) {
      check(
        `${k}.${t.name}: honest argsSchema object`,
        typeof t.argsSchema === "object" && t.argsSchema !== null && (t.argsSchema as { type: string }).type === "object",
      );
    }
    // Read-only-looking tools must not be flagged mutating.
    const reads = tools.filter((t) =>
      /^(list|get|search|query|test|traffic|top|page|keyword|serp|competitor|backlinks|account|export|read)/.test(t.name),
    );
    for (const t of reads) {
      check(`${k}.${t.name}: read tool mutating=false`, t.mutating === false);
    }
    for (const t of mustMutate[k] ?? []) {
      check(`${k}.${t}: write tool mutating=true`, tools.some((x) => x.name === t && x.mutating === true));
    }
  }
  try {
    resolveAdapter("no-such-connector");
    check("resolveAdapter throws on unknown key", false);
  } catch {
    check("resolveAdapter throws on unknown key", true);
  }

  // authType agreement between registry and adapter.
  for (const k of expectedKeys) {
    const meta = getBuiltinMeta(k);
    check(`${k}: adapter authType matches registry`, adapters[k].authType === meta.authType);
  }

  // Mock invoke returns mock:true (no credential → mock path).
  const gsc = resolveAdapter("google-search-console");
  const q = await gsc.invoke("query_performance", { property: "sc-domain:x.test", startDate: "2026-08-01", endDate: "2026-09-01" }, null, ctx);
  check("gsc mock invoke ok + mock:true", q.ok === true && q.mock === true);
  const gscRows = (q.data as { rows: Array<{ query: string; clicks: number; mock: boolean }> }).rows;
  check("gsc rows carry mock:true", Array.isArray(gscRows) && gscRows.length > 0 && gscRows.every((r) => r.mock === true));

  const notion = resolveAdapter("notion");
  const n = await notion.invoke("search_pages", { query: "brand" }, null, ctx);
  check("notion mock invoke ok + mock:true", n.ok === true && n.mock === true);

  const dfs = resolveAdapter("dataforseo");
  const d = await dfs.invoke("keyword_ideas", { seed: "dental implants", limit: 5 }, null, ctx);
  check("dataforseo mock invoke ok + mock:true (no env keys)", d.ok === true && d.mock === true);

  const buffer = resolveAdapter("buffer");
  const b = await buffer.invoke("list_profiles", {}, null, ctx);
  check("buffer mock invoke ok + mock:true", b.ok === true && b.mock === true);

  const resend = resolveAdapter("resend");
  const r = await resend.invoke("send_test_email", { from: "a@x.test", to: "b@x.test", subject: "s", html: "<p>h</p>" }, null, ctx);
  check("resend mock invoke ok + mock:true", r.ok === true && r.mock === true);

  const wp = resolveAdapter("wordpress");
  const w = await wp.invoke("list_content", { kind: "post" }, null, ctx);
  check("wordpress mock invoke ok + mock:true", w.ok === true && w.mock === true);

  const unknownTool = await wp.invoke("nope", {}, null, ctx);
  check("unknown tool → ok:false", unknownTool.ok === false && typeof unknownTool.error === "string");

  // getAdapterForConnection: built-in key → native adapter.
  const { getAdapterForConnection } = await import("@/lib/connectors/m21/index");
  const viaConn = await getAdapterForConnection({ connectorKey: "notion" });
  check("getAdapterForConnection(built-in) → native adapter", viaConn.key === "notion");
  let customNoEndpoint = false;
  try {
    await getAdapterForConnection({ connectorKey: "custom-acme", connector: { mcpEndpoint: null } });
  } catch {
    customNoEndpoint = true;
  }
  check("getAdapterForConnection(custom, no endpoint) throws", customNoEndpoint);

  // stdio gate: hosted default → disallowed.
  delete process.env.MARKETR_SELF_HOSTED;
  check("isStdioAllowed() false without env", isStdioAllowed() === false);
  process.env.MARKETR_SELF_HOSTED = "true";
  check("isStdioAllowed() true on self-hosted", isStdioAllowed() === true);
  delete process.env.MARKETR_SELF_HOSTED;

  // MCP tool schema conversion.
  const def = mcpToolToDef({ name: "do_thing", description: "Does a thing", inputSchema: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] } });
  // Phase 1 (H5): MCP tools are mutating unless annotated readOnlyHint (or admin allow-listed).
  check("mcpToolToDef converts schema", def.name === "do_thing" && def.mutating === true && (def.argsSchema.required ?? []).includes("q"));
  const ro = mcpToolToDef({ name: "read_thing", description: "Reads", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
  check("mcpToolToDef honours readOnlyHint", ro.mutating === false);

  // secrets() round-trip.
  const blob = secrets().encrypt("super-secret-token");
  check("secrets() encrypt→decrypt round-trip", secrets().decrypt(blob) === "super-secret-token");
  let tampered = false;
  try {
    secrets().decrypt(blob.slice(0, -2) + "xx");
  } catch {
    tampered = true;
  }
  check("secrets() tamper rejection", tampered);

  // OAuth state sign/verify.
  const state = signOAuthState({ userId: "u1", workspaceId: "ws1", connectorKey: "ga4", exp: Date.now() + 60000, nonce: "n1" });
  const parsed = parseOAuthState(state);
  check("OAuth state verify ok", parsed.userId === "u1" && parsed.connectorKey === "ga4");
  let tamperRejected = true;
  const corruptPositions = [
    state.slice(0, -3) + (state.slice(-3) === "aaa" ? "bbb" : "aaa"), // tail (tag padding zone)
    state.slice(0, 20) + (state[20] === "A" ? "B" : "A") + state.slice(21), // head (iv zone)
    state.slice(0, Math.floor(state.length / 2)) +
      (state[Math.floor(state.length / 2)] === "A" ? "B" : "A") +
      state.slice(Math.floor(state.length / 2) + 1), // middle (ciphertext zone)
  ];
  for (const corrupted of corruptPositions) {
    try {
      parseOAuthState(corrupted);
      tamperRejected = false;
    } catch {
      // expected
    }
  }
  check("OAuth state tamper rejection (head/mid/tail)", tamperRejected);
  let expiredRejected = false;
  try {
    parseOAuthState(signOAuthState({ userId: "u1", workspaceId: "ws1", connectorKey: "ga4", exp: Date.now() - 1000, nonce: "n2" }));
  } catch {
    expiredRejected = true;
  }
  check("OAuth state expiry rejection", expiredRejected);

  const flow = startOAuthFlow("u1", "ws1", "google-drive", "https://app.test");
  check("startOAuthFlow returns url + state", flow.url.includes("accounts.google.com") && flow.state.length > 0);
  check("startOAuthFlow url carries drive scopes", decodeURIComponent(flow.url).includes("drive.readonly"));
  let oauthUnknown = false;
  try {
    startOAuthFlow("u1", "ws1", "resend", "https://app.test");
  } catch {
    oauthUnknown = true;
  }
  check("startOAuthFlow throws for non-OAuth connector", oauthUnknown);

  // ---------------------------------------------------------------- part 2
  console.log("-- starting ephemeral postgres for vault DB tests --");
  const pgDir = mkdtempSync(join(tmpdir(), "m21pg-"));
  // mkdtempSync creates the dir root-owned 0700; hand it to the postgres user.
  execSync(`chown postgres:postgres ${pgDir} && chmod 700 ${pgDir}`);
  const port = 55433;
  const sockDir = join(pgDir, "sock");
  // Postgres refuses to initdb as root; run the whole DB lifecycle as the
  // unprivileged `postgres` system user. The temp dir is under /tmp so it
  // can reach it.
  const asPostgres = (cmd: string) =>
    execSync(`su postgres -s /bin/sh -c ${JSON.stringify(cmd)}`, { stdio: "pipe" });
  asPostgres(`mkdir -p ${sockDir} && /usr/lib/postgresql/16/bin/initdb -D ${pgDir}/data -E UTF8 >/dev/null 2>&1`);
  const startOut = spawnSync("su", [
    "postgres", "-s", "/bin/sh", "-c",
    `/usr/lib/postgresql/16/bin/pg_ctl -D ${pgDir}/data -o '-k ${sockDir} -p ${port} -c listen_addresses=''' -l ${pgDir}/log start`,
  ]);
  check("postgres started", startOut.status === 0);
  const dbUrl = `postgresql://postgres@localhost:${port}/m21test?host=${sockDir}`;
  asPostgres(`psql -h ${sockDir} -p ${port} -U postgres -c "CREATE DATABASE m21test;"`);
  // The schema uses pgvector + pg_trgm columns/indexes; db push doesn't create extensions.
  asPostgres(`psql -h ${sockDir} -p ${port} -U postgres -d m21test -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"`);
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: join(process.cwd()),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
  check("prisma db push ok", true);
  process.env.DATABASE_URL = dbUrl;

  const { storeApiKey, deleteConnection } = await import("@/lib/vault/apikey");
  const { getDecryptedCredential, refreshConnection } = await import("@/lib/vault/refresh");
  const { handleOAuthCallback } = await import("@/lib/vault/callback");
  const { prisma } = await import("@/lib/prisma");

  // Seed the FK targets (ephemeral DB, torn down at the end).
  await prisma.workspace.create({ data: { id: "ws-a", name: "Test Workspace", ownerUserId: "user-a" } });

  // storeApiKey round-trip.
  const conn1 = await storeApiKey("user-a", "ws-a", "resend", "Test key", "re_secret_123", {
    extra: { defaultFrom: "hello@x.test" },
  });
  check("storeApiKey creates connection (active)", conn1.status === "active" && conn1.connectorKey === "resend");
  check("storeApiKey meta.label", (conn1.meta as { label: string }).label === "Test key");
  const dec1 = await getDecryptedCredential(conn1.id);
  check(
    "getDecryptedCredential round-trip",
    dec1 !== null && dec1.kind === "api_key" && dec1.payload.apiKey === "re_secret_123" && dec1.payload.defaultFrom === "hello@x.test",
  );

  // Fake token endpoint (injected stub — zero network).
  const fakeTokenFetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (body.get("grant_type") === "authorization_code" && body.get("code") === "good-code") {
      return new Response(JSON.stringify({ access_token: "tok_abc", refresh_token: "ref_xyz", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }) as unknown as typeof fetch;

  // handleOAuthCallback with fake state + fake token endpoint.
  const cbState = signOAuthState({ userId: "user-a", workspaceId: "ws-a", connectorKey: "ga4", exp: Date.now() + 60000, nonce: "cb1" });
  const cbConn = await handleOAuthCallback(cbState, "good-code", "https://app.test/api/oauth/callback", { fetchImpl: fakeTokenFetch });
  check("handleOAuthCallback creates connection", cbConn.status === "active" && cbConn.connectorKey === "ga4");
  const decCb = await getDecryptedCredential(cbConn.id);
  check(
    "handleOAuthCallback stores encrypted oauth tokens",
    decCb !== null && decCb.kind === "oauth2" && decCb.payload.access_token === "tok_abc" && decCb.payload.refresh_token === "ref_xyz",
  );

  // refreshConnection success path (fake token endpoint issues new tokens).
  const fakeRefreshFetch = (async () => {
    return new Response(JSON.stringify({ access_token: "tok_new", refresh_token: "ref_new", expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const refreshed = await refreshConnection(cbConn.id, { fetchImpl: fakeRefreshFetch });
  check("refreshConnection → refreshed", refreshed === "refreshed");
  const decNew = await getDecryptedCredential(cbConn.id);
  check("refreshConnection rotates access token", decNew?.payload.access_token === "tok_new");

  // refreshConnection failure path (provider rejects → needs_reauth).
  const fakeRejectFetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
  const rejected = await refreshConnection(cbConn.id, { fetchImpl: fakeRejectFetch });
  check("refreshConnection → needs_reauth on provider rejection", rejected === "needs_reauth");
  const after = await prisma.connectorConnection.findUnique({ where: { id: cbConn.id } });
  check("status flipped to needs_reauth", after?.status === "needs_reauth");

  // refreshConnection with no refresh token → needs_reauth (api-key connection).
  const noRefresh = await refreshConnection(conn1.id, { fetchImpl: fakeRefreshFetch });
  check("refreshConnection → needs_reauth without refresh_token", noRefresh === "needs_reauth");

  // deleteConnection removes credential + connection.
  await deleteConnection(conn1.id, "ws-a");
  const gone = await prisma.connectorConnection.findUnique({ where: { id: conn1.id } });
  const goneCred = await prisma.connectorCredential.findUnique({ where: { connectionId: conn1.id } });
  check("deleteConnection removes connection", gone === null);
  check("deleteConnection removes credential", goneCred === null);
  let crossWs = false;
  try {
    await deleteConnection(cbConn.id, "ws-other");
  } catch {
    crossWs = true;
  }
  check("deleteConnection fail-closed on wrong workspace", crossWs);

  await prisma.$disconnect();
  spawnSync("su", ["postgres", "-s", "/bin/sh", "-c", `/usr/lib/postgresql/16/bin/pg_ctl -D ${pgDir}/data stop >/dev/null 2>&1`]);
  rmSync(pgDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- summary
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:", failures.join("; "));
    process.exit(1);
  }
  console.log("M21 connectors + vault: ALL GREEN");
}

main().catch((err) => {
  console.error("verify script crashed:", err);
  process.exit(1);
});
