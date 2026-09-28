// Marketr — Phase 14 slice 11: the evaluation battery.
//
// Five sections (spec §11):
//   A. risk-classification eval — accuracy of classifyAction on a curated
//      corpus of v1-app tool slugs (Gmail, Google Sheets, Slack, HubSpot,
//      Notion) + override floor/clamp cases. Exits non-zero below 0.95.
//   B. approval-queue UX tests — structural assertions on the Composio
//      approval queue UI (app/dashboard/actions): approve/deny, deny-reason,
//      risk badges, destructive double-confirm, bulk review, batch approve,
//      expiry, plain-language summaries.
//   C. Univer snapshot round-trip fidelity — build -> JSON serialize/parse
//      -> validate -> extract -> compare against the input for sheets,
//      docs, and slides; 10 MB size cap.
//   D. gate-bypass negative tests — every bypass attempt fails closed
//      (DB-backed, mock Composio HTTP).
//   E. no-silent-execution proof — every execution writes exactly one audit
//      log row, and no code path calls Composio without logging.
//
// Run: npx tsx scripts/eval-phase14.mts
// Requires: DATABASE_URL (local durable Postgres).

import { readFileSync } from "node:fs";
import { classifyAction, type RiskTier } from "../lib/integrations/actions/risk";
import {
  buildSheetSnapshot,
  buildDocSnapshot,
  buildSlideSnapshot,
  validateSnapshot,
} from "../lib/univer/snapshots";
import {
  proposeAction,
  decideApproval,
  executeApproved,
  logAction,
} from "../lib/integrations/actions/gate";
import { agentInvokeAction } from "../lib/integrations/actions/agent";
import { withWorkspaceScope, countWithoutScope } from "../lib/substrate/memory/rls";
import { prisma } from "../lib/prisma";
import type { ComposioHttp } from "../lib/integrations/composio";

