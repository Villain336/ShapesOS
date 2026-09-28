#!/usr/bin/env tsx
// Marketr — Phase 14 slice 2 fixture tests: Composio substrate.
// No live DB writes outside the battery workspaces, no network, no real
// Composio key — the HTTP boundary is injected as a mock.
// Tests:
//   1. Risk-tier classification accuracy on the full v1 action catalog
//      (expected tier + draftCreator + autoExecutable per entry).
//   2. Manual overrides win over derivation; invalid tiers rejected.
//   3. Fail-closed without COMPOSIO_API_KEY.
//   4. HTTP boundary: correct paths/bodies for list/execute/connect-link;
//      auth-config reuse vs create.
//   5. Connection service (DB): confirm upsert, list scoping, revoke,
//      requireConnectedEntity fails closed, cross-workspace isolation.
// Run: npx tsx scripts/verify-phase14-composio.mts

import "dotenv/config";
import { prisma } from "../lib/prisma";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import {
  getComposioApiKey,
  listComposioTools,
  executeComposioTool,
  type ComposioHttp,
} from "../lib/integrations/composio";
import {
  classifyAction,
  deriveTierFromName,
  isDraftCreator,
  V1_ACTION_CATALOG,
} from "../lib/integrations/actions/risk";
import {
  initiateConnect,
  confirmConnection,
  listConnections,
  revokeConnection,
  requireConnectedEntity,
  getToolTierOverrides,
  setToolTierOverrides,
} from "../lib/integrations/actions/connections";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. Classification accuracy on the v1 catalog ─────────────────────────
let catalogOk = 0;
for (const tool of V1_ACTION_CATALOG) {
  const c = classifyAction(tool.slug);
  const tierOk = c.tier === tool.expectedTier;
  const draftOk = c.draftCreator === !!tool.draftCreator;
  const autoOk = c.autoExecutable === (tool.expectedTier === "low" || !!tool.draftCreator);
  if (tierOk && draftOk && autoOk) catalogOk += 1;
  else {
    failed += 1;
    console.error(
      `FAIL: catalog ${tool.slug} — got tier=${c.tier} draft=${c.draftCreator} auto=${c.autoExecutable}, expected tier=${tool.expectedTier} draft=${!!tool.draftCreator}`,
    );
  }
}
passed += catalogOk;
console.log(`catalog classification: ${catalogOk}/${V1_ACTION_CATALOG.length}`);

// Spot-check derivation primitives.
check("derive destructive", deriveTierFromName("SLACK_DELETE_MESSAGE") === "high");
check("derive write", deriveTierFromName("HUBSPOT_CREATE_DEAL") === "medium");
check("derive read", deriveTierFromName("NOTION_SEARCH") === "low");
check("derive reply is write", deriveTierFromName("GMAIL_REPLY_TO_THREAD") === "medium");
check("derive append is write", deriveTierFromName("GOOGLE_SHEETS_APPEND_VALUES") === "medium");
check("draft creator detected", isDraftCreator("GMAIL_CREATE_DRAFT"));
check("send is not draft creator", !isDraftCreator("GMAIL_SEND_EMAIL"));

// ── 2. Overrides win ─────────────────────────────────────────────────────
const ov = classifyAction("GMAIL_SEND_EMAIL", { GMAIL_SEND_EMAIL: "high" });
check("override wins over derivation", ov.tier === "high" && ov.overridden);
check("override high is not auto", !ov.autoExecutable);
const ovLow = classifyAction("SLACK_DELETE_MESSAGE", { SLACK_DELETE_MESSAGE: "low" });
check("override can downgrade", ovLow.tier === "low" && ovLow.autoExecutable);
const ovDraft = classifyAction("GMAIL_CREATE_DRAFT", { GMAIL_CREATE_DRAFT: "high" });
check("draft creator stays auto even when overridden high", ovDraft.autoExecutable);

// ── 3. Fail-closed without API key ────────────────────────────────────────
const savedKey = process.env.COMPOSIO_API_KEY;
delete process.env.COMPOSIO_API_KEY;
let threw = false;
try {
  getComposioApiKey();
} catch (e) {
  threw = (e as Error).name === "ComposioConfigError";
}
check("no key → ComposioConfigError", threw);
process.env.COMPOSIO_API_KEY = savedKey;

