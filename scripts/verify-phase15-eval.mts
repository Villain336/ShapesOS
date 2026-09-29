// Marketr — Phase 15 slice 6 verification: sampled tier-accuracy eval
// battery + extended "no silent execution" negatives (spec §6).
//
// Battery:
//   1. gold contract: 96 entries, 12 per toolkit × 8 fixture toolkits,
//      valid expectedTier values, required fields present
//   2. eval-results proof: file exists, all 8 toolkits passed, overall ≥
//      target, goldSha fresh vs the committed gold set
//   3. auto-read gate unit checks: a synthetic FAILED toolkit (temp copy
//      of the results JSON via EVAL_RESULTS_PATH — the patch is NEVER
//      committed) escalates its derived-low reads to medium; stale
//      goldSha and missing results fail closed; undefined toolkitSlug
//      keeps legacy unit-call behavior; null escalates
//   4. extended negatives, for EVERY fixture toolkit (8, DB-backed):
//        - propose → execute-without-approval throws fail-closed
//        - unclassified tool execute throws (high floor needs the gate's
//          second confirmation)
//        - disabled-toolkit tool refused at propose time
//      spot-checks (2 toolkits): expired approval cannot execute; replay
//      of an executed action blocked
//
// Run: npx tsx scripts/verify-phase15-eval.mts
// Requires: DATABASE_URL (local durable Postgres) for section 4.

import "dotenv/config";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAction } from "../lib/integrations/actions/risk";
import { isToolkitAutoReadLive } from "../lib/integrations/actions/derive";
import { refreshCatalogForConnection } from "../lib/integrations/actions/discovery";
import { setToolkitEnabled } from "../lib/integrations/actions/toolkits";
import {
  proposeAction,
  decideApproval,
  executeApproved,
} from "../lib/integrations/actions/gate";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";
import { prisma } from "../lib/prisma";
import type { ComposioHttp } from "../lib/integrations/composio";

const WS = "00000000-0000-0000-0000-000000000016";
const here = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = join(here, "eval-data", "phase15-tier-gold.json");
const RESULTS_PATH = join(here, "eval-results", "phase15-tier-accuracy.json");

const TOOLKITS = [
  "gmail",
  "google_sheets",
  "slack",
  "hubspot",
  "notion",
  "salesforce",
  "zendesk",
  "stripe",
] as const;

