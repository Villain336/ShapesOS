// Marketr — Phase 15 slice 2 verification: pattern-based tier derivation +
// universal conservative floor for unclassified tools.
//
// Battery (fixture-based; gate section is DB-backed against the local
// durable DB, same pattern as scripts/verify-phase14-gate.mts):
//   1. derivation across the 8 fixture toolkits: destructive/write/read
//      verb stems classify at high confidence
//   2. ambiguous slugs (FOO_BAR_BAZ, X1_SYNC_NOW) -> unclassified / high /
//      NOT auto-executable (the conservative floor, locked)
//   3. description-text fallback rescues an ambiguous slug (low confidence)
//   4. per-app override table: escalates (stripe refund = high) but a
//      downgrade override is clamped at the floor
//   5. gate path: unclassified tool proposed -> lands in the approval queue
//      (pending, high, not auto); executeApproved refuses without the
//      gate's existing second-confirmation (destructiveConfirm); with it,
//      executes (mock http). Pending/denied can never execute.
//   6. regression: all 36 v1 catalog tools classify EXACTLY as expectedTier.
//
// Run: npx tsx scripts/verify-phase15-derivation.mts
// Requires: DATABASE_URL (local durable Postgres) for section 5.

import "dotenv/config";
import { deriveTier, PER_APP_TIER_OVERRIDES } from "../lib/integrations/actions/derive";
import { classifyAction, V1_ACTION_CATALOG, type RiskTier } from "../lib/integrations/actions/risk";
import { fixtureToolRouter } from "../lib/integrations/actions/discovery";
import {
  proposeAction,
  decideApproval,
  executeApproved,
  listApprovals,
} from "../lib/integrations/actions/gate";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import { prisma } from "../lib/prisma";
import type { ComposioHttp } from "../lib/integrations/composio";

const WS = "00000000-0000-0000-0000-000000000015";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
}

