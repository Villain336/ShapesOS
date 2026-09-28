// Marketr — Phase 14 slice 10 verification: Composio tool-call metering,
// billing/usage, and cost warnings.
//
// Battery (DB-backed against the local durable DB):
//   credit table: composio_tool_call is metered, 1 credit, cost-plus
//   logAction(success) -> ledger charged 1 credit with idempotency key
//     composio-log:<logId>; logAction(denied) -> NOT metered
//   getComposioUsage: counts only success+failed, byApp/byStatus, credits
//   checkComposioBudget: shape { calls, allowance:1000, pct, warn, over }
//   composio_budget_warning trigger registered
//   monthStartUtc: first of month UTC
//   usage API route + ComposioUsageCard mounted in UsageDashboard (static)
//
// Run: npx tsx scripts/verify-phase14-composio-metering.mts
// Requires: DATABASE_URL (local durable Postgres).

import { readFileSync } from "node:fs";
import { creditsFor, isMeteredAction } from "../lib/metering/credits";
import {
  checkComposioBudget,
  getComposioBudgetWarning,
  getComposioUsage,
  getPlatformComposioCalls,
  monthStartUtc,
  periodKeyUtc,
  COMPOSIO_HOSTED_MONTHLY_FREE_CALLS,
  BUDGET_WARN_RATIO,
} from "../lib/integrations/actions/budget";
import { logAction } from "../lib/integrations/actions/gate";
import { triggerDef } from "../lib/alerts/triggers";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import { prisma } from "../lib/prisma";

const WS = `00000000-0000-0000-0000-${Date.now().toString().slice(-12).padStart(12, "0")}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    // starter plan: 2,500 included credits so the hard cap doesn't block the
    // 1-credit composio_tool_call charge (self_hosted has a zero pool).
    data: { id: WS, name: "14 metering battery", ownerUserId: "14-battery-owner", plan: "starter" },
  });
}

async function cleanup() {
  // usage_events is append-only by DB trigger (T5), and deleting the workspace
  // cascades into it — so the per-run workspace id is left in place (isolated
  // test rows) and only the scoped tables are cleaned.
  await withWorkspaceScope(WS, (tx) => tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }));
  await prisma.creditBalance.deleteMany({ where: { workspaceId: WS } });
}

async function main() {
  // ---- credit table -----------------------------------------------------
  check("composio_tool_call is metered", isMeteredAction("composio_tool_call"));
  check("composio_tool_call costs 1 credit", creditsFor("composio_tool_call") === 1);

  // ---- constants ----------------------------------------------------------
  check("free-tier allowance is 20000", COMPOSIO_HOSTED_MONTHLY_FREE_CALLS === 20000);
  check("warn ratio is 0.8", BUDGET_WARN_RATIO === 0.8);
  const ms = monthStartUtc(new Date(Date.UTC(2026, 8, 15, 12, 0, 0)));
  check(
    "monthStartUtc -> first of month UTC",
    ms.toISOString() === "2026-09-01T00:00:00.000Z",
    ms.toISOString(),
  );

  // ---- alert trigger --------------------------------------------------------
  check("composio_budget_warning trigger registered", triggerDef("composio_budget_warning")?.key === "composio_budget_warning");

  // ---- DB-backed metering ---------------------------------------------------
  await ensureWorkspace();

  const platformBefore = await getPlatformComposioCalls();
  const before = await prisma.usageEvent.count({ where: { workspaceId: WS } });

  const okLog = await logAction({
    workspaceId: WS,
    appKey: "gmail",
    toolName: "GMAIL_SEND",
    riskTier: "medium",
    status: "success",
    executedBy: "14-user",
  });
  const events = await prisma.usageEvent.findMany({ where: { workspaceId: WS } });
  check("success log meters exactly one ledger event", events.length === before + 1, String(events.length));
  const ev = events.find((e) => e.idempotencyKey === `composio-log:${okLog.id}`);
  check("idempotency key is composio-log:<logId>", !!ev, events.map((e) => e.idempotencyKey).join(","));
  check("metered action is composio_tool_call at 1 credit", !!ev && ev.action === "composio_tool_call" && ev.credits === 1);

  await logAction({
    workspaceId: WS,
    appKey: "gmail",
    toolName: "GMAIL_READ",
    riskTier: "low",
    status: "denied",
    executedBy: "14-user",
  });
  const afterDenied = await prisma.usageEvent.count({ where: { workspaceId: WS } });
  check("denied log is NOT metered", afterDenied === before + 1, String(afterDenied));

  await logAction({
    workspaceId: WS,
    appKey: "slack",
    toolName: "SLACK_POST",
    riskTier: "medium",
    status: "failed",
    executedBy: "agent:chief",
  });

  const usage = await getComposioUsage(WS);
  check("usage counts success+failed only (2)", usage.calls === 2, String(usage.calls));
  check("usage byApp", usage.byApp.gmail === 1 && usage.byApp.slack === 1, JSON.stringify(usage.byApp));
  check("usage byStatus", usage.byStatus.success === 1 && usage.byStatus.failed === 1, JSON.stringify(usage.byStatus));
  check("usage credits = calls x 1", usage.credits === 2, String(usage.credits));

  const budget = await checkComposioBudget();
  check("budget allowance 20000", budget.allowance === 20000);
  check("budget shape", budget.calls >= 2 && typeof budget.pct === "number" && typeof budget.warn === "boolean" && typeof budget.over === "boolean");
  check(
    "platform counter tracks the 2 executed calls",
    budget.calls === platformBefore + 2,
    `${platformBefore} -> ${budget.calls}`,
  );
  check("periodKeyUtc", periodKeyUtc(new Date(Date.UTC(2026, 8, 15))) === "2026-09");
  check("budget not warn at test volume", budget.warn === false || budget.calls >= 800, String(budget.calls));

  const warning = await getComposioBudgetWarning({ workspaceId: WS, toolName: "GMAIL_SEND" });
  check("no warning below threshold", warning === undefined, String(warning));

  // ---- static: API + UI -----------------------------------------------------
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const api = read("../app/api/integrations/actions/usage/route.ts");
  check("usage API returns usage + budget", api.includes("getComposioUsage") && api.includes("checkComposioBudget"));
  const card = read("../components/settings/ComposioUsageCard.tsx");
  check("usage card fetches the usage API", card.includes("/api/integrations/actions/usage"));
  check("usage card shows free-tier progress + warning", card.includes("Free-tier usage") && card.includes("budget.warn"));
  check("usage card uses dense table for by-app", card.includes("<table") && card.includes("By app"));
  const dash = read("../components/settings/UsageDashboard.tsx");
  check("usage card mounted in Settings -> Usage", dash.includes("ComposioUsageCard"));
  check("composio_tool_call labeled in by-action list", dash.includes('composio_tool_call: "Composio tool calls"'));

  await cleanup();
  console.log(`${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(1);
});