// ── 4. HTTP boundary (mock) ───────────────────────────────────────────────
interface Recorded { path: string; method: string; body: unknown }
const recorded: Recorded[] = [];
let authConfigsExist = false;
const mockHttp: ComposioHttp = {
  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    recorded.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path.startsWith("/tools?")) return { items: [{ slug: "GMAIL_LIST_MESSAGES" }] } as T;
    if (path.startsWith("/tools/execute/")) {
      return { successful: true, data: { ok: 1 }, error: null } as T;
    }
    if (path.startsWith("/auth_configs?")) {
      return { items: authConfigsExist ? [{ id: "ac_existing" }] : [] } as T;
    }
    if (path === "/auth_configs") return { auth_config: { id: "ac_new" } } as T;
    if (path === "/connected_accounts/link") {
      return {
        link_token: "lk_mock",
        redirect_url: "https://connect.composio.dev/link/lk_mock",
        expires_at: "2030-01-01T00:00:00Z",
      } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

const tools = await listComposioTools({ toolkitSlug: "gmail" }, mockHttp);
check("list tools hits /tools with toolkit_slug", tools.length === 1 && recorded[0].path.includes("toolkit_slug=gmail"), recorded[0]?.path);
const execRes = await executeComposioTool(
  { slug: "GMAIL_SEND_EMAIL", connectedAccountId: "ca_123", args: { to: "a@b.c" } },
  mockHttp,
);
const execCall = recorded.find((r) => r.path.startsWith("/tools/execute/"));
check("execute posts to /tools/execute/:slug", execCall?.path === "/tools/execute/GMAIL_SEND_EMAIL");
check(
  "execute body carries connected_account_id + arguments",
  (execCall?.body as Record<string, unknown>)?.connected_account_id === "ca_123" &&
    JSON.stringify((execCall?.body as Record<string, unknown>)?.arguments).includes("a@b.c"),
);
check("execute returns envelope", execRes.successful === true);

// initiateConnect with NO existing auth config → creates one, then links.
recorded.length = 0;
authConfigsExist = false;
const link1 = await initiateConnect({ workspaceId: "ws-x", appKey: "gmail", userId: "u1" }, mockHttp);
check("connect returns fresh redirect_url", link1.connectUrl.includes("connect.composio.dev/link/"));
check("connect creates auth config when missing", recorded.some((r) => r.method === "POST" && r.path === "/auth_configs"));
check("connect mints link", recorded.some((r) => r.method === "POST" && r.path === "/connected_accounts/link"));
// With an existing auth config → reuses, no create.
recorded.length = 0;
authConfigsExist = true;
await initiateConnect({ workspaceId: "ws-x", appKey: "slack", userId: "u1" }, mockHttp);
check("connect reuses existing auth config", !recorded.some((r) => r.method === "POST" && r.path === "/auth_configs"));
// Unknown app fails closed before any HTTP.
let unknownThrew = false;
try {
  await initiateConnect({ workspaceId: "ws-x", appKey: "fax-machine", userId: "u1" }, mockHttp);
} catch {
  unknownThrew = true;
}
check("unknown app fails closed", unknownThrew);

// ── 5. Connection service (DB) ────────────────────────────────────────────
const WS_A = "14-conn-a";
const WS_B = "14-conn-b";
for (const id of [WS_A, WS_B]) {
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id, name: `14 conn ${id}`, ownerUserId: "14-conn-owner" } });
}

const confirmed = await confirmConnection({
  workspaceId: WS_A,
  appKey: "gmail",
  connectedAccountId: "ca_battery_a",
  scopes: ["gmail.read"],
});
check("confirm creates connection", confirmed.status === "connected");
const entity = await requireConnectedEntity(WS_A, "gmail");
check("requireConnectedEntity returns entity id", entity === "ca_battery_a");
let missingThrew = false;
try {
  await requireConnectedEntity(WS_A, "slack");
} catch {
  missingThrew = true;
}
check("unconnected app fails closed", missingThrew);

const listA = await listConnections(WS_A);
const listB = await listConnections(WS_B);
check("list scoped to workspace", listA.length === 1 && listB.length === 0);
const revoked = await revokeConnection(WS_A, confirmed.id);
check("revoke flips status", revoked.status === "revoked");
let revokedThrew = false;
try {
  await requireConnectedEntity(WS_A, "gmail");
} catch {
  revokedThrew = true;
}
check("revoked app fails closed", revokedThrew);

// Tier overrides round-trip.
const set = await setToolTierOverrides(WS_A, { GMAIL_SEND_EMAIL: "high" });
check("set overrides stores uppercased", set["GMAIL_SEND_EMAIL"] === "high");
const got = await getToolTierOverrides(WS_A);
check("get overrides round-trips", got["GMAIL_SEND_EMAIL"] === "high");
let invalidThrew = false;
try {
  await setToolTierOverrides(WS_A, { GMAIL_SEND_EMAIL: "nuclear" });
} catch {
  invalidThrew = true;
}
check("invalid tier rejected", invalidThrew);
const gotB = await getToolTierOverrides(WS_B);
check("overrides are per-workspace", Object.keys(gotB).length === 0);

// Cleanup battery state.
for (const id of [WS_A, WS_B]) {
  await prisma.workspace.deleteMany({ where: { id } });
}

console.log(`\n${passed}/${passed + failed} checks passed${failed ? " — FAILURES ABOVE" : ""}`);
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