const mockHttp: ComposioHttp = {
  async request<T>(path: string): Promise<T> {
    if (path.startsWith("/tools/execute/")) {
      return { successful: true, data: { ok: true }, error: null } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

// Expected tiers for the 3 non-v1 fixture toolkits (v1 toolkits are covered
// by the v1 regression in section 6, pinning expectedTier verbatim).
const FIXTURE_EXPECTED: Record<string, RiskTier> = {
  SALESFORCE_CREATE_LEAD: "medium",
  SALESFORCE_UPDATE_LEAD: "medium",
  SALESFORCE_GET_LEAD: "low",
  SALESFORCE_LIST_LEADS: "low",
  SALESFORCE_DELETE_LEAD: "high",
  SALESFORCE_CREATE_OPPORTUNITY: "medium",
  SALESFORCE_UPDATE_OPPORTUNITY: "medium",
  SALESFORCE_GET_OPPORTUNITY: "low",
  SALESFORCE_SEARCH_RECORDS: "low",
  SALESFORCE_CREATE_TASK: "medium",
  ZENDESK_CREATE_TICKET: "medium",
  ZENDESK_UPDATE_TICKET: "medium",
  ZENDESK_GET_TICKET: "low",
  ZENDESK_LIST_TICKETS: "low",
  ZENDESK_SEARCH_TICKETS: "low",
  ZENDESK_ADD_TICKET_COMMENT: "medium",
  ZENDESK_DELETE_TICKET: "high",
  ZENDESK_LIST_USERS: "low",
  STRIPE_CREATE_CUSTOMER: "medium",
  STRIPE_GET_CUSTOMER: "low",
  STRIPE_LIST_CUSTOMERS: "low",
  STRIPE_CREATE_INVOICE: "medium",
  STRIPE_SEND_INVOICE: "medium",
  STRIPE_CREATE_PAYMENT_INTENT: "medium",
  STRIPE_LIST_PAYMENT_INTENTS: "low",
  STRIPE_REFUND_PAYMENT: "high", // per-app table (money out) — floor would also catch it
  STRIPE_CREATE_SUBSCRIPTION: "medium",
  STRIPE_CANCEL_SUBSCRIPTION: "high",
};

async function derivationBattery() {
  console.log("─ derivation battery (fixture toolkits) ─");
  for (const appKey of ["salesforce", "zendesk", "stripe"]) {
    // Fixture toolkitSlugs match appKeys for these three toolkits.
    const tools = await fixtureToolRouter.getToolkitTools(appKey);
    for (const t of tools) {
      const expected = FIXTURE_EXPECTED[t.slug];
      if (!expected) { check(`${t.slug}: has expected tier`, false, "missing from battery"); continue; }
      const d = deriveTier(t.slug, t.description, appKey);
      check(
        `${t.slug} -> ${expected}`,
        d.tier === expected && d.classified === true,
        `got tier=${d.tier} classified=${d.classified}`,
      );
    }
  }
  // Spot-check confidence levels: slug match = high, description = low.
  const c1 = deriveTier("SALESFORCE_DELETE_LEAD");
  check("destructive slug -> high confidence", c1.confidence === "high" && c1.classified);
  const c2 = deriveTier("NOTION_LIST_PAGES");
  check("read slug -> high confidence", c2.confidence === "high" && c2.classified);
}

async function floorBattery() {
  console.log("─ conservative floor (unclassified) ─");
  for (const slug of ["FOO_BAR_BAZ", "X1_SYNC_NOW", "ZZZ_QQQ_9"]) {
    const d = deriveTier(slug);
    check(
      `${slug} -> unclassified/high`,
      d.tier === "high" && d.classified === false && d.confidence === "low",
      JSON.stringify(d),
    );
    const c = classifyAction(slug);
    check(`${slug} -> not auto-executable`, c.autoExecutable === false && c.tier === "high");
  }
  // Unclassified + override escalation still lands high, never auto.
  const c2 = classifyAction("FOO_BAR_BAZ", { FOO_BAR_BAZ: "high" });
  check("unclassified + high override: still high, not auto", c2.tier === "high" && c2.autoExecutable === false && c2.classified === false);
}

async function descriptionFallbackBattery() {
  console.log("─ description fallback ─");
  const d1 = deriveTier("FOO_BAR_BAZ", "Delete the selected records permanently.");
  check(
    "ambiguous slug + destructive description -> high/classified",
    d1.tier === "high" && d1.classified === true && d1.confidence === "low",
    JSON.stringify(d1),
  );
  const d2 = deriveTier("X1_SYNC_NOW", "List all connected devices.");
  check(
    "ambiguous slug + read description -> low/classified",
    d2.tier === "low" && d2.classified === true && d2.confidence === "low",
    JSON.stringify(d2),
  );
  const d3 = deriveTier("QQ_NOP", "Create a new workspace record.");
  check(
    "ambiguous slug + write description -> medium/classified",
    d3.tier === "medium" && d3.classified === true,
    JSON.stringify(d3),
  );
  const d4 = deriveTier("QQ_NOP", "Does something unspecified.");
  check(
    "ambiguous slug + neutral description -> still floored",
    d4.tier === "high" && d4.classified === false,
    JSON.stringify(d4),
  );
  // classifyAction threads the description through.
  const c = classifyAction("QQ_NOP", null, { description: "Create a new workspace record." });
  check("classifyAction honors description fallback", c.tier === "medium" && c.classified === true);
}

async function perAppOverrideBattery() {
  console.log("─ per-app override table ─");
  check("stripe table has refund entry", PER_APP_TIER_OVERRIDES.stripe?.STRIPE_REFUND_PAYMENT === "high");
  const d = deriveTier("STRIPE_REFUND_PAYMENT", "Refund a Stripe payment.", "stripe");
  check(
    "per-app table: refund -> high/high-confidence/classified",
    d.tier === "high" && d.confidence === "high" && d.classified === true,
    JSON.stringify(d),
  );
  // Same slug WITHOUT appKey: neither slug nor description matches a verb
  // stem, so the universal floor catches it (still high — never lower).
  const dNoApp = deriveTier("STRIPE_REFUND_PAYMENT", "Refund a Stripe payment.");
  check(
    "refund without appKey -> floor high, unclassified",
    dNoApp.tier === "high" && dNoApp.classified === false,
    JSON.stringify(dNoApp),
  );
  // Overrides may escalate the table tier but never downgrade it.
  const down = classifyAction("STRIPE_REFUND_PAYMENT", { STRIPE_REFUND_PAYMENT: "medium" }, { appKey: "stripe" });
  check(
    "override downgrade of per-app high stays high (clamped)",
    down.tier === "high" && down.clamped === true,
    `tier=${down.tier} clamped=${down.clamped}`,
  );
  const up = classifyAction("STRIPE_LIST_CUSTOMERS", { STRIPE_LIST_CUSTOMERS: "high" });
  check(
    "override escalation low->high allowed, revokes auto",
    up.tier === "high" && up.autoExecutable === false && up.overridden === true,
  );
}

async function v1Regression() {
  console.log("─ v1 regression (36 tools) ─");
  let matched = 0;
  for (const t of V1_ACTION_CATALOG) {
    const c = classifyAction(t.slug, null, { appKey: t.appKey });
    const ok = c.tier === t.expectedTier && c.classified === true;
    if (ok) matched++;
    else check(`v1 ${t.slug} -> ${t.expectedTier}`, false, `got ${c.tier}/classified=${c.classified}`);
  }
  check(`v1: ${matched}/${V1_ACTION_CATALOG.length} exact`, matched === V1_ACTION_CATALOG.length);
  // Draft-creator auto-executability preserved for the two pinned drafts.
  const draft1 = classifyAction("GMAIL_CREATE_DRAFT");
  check("v1: GMAIL_CREATE_DRAFT auto", draft1.autoExecutable === true && draft1.draftCreator === true);
  const draft2 = classifyAction("NOTION_CREATE_PAGE");
  check("v1: NOTION_CREATE_PAGE auto", draft2.autoExecutable === true && draft2.draftCreator === true);
}

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "15 derivation battery", ownerUserId: "15-battery-owner" },
  });
}

