// Phase 11 (conncore): OAuth 2.1 for remote MCP servers, end to end against
// a LOCAL FAKE authorization server + a bearer-protected MCP server (both
// test fixtures on 127.0.0.1 — no real provider):
//   discovery (RFC 9728 → RFC 8414) → dynamic client registration (RFC 7591)
//   → authorize URL with PKCE S256 + resource (RFC 8707) + signed state →
//   code exchange (verifier checked by the fake) → tools/list and tools/call
//   with the bearer token → a 401 refreshes once and retries → refresh grant.
// Plus the tool group / tier mapping (default: Connected apps, always asks).
// Run: npx tsx --test lib/connectors/m21/__tests__/mcp-oauth.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import {
  finishMcpAuthorization,
  isUnauthorized,
  parseMcpState,
  refreshMcpPayload,
  startMcpAuthorization,
  type McpCredentialPayload,
} from "../mcp-oauth";
import { McpBackedAdapter, type McpAuthSource } from "../index";
import { McpConnectorClient } from "../mcp";
import {
  DEFAULT_MCP_ACTION,
  DEFAULT_MCP_GROUP,
  mcpToolAction,
  mcpToolGroup,
  mcpToolPolicies,
  validateToolPolicies,
} from "../mcp-policy";

// ---------------------------------------------------------------------------
// FAKE authorization server + protected MCP server (tests only)
// ---------------------------------------------------------------------------