const TOOLKIT_APPKEY: Record<string, string> = {
  gmail: "gmail",
  google_sheets: "google-sheets",
  slack: "slack",
  hubspot: "hubspot",
  notion: "notion",
  salesforce: "salesforce",
  zendesk: "zendesk",
  stripe: "stripe",
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

const mockHttp: ComposioHttp = {
  async request<T>(path: string): Promise<T> {
    if (path.startsWith("/tools/execute/")) {
      return { successful: true, data: { ok: true }, error: null } as T;
    }
    throw new Error(`unexpected path ${path}`);
  },
};

interface GoldEntry {
  toolkitSlug: string;
  toolSlug: string;
  description: string;
  expectedTier: string;
  note?: string;
}

function loadGold(): GoldEntry[] {
  return JSON.parse(readFileSync(GOLD_PATH, "utf8")) as GoldEntry[];
}

// ---------------------------------------------------------------------------
// 1. gold contract
// ---------------------------------------------------------------------------

function goldContractBattery() {
  console.log("─ gold contract ─");
  const gold = loadGold();
  check("gold has 96 entries", gold.length === 96, `got ${gold.length}`);
  const counts = new Map<string, number>();
  let fieldsOk = true;
  let tiersOk = true;
  for (const e of gold) {
    counts.set(e.toolkitSlug, (counts.get(e.toolkitSlug) ?? 0) + 1);
    if (!e.toolkitSlug || !e.toolSlug || !e.description || !e.expectedTier) fieldsOk = false;
    if (!["low", "medium", "high"].includes(e.expectedTier)) tiersOk = false;
    if (e.note !== undefined && e.note !== "unclassified") fieldsOk = false;
  }
  check("12 entries per toolkit × 8 toolkits", TOOLKITS.every((t) => counts.get(t) === 12), JSON.stringify([...counts]));
  check("required fields present", fieldsOk);
  check("expectedTier values valid", tiersOk);
  const unclassified = gold.filter((e) => e.note === "unclassified");
  check(
    "unclassified entries labeled high (floor contract)",
    unclassified.length > 0 && unclassified.every((e) => e.expectedTier === "high"),
    `got ${unclassified.length}`,
  );
}

// ---------------------------------------------------------------------------
// 2. eval-results proof
// ---------------------------------------------------------------------------

function evalResultsBattery() {
  console.log("─ eval-results proof ─");
  let results: {
    ranAt: string;
    target: number;
    overall: number;
    entryCount: number;
    goldSha: string;
    perToolkit: Record<string, { agreement: number; n: number; passed: boolean }>;
  };
  try {
    results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    check("eval results JSON exists and parses", false);
    return;
  }
  check("eval results JSON exists and parses", true);
  check("ranAt is a valid timestamp", !Number.isNaN(Date.parse(results.ranAt)), results.ranAt);
  check("entryCount is 96", results.entryCount === 96, `got ${results.entryCount}`);
  check(
    `overall ${results.overall}% ≥ target ${results.target}%`,
    results.overall >= results.target,
  );
  const missing = TOOLKITS.filter((t) => !results.perToolkit?.[t]);
  check("all 8 toolkits present", missing.length === 0, `missing: ${missing.join(",")}`);
  const failedTk = TOOLKITS.filter((t) => results.perToolkit?.[t]?.passed !== true);
  check("all 8 toolkits passed", failedTk.length === 0, `failed: ${failedTk.join(",")}`);
  // Freshness: the committed result must match the committed gold set.
  const gold = loadGold();
  const sha = createHash("sha256").update(JSON.stringify(gold)).digest("hex");
  check("goldSha fresh vs committed gold set", results.goldSha === sha);
  // The runtime gate agrees with the committed proof (no env override).
  check(
    "isToolkitAutoReadLive true for all 8 (committed proof)",
    TOOLKITS.every((t) => isToolkitAutoReadLive(t)),
  );
  check("isToolkitAutoReadLive false for unknown toolkit", isToolkitAutoReadLive("nope") === false);
  check("isToolkitAutoReadLive false for null/undefined", isToolkitAutoReadLive(null) === false && isToolkitAutoReadLive(undefined) === false);
}

// ---------------------------------------------------------------------------
// 3. auto-read gate unit checks (synthetic FAILED toolkit via temp copy —
//    the patch is never committed)
// ---------------------------------------------------------------------------

function autoReadGateBattery() {
  console.log("─ auto-read gate (synthetic failed toolkit) ─");
  const tmp = mkdtempSync(join(tmpdir(), "p15-eval-"));
  try {
    const committed = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));

    // Synthetic failure: gmail's eval did not pass.
    const failedCopy = join(tmp, "results-gmail-failed.json");
    const patched = {
      ...committed,
      perToolkit: {
        ...committed.perToolkit,
        gmail: { ...committed.perToolkit.gmail, agreement: 50, passed: false },
      },
    };
    writeFileSync(failedCopy, JSON.stringify(patched));
    process.env.EVAL_RESULTS_PATH = failedCopy;

    check("failed toolkit: not auto-read-live", isToolkitAutoReadLive("gmail") === false);
    const esc = classifyAction("GMAIL_LIST_MESSAGES", null, { toolkitSlug: "gmail" });
    check(
      "failed toolkit: derived low escalates to medium",
      esc.tier === "medium",
      `tier=${esc.tier}`,
    );
    check("failed toolkit: escalated read not auto-executable", esc.autoExecutable === false);
    check(
      "failed toolkit: unaffected toolkit still live",
      classifyAction("SLACK_LIST_CHANNELS", null, { toolkitSlug: "slack" }).tier === "low",
    );
    const w = classifyAction("GMAIL_SEND_EMAIL", null, { toolkitSlug: "gmail" });
    check("failed toolkit: medium write unchanged", w.tier === "medium" && w.autoExecutable === false);
    const h = classifyAction("GMAIL_DELETE_MESSAGE", null, { toolkitSlug: "gmail" });
    check("failed toolkit: high destructive unchanged", h.tier === "high" && h.autoExecutable === false);
    // A manual override cannot sneak below the gate tier.
    const ov = classifyAction("GMAIL_LIST_MESSAGES", { GMAIL_LIST_MESSAGES: "low" }, { toolkitSlug: "gmail" });
    check(
      "failed toolkit: override below gate tier stays clamped at medium",
      ov.tier === "medium" && ov.clamped === true && ov.autoExecutable === false,
      `tier=${ov.tier} clamped=${ov.clamped}`,
    );

    // Stale result: goldSha no longer matches the gold set.
    const staleCopy = join(tmp, "results-stale.json");
    writeFileSync(staleCopy, JSON.stringify({ ...committed, goldSha: "0".repeat(64) }));
    process.env.EVAL_RESULTS_PATH = staleCopy;
    check("stale goldSha: not live (fail-closed)", isToolkitAutoReadLive("gmail") === false);
    check(
      "stale goldSha: read escalates to medium",
      classifyAction("GMAIL_LIST_MESSAGES", null, { toolkitSlug: "gmail" }).tier === "medium",
    );

    // Missing results file → fail-closed.
    process.env.EVAL_RESULTS_PATH = join(tmp, "does-not-exist.json");
    check("missing results: not live (fail-closed)", isToolkitAutoReadLive("gmail") === false);
    check(
      "missing results: read escalates to medium",
      classifyAction("GMAIL_LIST_MESSAGES", null, { toolkitSlug: "gmail" }).tier === "medium",
    );

    // Legacy unit-call behavior: undefined toolkitSlug skips the gate
    // (the gate/agent paths always resolve, so only they enforce it).
    delete process.env.EVAL_RESULTS_PATH;
    check(
      "undefined toolkitSlug: legacy behavior preserved (low stays low)",
      classifyAction("GMAIL_LIST_MESSAGES").tier === "low",
    );
    check(
      "null toolkitSlug: escalates (unknown toolkit never silent)",
      classifyAction("GMAIL_LIST_MESSAGES", null, { toolkitSlug: null }).tier === "medium",
    );
  } finally {
    delete process.env.EVAL_RESULTS_PATH;
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. extended no-silent-execution negatives (DB-backed, every toolkit)
// ---------------------------------------------------------------------------

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({
    data: { id: WS, name: "15 eval battery", ownerUserId: "15-eval-owner" },
  });
  // Seed the discovered catalog (fixture-backed) so tools resolve to their
  // toolkits, and explicitly enable the 3 non-v1 toolkits (the v1 five are
  // enabled by default).
  for (const tk of TOOLKITS) {
    await refreshCatalogForConnection(WS, TOOLKIT_APPKEY[tk]);
  }
  for (const tk of ["salesforce", "zendesk", "stripe"]) {
    await setToolkitEnabled({ workspaceId: WS, toolkitSlug: tk, enabled: true, userId: "15-eval-owner" });
  }
}