async function cleanup() {
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.deleteMany({ where: { workspaceId: WS } }),
  );
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.deleteMany({ where: { workspaceId: WS } }),
  );
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

async function gateBattery() {
  console.log("─ gate path (unclassified tool) ─");
  await ensureWorkspace();

  // Unclassified tool proposed through the gate -> lands in the approval
  // queue as HIGH-GATED (approval + second confirmation), never auto.
  const p = await proposeAction({
    workspaceId: WS, appKey: "stripe", toolName: "FOO_BAR_BAZ",
    args: { what: "mystery" }, proposedBy: "user-1",
  });
  check("gate: proposed approval pending", p.approval.status === "pending");
  check("gate: riskTier high (unclassified floor)", p.approval.riskTier === "high", p.approval.riskTier);
  check("gate: not auto-executable", p.classified.autoExecutable === false);
  check("gate: classified=false surfaced", p.classified.classified === false);
  const pending = await listApprovals(WS, { status: "pending" });
  check("gate: unclassified lands in approval queue", pending.some((a) => a.id === p.approval.id));

  // Pending approval can never execute (fail closed).
  let pendingThrew = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p.approval.id, executedBy: "user-1", http: mockHttp, destructiveConfirm: true });
  } catch (e) { pendingThrew = /pending/.test((e as Error).message); }
  check("gate: pending approval cannot execute", pendingThrew);

  const dec = await decideApproval({
    workspaceId: WS, approvalId: p.approval.id, decision: "approved", decidedBy: "user-1",
  });
  check("gate: approved", dec.status === "approved");

  // Seed a fixture connection so execute can proceed with mock http.
  await withWorkspaceScope(WS, (tx) =>
    tx.composioConnection.create({
      data: { workspaceId: WS, appKey: "stripe", composioEntityId: "ent-fixture", status: "connected" },
    }),
  );

  // The gate's EXISTING second-confirmation path (high-tier
  // destructiveConfirm) refuses execution without it — no new bypass.
  let noConfirmThrew = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p.approval.id, executedBy: "user-1", http: mockHttp });
  } catch (e) { noConfirmThrew = /second confirmation/.test((e as Error).message); }
  check("gate: unclassified high refuses without second confirmation", noConfirmThrew);

  const ex = await executeApproved({
    workspaceId: WS, approvalId: p.approval.id, executedBy: "user-1",
    http: mockHttp, destructiveConfirm: true,
  });
  check("gate: approved + second-confirmed executes", ex.ok === true);

  // Replay lock still holds.
  let replayThrew = false;
  try {
    await executeApproved({
      workspaceId: WS, approvalId: p.approval.id, executedBy: "user-1",
      http: mockHttp, destructiveConfirm: true,
    });
  } catch { replayThrew = true; }
  check("gate: replay blocked after execution", replayThrew);

  await cleanup();
}

async function main() {
  console.log("Phase 15 derivation battery…");
  await derivationBattery();
  await floorBattery();
  await descriptionFallbackBattery();
  await perAppOverrideBattery();
  await v1Regression();
  await gateBattery();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(2);
});
