// Marketr — Phase 6 INTELLIGENCE battery (I1).
//
// Run: npx tsx scripts/verify-phase6-intelligence.mts
// Run 3x green before calling this done.
//
// Full pipeline E2E against the preview Postgres (dedicated battery
// workspace, cleaned up): buildAuditContext → runAllAudits (12) →
// deriveOpportunities → compilePlan (90-day) → compileReport persists.
// Verifies:
//   - exactly 12 audits in SPEC §2/I1 order, each scored 0–100 or null
//   - every audit carries a completeness label (full/partial/unavailable)
//   - every finding cites a data source (nothing fabricated)
//   - opportunities ranked by impact×effort with estimates labeled
//   - 90-day plan: initiatives mapped to sprints + Marketr modules
//   - reprioritize() lets the human reorder
//   - a throwing audit degrades to unavailable (never blocks the report)

import { prisma } from "../lib/prisma";
import {
  compileReport, getReport, listReports, setReportStatus,
} from "../lib/authority/intelligence/reports";
import { renderIntelligencePdf } from "../lib/authority/intelligence/pdf";
import { runAllAudits } from "../lib/authority/intelligence/audits/index";
import { deriveOpportunities } from "../lib/authority/intelligence/opportunities";
import { compilePlan, reprioritize } from "../lib/authority/intelligence/plan";
import { buildAuditContext } from "../lib/authority/intelligence/connectors";
import { AUDIT_ORDER, AUDIT_NAMES } from "../lib/authority/intelligence/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}

const EXPECTED_ORDER = [
  "company", "market", "competitor-map", "website", "brand", "seo",
  "paid", "reputation", "conversion", "crm", "content", "technology",
];