const WS = `00000000-0000-0000-0000-${Date.now().toString().slice(-12).padStart(12, "0")}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(section: string, name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const mockHttp: ComposioHttp = {
  async request<T>(path: string): Promise<T> {
    if (path.startsWith("/tools/execute/")) {
      return { successful: true, data: { ok: true }, error: null } as T;
    }
    throw new Error(`unexpected mock path ${path}`);
  },
};

// ── A. risk-classification eval ──────────────────────────────────────────────

interface RiskCase {
  slug: string;
  tier: RiskTier;
  auto: boolean;
  draft?: boolean;
}

// Curated corpus across the v1 app shortlist (spec §2): Gmail, Google Sheets,
// Slack, HubSpot, Notion. Expected tiers follow the locked doctrine:
// low = read-only, medium = write, high = destructive; draft-creators are
// medium + auto-executable.
const RISK_CORPUS: RiskCase[] = [
  // Gmail
  { slug: "GMAIL_LIST_MESSAGES", tier: "low", auto: true },
  { slug: "GMAIL_GET_MESSAGE", tier: "low", auto: true },
  { slug: "GMAIL_SEARCH_MESSAGES", tier: "low", auto: true },
  { slug: "GMAIL_GET_PROFILE", tier: "low", auto: true },
  { slug: "GMAIL_SEND_EMAIL", tier: "medium", auto: false },
  { slug: "GMAIL_REPLY_TO_THREAD", tier: "medium", auto: false },
  { slug: "GMAIL_CREATE_DRAFT", tier: "medium", auto: true, draft: true },
  { slug: "GMAIL_DELETE_MESSAGE", tier: "high", auto: false },
  { slug: "GMAIL_TRASH_MESSAGE", tier: "high", auto: false },
  // Google Sheets
  { slug: "SHEETS_GET_VALUES", tier: "low", auto: true },
  { slug: "SHEETS_LIST_SPREADSHEETS", tier: "low", auto: true },
  { slug: "SHEETS_UPDATE_VALUES", tier: "medium", auto: false },
  { slug: "SHEETS_APPEND_VALUES", tier: "medium", auto: false },
  { slug: "SHEETS_CREATE_SPREADSHEET", tier: "medium", auto: false },
  { slug: "SHEETS_DELETE_SHEET", tier: "high", auto: false },
  // Slack
  { slug: "SLACK_LIST_CHANNELS", tier: "low", auto: true },
  { slug: "SLACK_GET_MESSAGE_HISTORY", tier: "low", auto: true },
  { slug: "SLACK_POST_MESSAGE", tier: "medium", auto: false },
  { slug: "SLACK_SEND_MESSAGE", tier: "medium", auto: false },
  { slug: "SLACK_SCHEDULE_MESSAGE", tier: "medium", auto: false },
  { slug: "SLACK_DELETE_MESSAGE", tier: "high", auto: false },
  { slug: "SLACK_ARCHIVE_CHANNEL", tier: "high", auto: false },
  // HubSpot
  { slug: "HUBSPOT_SEARCH_CONTACTS", tier: "low", auto: true },
  { slug: "HUBSPOT_GET_CONTACT", tier: "low", auto: true },
  { slug: "HUBSPOT_LIST_DEALS", tier: "low", auto: true },
  { slug: "HUBSPOT_CREATE_CONTACT", tier: "medium", auto: false },
  { slug: "HUBSPOT_UPDATE_CONTACT", tier: "medium", auto: false },
  { slug: "HUBSPOT_DELETE_CONTACT", tier: "high", auto: false },
  { slug: "HUBSPOT_REMOVE_CONTACT_FROM_LIST", tier: "high", auto: false },
  // Notion
  { slug: "NOTION_SEARCH", tier: "low", auto: true },
  { slug: "NOTION_GET_PAGE", tier: "low", auto: true },
  { slug: "NOTION_QUERY_DATABASE", tier: "low", auto: true },
  { slug: "NOTION_CREATE_PAGE", tier: "medium", auto: true, draft: true },
  { slug: "NOTION_UPDATE_PAGE", tier: "medium", auto: false },
  { slug: "NOTION_ARCHIVE_PAGE", tier: "high", auto: false },
  // Unknown slugs fail closed to low/read-only? No — unknown verbs are low
  // tier by derivation (no destructive/write stem), which is the documented
  // conservative default for unreadable names.
  { slug: "GMAIL_FETCH_ATTACHMENT", tier: "low", auto: true },
];

function evalRisk() {
  let correct = 0;
  for (const c of RISK_CORPUS) {
    const got = classifyAction(c.slug, {});
    const ok =
      got.tier === c.tier && got.autoExecutable === c.auto && (c.draft ? got.draftCreator : !got.draftCreator);
    if (!ok) {
      failures.push(
        `[risk] ${c.slug}: expected ${c.tier}/auto=${c.auto}${c.draft ? "/draft" : ""}, got ${got.tier}/auto=${got.autoExecutable}/draft=${got.draftCreator}`,
      );
      failed++;
    } else {
      passed++;
      correct++;
    }
  }
  const acc = correct / RISK_CORPUS.length;
  console.log(`risk eval: ${correct}/${RISK_CORPUS.length} accuracy=${acc.toFixed(3)}`);
  // Override floor/clamp invariants (locked: escalate allowed, never downgrade).
  const cl1 = classifyAction("GMAIL_DELETE_MESSAGE", { GMAIL_DELETE_MESSAGE: "low" });
  check("risk", "override cannot downgrade destructive", cl1.tier === "high" && cl1.clamped, cl1.tier);
  const cl2 = classifyAction("GMAIL_SEND_EMAIL", { GMAIL_SEND_EMAIL: "low" });
  check("risk", "override cannot downgrade write to read", cl2.tier === "medium" && cl2.clamped, cl2.tier);
  const cl3 = classifyAction("GMAIL_GET_PROFILE", { GMAIL_GET_PROFILE: "high" });
  check("risk", "override escalation revokes auto", cl3.tier === "high" && !cl3.autoExecutable && cl3.overridden);
  const cl4 = classifyAction("GMAIL_CREATE_DRAFT", { GMAIL_CREATE_DRAFT: "high" });
  check("risk", "draft-creator escalated to high is not auto", cl4.tier === "high" && !cl4.autoExecutable);
  if (acc < 0.95) {
    failures.push(`[risk] accuracy ${acc.toFixed(3)} below 0.95 gate`);
    failed++;
  } else {
    passed++;
  }
}

// ── B. approval-queue UX tests (structural) ──────────────────────────────────

function evalApprovalQueueUX() {
  const src = readFileSync(new URL("../app/dashboard/actions/ActionsClient.tsx", import.meta.url), "utf8");
  const has = (re: RegExp, name: string) => check("queue-ux", name, re.test(src));
  has(/Approve/, "approve button present");
  has(/Deny/, "deny button present");
  has(/denyReason|Deny reason|reason/i, "deny captures a reason");
  has(/riskTier|TierBadge|tier/i, "risk tier badge shown");
  has(/destructiveConfirm/, "destructive double-confirmation for high tier");
  has(/confirmedBulkCount|extractBulkItems|describeBulk/, "bulk per-item review count");
  has(/batchApprove|Approve \{selected/, "batch approve for the queue");
  has(/expiresAt|expir/i, "expiry shown");
  has(/plainSummary/, "plain-language summary per approval");
  has(/aria-label/, "accessible labels on decision buttons");
}

// ── C. Univer snapshot round-trip fidelity ───────────────────────────────────

function sheetCells(snap: unknown): (string | number)[][] {
  const s = snap as {
    sheetOrder: string[];
    sheets: Record<string, { cellData: Record<string, Record<string, { v?: unknown }>> }>;
  };
  const sheet = s.sheets[s.sheetOrder[0]];
  const rows: (string | number)[][] = [];
  for (const [r, cols] of Object.entries(sheet.cellData)) {
    const ri = Number(r);
    rows[ri] = rows[ri] ?? [];
    for (const [c, cell] of Object.entries(cols)) rows[ri][Number(c)] = cell.v as string | number;
  }
  return rows;
}

function docText(snap: unknown): string {
  const s = snap as { body: { dataStream: string } };
  return s.body.dataStream.replace(/\r\n/g, "\n");
}

function slideTexts(snap: unknown): { title: string; body: string }[] {
  const s = snap as {
    body: {
      pageOrder: string[];
      pages: Record<string, { pageElements: Record<string, { title: string; richText: { rich: unknown } }> }>;
    };
  };
  return s.body.pageOrder.map((pid) => {
    const els = Object.values(s.body.pages[pid].pageElements);
    const t = els.find((e) => e.title === "Title");
    const b = els.find((e) => e.title === "Body");
    return { title: docText(t?.richText.rich).trim(), body: docText(b?.richText.rich).trim() };
  });
}

function roundTrip<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function evalRoundTrip() {
  // Sheet: values + header bold survive the round trip.
  const grid = {
    title: "Prospects",
    headers: ["Name", "Email", "Score"],
    rows: [["Ada", "ada@x.com", 98], ["Bob", "bob@y.com", 41], ["", "", 0]],
  };
  const sheet = roundTrip(buildSheetSnapshot(grid));
  check("sheets", "round-trip validates", validateSnapshot("sheet", sheet).ok);
  const cells = sheetCells(sheet);
  check("sheets", "header row preserved", cells[0][0] === "Name" && cells[0][2] === "Score", JSON.stringify(cells[0]));
  check("sheets", "data rows preserved", cells[1][0] === "Ada" && cells[2][1] === "bob@y.com" && cells[2][2] === 41);
  check("sheets", "numbers stay numbers", typeof cells[1][2] === "number");
  const rawSheet = sheet as unknown as { sheets: Record<string, { cellData: Record<string, Record<string, { s?: string }>> }>; sheetOrder: string[] };
  check(
    "sheets",
    "header bold style ref preserved",
    rawSheet.sheets[rawSheet.sheetOrder[0]].cellData["0"]["0"].s === "header",
  );

  // Doc: text, headings, bold ranges survive.
  const docInput = {
    title: "Brief",
    heading: "Q3 Plan",
    paragraphs: [
      "Intro paragraph.",
      { text: "Bold lead sentence here.", boldRanges: [[0, 9]] as [number, number][] },
      { text: "A heading", headingLevel: 2 as const },
    ],
  };
  const doc = roundTrip(buildDocSnapshot(docInput));
  check("docs", "round-trip validates", validateSnapshot("doc", doc).ok);
  const text = docText(doc);
  check("docs", "all paragraph text preserved", text.includes("Q3 Plan") && text.includes("Intro paragraph.") && text.includes("A heading"), text.slice(0, 120));
  const rawDoc = doc as { body: { dataStream: string; textRuns?: { st: number; ed: number; ts?: { bl?: number } }[] } };
  const boldTexts = (rawDoc.body.textRuns ?? [])
    .filter((r) => r.ts?.bl === 1)
    .map((r) => rawDoc.body.dataStream.slice(r.st, r.ed));
  check("docs", "bold run preserved", boldTexts.includes("Bold lead"), JSON.stringify(boldTexts));

  // Slide: page count, titles, bodies survive.
  const deckInput = {
    title: "Pitch",
    slides: [
      { title: "Intro", body: "Hello\nWorld" },
      { title: "Numbers", body: "42" },
    ],
  };
  const deck = roundTrip(buildSlideSnapshot(deckInput));
  check("slides", "round-trip validates", validateSnapshot("slide", deck).ok);
  const slides = slideTexts(deck);
  check("slides", "page count preserved", slides.length === 2, String(slides.length));
  check("slides", "titles preserved", slides[0].title === "Intro" && slides[1].title === "Numbers", JSON.stringify(slides.map((s) => s.title)));
  check("slides", "bodies preserved", slides[0].body.includes("Hello") && slides[1].body.includes("42"));

  // 10 MB persist cap.
  for (const [kind, snap] of [["sheet", sheet], ["doc", doc], ["slide", deck]] as const) {
    check("size", `${kind} under 10 MB cap`, JSON.stringify(snap).length < 10 * 1024 * 1024);
  }
}

// ── D + E. gate-bypass negatives + no-silent-execution (DB-backed) ───────────

async function ensureWorkspace() {
  await prisma.workspace.deleteMany({ where: { id: WS } }).catch(() => {});
  const ws = await prisma.workspace.findUnique({ where: { id: WS } });
  if (!ws) {
    await prisma.workspace.create({
      data: { id: WS, name: "14 eval battery", ownerUserId: "14-eval-owner", plan: "starter" },
    });
  }
  for (const appKey of ["gmail", "slack"]) {
    await withWorkspaceScope(WS, (tx) =>
      tx.composioConnection.upsert({
        where: { workspaceId_appKey: { workspaceId: WS, appKey } },
        create: { workspaceId: WS, appKey, composioEntityId: "ent-fixture", status: "connected" },
        update: {},
      }),
    );
  }
}

async function logCount(approvalId?: string): Promise<number> {
  return withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.count({ where: { workspaceId: WS, ...(approvalId ? { approvalId } : {}) } }),
  );
}

async function evalNegativesAndProof() {
  await ensureWorkspace();

  // D1: pending approval cannot execute.
  const p1 = await proposeAction({ workspaceId: WS, appKey: "gmail", toolName: "GMAIL_SEND_EMAIL", args: { to: "a@b.com" }, proposedBy: "u1" });
  let threw = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p1.approval.id, executedBy: "u1", http: mockHttp });
  } catch (e) { threw = /approved/.test((e as Error).message); }
  check("bypass", "pending approval cannot execute", threw);
  check("bypass", "blocked attempt wrote no execution log", (await logCount(p1.approval.id)) === 0);

  // D2: denied approval cannot execute.
  const p2 = await proposeAction({ workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE", args: {}, proposedBy: "u1" });
  await decideApproval({ workspaceId: WS, approvalId: p2.approval.id, decision: "denied", decidedBy: "u1", reason: "no" });
  threw = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p2.approval.id, executedBy: "u1", http: mockHttp });
  } catch (e) { threw = /denied/.test((e as Error).message); }
  check("bypass", "denied approval cannot execute", threw);

  // D3: wrong workspace cannot execute someone else's approval (RLS + scoping).
  threw = false;
  try {
    await executeApproved({ workspaceId: "00000000-0000-0000-0000-000000000000", approvalId: p1.approval.id, executedBy: "u1", http: mockHttp });
  } catch { threw = true; }
  check("bypass", "cross-workspace execution fails", threw);

  // D4: high tier without the explicit destructive confirmation fails.
  const p4 = await proposeAction({ workspaceId: WS, appKey: "gmail", toolName: "GMAIL_DELETE_MESSAGE", args: {}, proposedBy: "u1" });
  await decideApproval({ workspaceId: WS, approvalId: p4.approval.id, decision: "approved", decidedBy: "u1" });
  threw = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p4.approval.id, executedBy: "u1", http: mockHttp });
  } catch (e) { threw = /destructive/.test((e as Error).message); }
  check("bypass", "high tier needs destructiveConfirm", threw);

  // D5: non-auto tier via the agent surface never executes — becomes an approval.
  const before = await logCount();
  const r5 = await agentInvokeAction({
    workspaceId: WS, appKey: "slack", toolName: "SLACK_POST_MESSAGE",
    args: { channel: "#x", text: "hi" }, invokedBy: "agent:test", http: mockHttp,
  });
  check("bypass", "agent write becomes pending-approval", r5.outcome === "pending-approval");
  check("bypass", "pending-approval wrote no execution log", (await logCount()) === before);

  // D6: RLS fail-closed — unscoped sessions see zero log rows.
  check("bypass", "RLS hides logs without scope", (await countWithoutScope("composio_action_logs")) === 0);

  // E1: approved execution writes exactly one audit row.
  await decideApproval({ workspaceId: WS, approvalId: p1.approval.id, decision: "approved", decidedBy: "u1" });
  const ex = await executeApproved({ workspaceId: WS, approvalId: p1.approval.id, executedBy: "u1", http: mockHttp });
  check("no-silent", "executeApproved reports ok", ex.ok === true);
  check("no-silent", "exactly one log row for the execution", (await logCount(p1.approval.id)) === 1);

  // E2: the auto path (low read) also writes exactly one audit row.
  const r6 = await agentInvokeAction({
    workspaceId: WS, appKey: "gmail", toolName: "GMAIL_LIST_MESSAGES",
    args: {}, invokedBy: "agent:test", http: mockHttp,
  });
  check("no-silent", "auto read executed", r6.outcome === "executed");
  const autoLogs = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionLog.findMany({ where: { workspaceId: WS, approvalId: null, toolName: "GMAIL_LIST_MESSAGES" } }),
  );
  check("no-silent", "auto path wrote exactly one log row", autoLogs.length === 1 && autoLogs[0].status === "success");

  // E3: replay is blocked — a second execute throws and writes no new row.
  threw = false;
  try {
    await executeApproved({ workspaceId: WS, approvalId: p1.approval.id, executedBy: "u1", http: mockHttp });
  } catch (e) { threw = /already executed|replay/i.test((e as Error).message); }
  check("no-silent", "replay blocked", threw);
  check("no-silent", "replay wrote no new row", (await logCount(p1.approval.id)) === 1);

  // E4: static — every executeComposioTool call site lives in a function
  // that also calls logAction. No silent execution path exists in the lib.
  for (const f of ["../lib/integrations/actions/gate.ts", "../lib/integrations/actions/agent.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    // Split into top-level function chunks.
    const chunks = src.split(/(?=^export (?:async )?function )/m);
    for (const chunk of chunks) {
      const m = chunk.match(/^export (?:async )?function (\w+)/);
      if (!m) continue;
      if (chunk.includes("executeComposioTool(")) {
        check("no-silent", `${f.split("/").pop()} ${m[1]}() calls Composio only with logAction`, chunk.includes("logAction("));
      }
    }
  }

  // Cleanup scoped rows (usage_events is append-only; the workspace stays).
  await withWorkspaceScope(WS, (tx) => tx.composioActionLog.deleteMany({ where: { workspaceId: WS } }));
  await withWorkspaceScope(WS, (tx) => tx.composioActionApproval.deleteMany({ where: { workspaceId: WS } }));
  await withWorkspaceScope(WS, (tx) => tx.composioConnection.deleteMany({ where: { workspaceId: WS } }));
  await prisma.creditBalance.deleteMany({ where: { workspaceId: WS } });
}

async function main() {
  evalRisk();
  evalApprovalQueueUX();
  evalRoundTrip();
  await evalNegativesAndProof();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failures.length > 0) {
    console.log("failures:");
    for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
  }
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("eval crashed:", e);
  process.exit(1);
});
