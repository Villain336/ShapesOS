// Phase 14 slice 7 — reports-as-sheets verification.
// Exercises: analytics multi-section sheet snapshot, content-calendar rows,
// prospect-list rows, sourceRef provenance, and the office ?open deep link
// contract (doc id round-trip). Run: npx tsx scripts/verify-phase14-univer-sheets.mts

import { randomUUID } from "node:crypto";
import { buildSheetSnapshot, validateSnapshot } from "../lib/univer/snapshots";
import { createUniverDoc, getUniverDoc, listUniverDocs } from "../lib/univer/docs";
import { prisma } from "../lib/prisma";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// The workspace id must be a real workspace row: create a throwaway one and
// clean it up at the end (same pattern as the slice-6 substrate suite).
async function makeWorkspace(): Promise<string> {
  const id = `test-${randomUUID()}`;
  await prisma.univerDoc.deleteMany({ where: { workspaceId: id } });
  await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({
    data: { id, name: "slice7-test", ownerUserId: "slice7-test-owner" },
  });
  return id;
}

console.log("\n## analytics report sheet");
{
  // Mirror components/analytics/AnalyticsPanel.sheetRows()
  const stats = { pageviews: 1204, visitors: 812, visits: 903, bounces: 301, totaltime: 5420 };
  const series = [{ t: 1, x: "Sep 21", y: 40 }, { t: 2, x: "Sep 22", y: 55 }];
  const rows: (string | number | null)[][] = [
    ["Pageviews", stats.pageviews],
    ["Visitors", stats.visitors],
    ["Visits", stats.visits],
    ["Bounces", stats.bounces],
    ["Time on site (s)", Math.round(stats.totaltime)],
    [],
    ["Date", "Pageviews"],
  ];
  for (const b of series) rows.push([b.x, b.y]);
  const snap = buildSheetSnapshot({ title: "Analytics — last 30 days", headers: ["Metric", "Value"], rows, sheetName: "Overview" });
  check("analytics snapshot validates", validateSnapshot("sheet", snap).ok);
  const cells = (snap.sheets as any)[Object.keys(snap.sheets)[0]].cellData;
  check("stat rows landed", cells["1"]?.["0"]?.v === "Pageviews" && cells["1"]?.["1"]?.v === 1204);
  check("blank separator row exists", Object.keys(cells["6"] ?? {}).length === 0);
  check("series rows landed", cells["8"]?.["0"]?.v === "Sep 21" && cells["8"]?.["1"]?.v === 40);
}

console.log("\n## content-calendar sheet");
{
  const posts = [
    { date: "2026-09-30T09:00:00Z", content: "Launch day!", channels: ["x", "linkedin"], type: "schedule", createdAt: "2026-09-28T10:00:00Z" },
    { date: null, content: null, channels: [], type: "draft", createdAt: null },
  ];
  const snap = buildSheetSnapshot({
    title: "Content calendar",
    headers: ["Scheduled for", "Post", "Channels", "Type", "Created"],
    rows: posts.map((p) => [p.date ?? "—", p.content ?? "—", p.channels.join(", ") || "—", p.type, p.createdAt ?? "—"]),
    sheetName: "Calendar",
  });
  check("calendar snapshot validates", validateSnapshot("sheet", snap).ok);
  const cells = (snap.sheets as any)[Object.keys(snap.sheets)[0]].cellData;
  check("calendar row landed", cells["1"]?.["2"]?.v === "x, linkedin");
}

console.log("\n## prospect list sheet");
{
  const snap = buildSheetSnapshot({
    title: "Prospect list — Seed",
    headers: ["Company", "Contact", "Title", "Email", "Phone", "Website", "Score", "Status"],
    rows: [["Acme", "Jane", "CEO", "jane@acme.co", "555-0100", "acme.co", 72, "new"]],
    sheetName: "Prospects",
  });
  check("prospect snapshot validates", validateSnapshot("sheet", snap).ok);
}

console.log("\n## sourceRef provenance + ?open contract");
{
  const workspaceId = await makeWorkspace();
  try {
    const marker = `sheet7-${randomUUID().slice(0, 8)}`;
    const snap = buildSheetSnapshot({ title: marker, headers: ["Metric", "Value"], rows: [["Pageviews", 1]] });
    const doc = await createUniverDoc(workspaceId, { kind: "sheet", title: marker, snapshot: snap, sourceRef: "analytics:overview" });
    check("doc created with sourceRef", (doc as any).sourceRef === "analytics:overview", JSON.stringify(doc).slice(0, 120));
    const again = await getUniverDoc(workspaceId, doc.id);
    check("doc id resolves for ?open=", again?.id === doc.id);
    const listed = await listUniverDocs(workspaceId, { limit: 100 });
    check("doc appears in office list", listed.some((d) => d.id === doc.id));
    // sourceRef query round-trip
    const listedRef = await listUniverDocs(workspaceId, { limit: 100, sourceRef: "analytics:overview" });
    check("sourceRef filter finds doc", listedRef.some((d) => d.id === doc.id));
  } finally {
    await prisma.univerDoc.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  }
}

await prisma.$disconnect();

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failures.length) { console.log("FAILURES:", failures.join(", ")); process.exit(1); }