async function cleanup() {
  const del = (model: "composioActionLog" | "composioActionApproval" | "composioConnection" | "composioToolCatalog" | "workspaceToolkit") =>
    withWorkspaceScope(WS, (tx) => (tx[model] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { workspaceId: WS } }));
  await del("composioActionLog");
  await del("composioActionApproval");
  await del("composioConnection");
  await del("composioToolCatalog");
  await del("workspaceToolkit");
  await prisma.workspace.deleteMany({ where: { id: WS } });
}

async function negativesBattery() {
  console.log("─ no-silent-execution negatives (all 8 toolkits) ─");
  await ensureWorkspace();
  const gold = loadGold();
  const lowToolFor = (tk: string) =>
    gold.find((e) => e.toolkitSlug === tk && e.expectedTier === "low")!.toolSlug;

  for (const tk of TOOLKITS) {
    const appKey = TOOLKIT_APPKEY[tk];
    const lowTool = lowToolFor(tk);

    // (a) propose → execute without approval throws fail-closed.
    const p = await proposeAction({
      workspaceId: WS, appKey, toolName: lowTool,
      args: { probe: true }, proposedBy: "user-1",
    });
    let threw = "";
    try {
      await executeApproved({ workspaceId: WS, approvalId: p.approval.id, executedBy: "user-1", http: mockHttp });
    } catch (e) {
      threw = (e as Error).message;
    }
    check(`[${tk}] execute-without-approval throws`, /pending/.test(threw), threw.slice(0, 80));

    // (b) disabled toolkit: tool refused at propose time.
    await setToolkitEnabled({ workspaceId: WS, toolkitSlug: tk, enabled: false, userId: "user-1" });
    let refused = "";
    try {
      await proposeAction({ workspaceId: WS, appKey, toolName: lowTool, args: {}, proposedBy: "user-1" });
    } catch (e) {
      refused = (e as Error).message;
    }
    check(`[${tk}] disabled-toolkit tool refused`, /not enabled/.test(refused), refused.slice(0, 80));
    await setToolkitEnabled({ workspaceId: WS, toolkitSlug: tk, enabled: true, userId: "user-1" });

    // (c) unclassified tool: propose → approve → execute throws (the high
    // floor requires the gate's second confirmation; without it, no run).
    const probe = `${tk.toUpperCase().replace(/[^A-Z]/g, "_")}_PROBE_XQZ`;
    const up = await proposeAction({
      workspaceId: WS, appKey, toolName: probe,
      args: { probe: true }, proposedBy: "user-1",
    });
    check(`[${tk}] unclassified lands high-gated`, up.approval.riskTier === "high" && up.classified.autoExecutable === false);
    await decideApproval({ workspaceId: WS, approvalId: up.approval.id, decision: "approved", decidedBy: "user-1" });
    let unclassThrew = "";
    try {
      await executeApproved({ workspaceId: WS, approvalId: up.approval.id, executedBy: "user-1", http: mockHttp });
    } catch (e) {
      unclassThrew = (e as Error).message;
    }
    check(`[${tk}] unclassified execute throws without 2nd confirmation`, /second confirmation/.test(unclassThrew), unclassThrew.slice(0, 80));
  }

  // Spot-checks: expired approval + replay lock (gmail + stripe).
  for (const tk of ["gmail", "stripe"] as const) {
    const appKey = TOOLKIT_APPKEY[tk];
    const lowTool = lowToolFor(tk);

    // Expired APPROVAL (approved, then sat past its TTL): execute refuses.
    const exp = await proposeAction({
      workspaceId: WS, appKey, toolName: lowTool, args: {}, proposedBy: "user-1",
    });
    await decideApproval({ workspaceId: WS, approvalId: exp.approval.id, decision: "approved", decidedBy: "user-1" });
    await withWorkspaceScope(WS, (tx) =>
      tx.composioActionApproval.update({
        where: { id: exp.approval.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    let expiredThrew = "";
    try {
      await executeApproved({ workspaceId: WS, approvalId: exp.approval.id, executedBy: "user-1", http: mockHttp });
    } catch (e) {
      expiredThrew = (e as Error).message;
    }
    check(`[${tk}] expired approval cannot execute`, /expired/.test(expiredThrew), expiredThrew.slice(0, 80));

    await withWorkspaceScope(WS, (tx) =>
      tx.composioConnection.create({
        data: { workspaceId: WS, appKey, composioEntityId: `ent-${tk}`, status: "connected" },
      }),
    );
    const rp = await proposeAction({
      workspaceId: WS, appKey, toolName: lowTool, args: {}, proposedBy: "user-1",
    });
    await decideApproval({ workspaceId: WS, approvalId: rp.approval.id, decision: "approved", decidedBy: "user-1" });
    const ex = await executeApproved({ workspaceId: WS, approvalId: rp.approval.id, executedBy: "user-1", http: mockHttp });
    check(`[${tk}] approved low executes`, ex.ok === true);
    let replayThrew = "";
    try {
      await executeApproved({ workspaceId: WS, approvalId: rp.approval.id, executedBy: "user-1", http: mockHttp });
    } catch (e) {
      replayThrew = (e as Error).message;
    }
    check(`[${tk}] replay blocked`, /replay|already claimed|already executed/.test(replayThrew), replayThrew.slice(0, 80));
  }

  await cleanup();
}

async function main() {
  console.log("Phase 15 slice-6 eval battery…");
  goldContractBattery();
  evalResultsBattery();
  autoReadGateBattery();
  await negativesBattery();
  await prisma.$disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("battery crashed:", e);
  process.exit(2);
});