let server: Server;
let base = "";
const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string | null }>();
const validTokens = new Set<string>();
const refreshTokens = new Set<string>();
const seen: { registration?: Record<string, unknown>; tokenRequests: Array<Record<string, string>>; mcpAuth: string[] } = { tokenRequests: [], mcpAuth: [] };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function issueTokens() {
  const access = `at_${randomBytes(8).toString("hex")}`;
  const refresh = `rt_${randomBytes(8).toString("hex")}`;
  validTokens.add(access);
  refreshTokens.add(refresh);
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", base);
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
    return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools.read", "tools.call"] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  if (url.pathname === "/register" && req.method === "POST") {
    seen.registration = JSON.parse(await readBody(req));
    return json(res, 201, { ...seen.registration, client_id: "dyn-client-1", client_id_issued_at: 1 });
  }
  if (url.pathname === "/authorize") {
    // The "user" consents immediately: redirect back with a code.
    const code = `code_${randomBytes(6).toString("hex")}`;
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      resource: url.searchParams.get("resource"),
    });
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    seen.tokenRequests.push(form);
    if (form.grant_type === "authorization_code") {
      const c = codes.get(form.code);
      codes.delete(form.code);
      const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      if (!c || c.challenge !== challenge || c.clientId !== form.client_id || c.redirectUri !== form.redirect_uri) {
        return json(res, 400, { error: "invalid_grant" });
      }
      return json(res, 200, issueTokens());
    }
    if (form.grant_type === "refresh_token" && refreshTokens.has(form.refresh_token)) {
      refreshTokens.delete(form.refresh_token);
      return json(res, 200, issueTokens());
    }
    return json(res, 400, { error: "invalid_grant" });
  }
  if (url.pathname === "/mcp") {
    const auth = req.headers.authorization ?? "";
    seen.mcpAuth.push(auth);
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!validTokens.has(token)) {
      return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    }
    const mcp = new McpServer({ name: "fake-protected", version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
    mcp.registerTool("lookup", { description: "Read a record", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, async ({ id }) => ({ content: [{ type: "text", text: `record ${id}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await mcp.connect(transport);
    const raw = await readBody(req);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    return;
  }
  json(res, 404, { error: "not_found" });
}

before(async () => {
  server = createServer((req, res) => void handle(req, res).catch((e) => json(res, 500, { error: String(e) })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const plainFetch = (u: string | URL, init?: RequestInit) => fetch(u, init);
const REDIRECT = "https://app.example.com/api/connectors/mcp/oauth/callback";

describe("MCP OAuth 2.1 against a local fake authorization server", () => {
  let payload: McpCredentialPayload;

  it("an unauthenticated handshake fails with a recognisable 401", async () => {
    const client = new McpConnectorClient();
    await assert.rejects(client.connect(`${base}/mcp`), (e: unknown) => isUnauthorized(e));
    await client.close();
  });

  it("discovers, registers dynamically, and builds a PKCE + resource authorize URL with a signed state", async () => {
    const started = await startMcpAuthorization({
      endpoint: `${base}/mcp`,
      connectorId: "conn_1",
      connectorKey: "fake-protected",
      workspaceId: "ws_1",
      userId: "u_1",
      redirectUri: REDIRECT,
      existing: null,
      fetchFn: plainFetch,
    });
    assert.equal(started.oauth.clientId, "dyn-client-1");
    assert.equal(started.oauth.clientSource, "dcr");
    assert.equal(started.oauth.resource, `${base}/mcp`);
    assert.deepEqual(seen.registration?.redirect_uris, [REDIRECT]);
    assert.equal(seen.registration?.token_endpoint_auth_method, "none");
    const u = new URL(started.url);
    assert.equal(u.origin + u.pathname, `${base}/authorize`);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("resource"), `${base}/mcp`);
    assert.equal(u.searchParams.get("client_id"), "dyn-client-1");
    const state = parseMcpState(u.searchParams.get("state")!);
    assert.equal(state.connectorId, "conn_1");
    assert.equal(state.workspaceId, "ws_1");
    assert.ok(state.codeVerifier.length >= 43);
    assert.throws(() => parseMcpState(u.searchParams.get("state")!.slice(0, -4) + "AAAA"));

    // The "browser" follows the authorize URL; the fake redirects back with a code.
    const consent = await fetch(started.url, { redirect: "manual" });
    const back = new URL(consent.headers.get("location")!);
    assert.equal(back.origin + back.pathname, REDIRECT);
    const st = parseMcpState(back.searchParams.get("state")!);
    const done = await finishMcpAuthorization({ oauth: started.oauth, code: back.searchParams.get("code")!, codeVerifier: st.codeVerifier, redirectUri: st.redirectUri, fetchFn: plainFetch });
    payload = done.payload;
    assert.equal(done.expiresIn, 3600);
    assert.match(payload.access_token, /^at_/);
    assert.equal(payload.mcp_oauth.tokenEndpoint, `${base}/token`);
    assert.equal(payload.mcp_oauth.clientId, "dyn-client-1");
    const req = seen.tokenRequests.at(-1)!;
    assert.equal(req.grant_type, "authorization_code");
    assert.equal(req.resource, `${base}/mcp`);
  });

  it("a wrong PKCE verifier is rejected by the authorization server", async () => {
    const started = await startMcpAuthorization({
      endpoint: `${base}/mcp`, connectorId: "c", connectorKey: "k", workspaceId: "w", userId: "u", redirectUri: REDIRECT,
      existing: { required: true, authorizationServerUrl: base, clientId: "dyn-client-1", clientSource: "dcr" }, fetchFn: plainFetch,
    });
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    await assert.rejects(finishMcpAuthorization({ oauth: started.oauth, code: back.searchParams.get("code")!, codeVerifier: "x".repeat(50), redirectUri: REDIRECT, fetchFn: plainFetch }));
  });

  it("lists and calls tools with the bearer token; a 401 refreshes once and retries", async () => {
    let current = payload.access_token;
    let refreshes = 0;
    const auth: McpAuthSource = {
      connectionId: "conn-test",
      token: async () => current,
      refresh: async () => {
        refreshes += 1;
        const next = await refreshMcpPayload({ ...payload, access_token: current }, plainFetch);
        payload = next.payload;
        current = next.payload.access_token;
        return current;
      },
    };
    const adapter = new McpBackedAdapter("fake-protected", "Fake", `${base}/mcp`, [], auth);
    const tools = await adapter.listToolsAsync();
    assert.deepEqual(tools.map((t) => [t.name, t.mutating]).sort(), [["echo", true], ["lookup", false]]);
    assert.ok(seen.mcpAuth.includes(`Bearer ${current}`));

    validTokens.delete(current); // the server expires the token
    const r = await adapter.invoke("echo", { text: "hi" }, { kind: "oauth2", payload: { access_token: current } }, { workspaceId: "w", userId: "u" });
    assert.equal(r.ok, true, r.error);
    assert.equal(refreshes, 1);
    assert.match(JSON.stringify(r.data), /echo:hi/);
    assert.equal(seen.tokenRequests.at(-1)?.grant_type, "refresh_token");
  });

  it("a connection without a token says to sign in (never calls unauthenticated)", async () => {
    const adapter = new McpBackedAdapter("fake-protected", "Fake", `${base}/mcp`, [], { connectionId: "none", token: async () => null });
    const r = await adapter.invoke("echo", { text: "x" }, null, { workspaceId: "w", userId: "u" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /needs you to sign in/);
  });
});

describe("MCP tool → group + tier mapping", () => {
  it("defaults: Connected apps, connector_write (Tier 2, always asks); malformed entries fail closed", () => {
    assert.equal(mcpToolGroup(null, "anything"), DEFAULT_MCP_GROUP);
    assert.equal(mcpToolAction({}, "anything"), DEFAULT_MCP_ACTION);
    const cfg = { toolPolicies: { send: { group: "email", action: "send_outreach_email" }, bad: { group: "workspace", action: "buy_media_now" }, "x y": { group: "email" } } };
    assert.equal(mcpToolGroup(cfg, "send"), "email");
    assert.equal(mcpToolAction(cfg, "send"), "send_outreach_email");
    assert.equal(mcpToolGroup(cfg, "bad"), DEFAULT_MCP_GROUP, "the always-on workspace group can't be assigned");
    assert.equal(mcpToolAction(cfg, "bad"), DEFAULT_MCP_ACTION);
    assert.equal(Object.keys(mcpToolPolicies(cfg)).includes("x y"), false);
  });

  it("the admin PATCH body is validated strictly", () => {
    assert.deepEqual(validateToolPolicies({ post: { group: "social", action: "post_owned_social" } }), { ok: true, policies: { post: { group: "social", action: "post_owned_social" } } });
    assert.equal(validateToolPolicies({ post: { group: "delegate", action: "post_owned_social" } }).ok, false);
    assert.equal(validateToolPolicies({ post: { group: "social", action: "anything" } }).ok, false);
    assert.equal(validateToolPolicies([]).ok, false);
  });
});