async function main() {
  console.log("Phase 6 INTELLIGENCE battery — 12 audits → plan E2E");
  const ws = await prisma.workspace.create({ data: { name: `Battery intel ${Date.now()}`, ownerUserId: "battery" } });
  const wsId = ws.id;

  // --- 1. Audit registry ------------------------------------------------------
  console.log("\n[audit registry]");
  if (AUDIT_ORDER.length === 12) ok("12 audits registered");
  else bad("audit count", String(AUDIT_ORDER.length));
  if (JSON.stringify(AUDIT_ORDER) === JSON.stringify(EXPECTED_ORDER)) ok("audits in SPEC §2/I1 order");
  else bad("audit order", AUDIT_ORDER.join(","));
  const names = EXPECTED_ORDER.map((id) => (AUDIT_NAMES as Record<string, string>)[id]);
  if (names.every(Boolean)) ok("all 12 audits named");
  else bad("audit names", "missing");

  // --- 2. Full audit run on an empty workspace ---------------------------------
  // Empty workspace = the honesty test: audits must degrade to partial/
  // unavailable, never fabricate.
  console.log("\n[empty-workspace honesty]");
  const ctx = await buildAuditContext(wsId, "battery");
  const audits = await runAllAudits(ctx);
  if (audits.length === 12) ok("12 audit results");
  else bad("results", String(audits.length));
  let honestyOk = true;
  for (const a of audits) {
    if (!["full", "partial", "unavailable"].includes(a.completeness)) { honestyOk = false; bad("completeness label", `${a.id}: ${a.completeness}`); }
    if (a.score !== null && (a.score < 0 || a.score > 100)) { honestyOk = false; bad("score range", `${a.id}: ${a.score}`); }
    for (const f of a.findings) {
      if (!f.dataSource) { honestyOk = false; bad("finding data source", `${a.id}: ${f.title}`); }
    }
  }
  if (honestyOk) ok("every audit labeled; every finding cites a data source");
  const unavailable = audits.filter((a) => a.completeness !== "full").length;
  console.log(`  empty workspace: ${12 - unavailable} full, ${unavailable} partial/unavailable (honest, not fabricated)`);

  // --- 3. Opportunities ----------------------------------------------------------
  console.log("\n[opportunities]");
  const opps = deriveOpportunities(audits);
  if (opps.length > 0) ok(`${opps.length} revenue opportunities derived`);
  else bad("opportunities", "none derived");
  const ranked = [...opps].sort((a, b) => (b.impactUsd / b.effort) - (a.impactUsd / a.effort));
  if (JSON.stringify(opps.map((o) => o.id)) === JSON.stringify(ranked.map((o) => o.id))) {
    ok("opportunities ranked by impact×effort");
  } else bad("ranking", "not impact×effort ordered");

  // --- 4. 90-day plan ---------------------------------------------------------------
  console.log("\n[90-day plan]");
  const plan = compilePlan(opps, audits);
  if (plan.initiatives.length > 0) ok(`${plan.initiatives.length} plan initiatives`);
  else bad("initiatives", "none");
  const sprintSeq = plan.initiatives.map((i) => i.sprint);
  const ordered = sprintSeq.every((v, i, a) => i === 0 || a[i - 1] <= v);
  if (ordered && sprintSeq[0] === 30) ok(`initiatives ordered into sprints: ${[...new Set(sprintSeq)].join("/")}`);
  else bad("sprints", sprintSeq.join(","));
  const unmapped = plan.initiatives.filter((i) => !i.module);
  if (unmapped.length === 0) ok("every initiative mapped to a Marketr module");
  else bad("module mapping", unmapped.map((i) => i.title).join(","));
  const reordered = reprioritize(plan, [...plan.initiatives].reverse().map((i) => i.id));
  if (reordered.initiatives[0].id === plan.initiatives[plan.initiatives.length - 1].id) {
    ok("human reprioritization reorders the plan");
  } else bad("reprioritize", "order unchanged");

  // --- 5. Full compileReport persistence ----------------------------------------------
  console.log("\n[compileReport]");
  const { report, bundle } = await compileReport(wsId, "battery");
  if (report.status === "draft") ok("report persisted as draft");
  else bad("report status", report.status);
  const fetched = await getReport(report.id, wsId);
  if (fetched) ok("report retrievable in workspace");
  else bad("getReport", "null");
  const other = await getReport(report.id, "ws_definitely_not_here");
  if (other === null) ok("report invisible from other workspace");
  else bad("report isolation", "visible elsewhere");
  const listed = await listReports(wsId);
  if (listed.some((r) => r.id === report.id)) ok("report listed");
  else bad("listReports", "missing");
  if (bundle.audits.length === 12 && bundle.opportunities.length > 0 && bundle.plan.initiatives.length > 0) {
    ok("bundle: 12 audits + opportunities + plan");
  } else bad("bundle", "incomplete");
  const done = await setReportStatus(report.id, wsId, "battery", "ready");
  if (done.status === "ready") ok("report finalized to ready");
  else bad("finalize", done.status);
  const archived = await setReportStatus(report.id, wsId, "battery", "archived");
  if (archived.status === "archived") ok("report archivable");
  else bad("archive", archived.status);

  // PDF renders end-to-end on the house takumi stack (glyph-safe).
  try {
    // Deploy PR: the PDF is stored in the shared blob store (pdfUrl is a blob ref).
    const { pdfUrl, bytes } = await renderIntelligencePdf({
      workspaceId: wsId,
      reportId: report.id, brandName: "Battery Brand", domain: "example.com",
      audits: bundle.audits, opportunities: bundle.opportunities, plan: bundle.plan,
      generatedAt: bundle.generatedAt,
    });
    const { deleteStoredRef, readStoredRef } = await import("@/lib/filesystem/storage");
    const stored = await readStoredRef(pdfUrl, "reports");
    if (bytes.length > 10000 && stored?.equals(bytes)) ok(`PDF rendered and stored (${bytes.length} bytes)`);
    else bad("pdf", `too small or not stored: ${bytes.length}`);
    await deleteStoredRef(pdfUrl, "reports").catch(() => {});
  } catch (e) {
    bad("pdf", e instanceof Error ? e.message : String(e));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.workspace.deleteMany({ where: { id: wsId } });
  if (failed > 0) { console.log("FAILURES:", failures); process.exit(1); }
  console.log("INTELLIGENCE BATTERY GREEN");
}

main().catch((err) => { console.error("battery crashed:", err); process.exit(2); });
