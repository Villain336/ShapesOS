#!/usr/bin/env tsx
// Marketr — Phase 14 slice 6 verify: Univer substrate.
// Snapshot builders + validators (pure), UniverDoc CRUD (host-owned storage),
// version-bump on save, workspace isolation, invalid-snapshot rejection.
//
// Usage: npx tsx scripts/verify-phase14-univer-substrate.mts
// Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  buildDocSnapshot,
  buildSheetSnapshot,
  buildSlideSnapshot,
  validateSnapshot,
  isUniverDocKind,
} from "../lib/univer/snapshots";
import {
  createUniverDoc,
  deleteUniverDoc,
  getUniverDoc,
  listUniverDocs,
  renameUniverDoc,
  saveUniverDocSnapshot,
} from "../lib/univer/docs";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n## ${title}`);
}

const WS_A = "14-univer-a";
const WS_B = "14-univer-b";

async function resetState() {
  for (const id of [WS_A, WS_B]) {
    await prisma.univerDoc.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `14 univer ${id}`, ownerUserId: "14-univer-owner" },
    });
  }
}

async function main() {
  // ---- builders ---------------------------------------------------------
  section("snapshot builders");

  const sheet = buildSheetSnapshot({
    title: "Q3 Report",
    headers: ["Channel", "Spend", "Leads"],
    rows: [
      ["Paid", 1200, 34],
      ["Organic", 0, 51],
    ],
  });
  check("sheet has id/name/sheets", !!sheet.id && sheet.name === "Q3 Report" && !!sheet.sheets);
  const sheetId = sheet.sheetOrder[0];
  const cells = sheet.sheets[sheetId]?.cellData as Record<string, Record<string, { v?: unknown; s?: string }>>;
  check("header row placed with bold style ref", cells?.["0"]?.["0"]?.v === "Channel" && cells["0"]["0"].s === "header");
  check("data rows placed", cells?.["1"]?.["1"]?.v === 1200 && cells?.["2"]?.["2"]?.v === 51);

  const doc = buildDocSnapshot({
    title: "Brief",
    heading: "Executive summary",
    paragraphs: ["Line one.", "Line two."],
  });
  check("doc has id/title/body", !!doc.id && doc.title === "Brief" && typeof doc.body?.dataStream === "string");
  const ds = doc.body!.dataStream!;
  check(
    "doc dataStream terminates paragraphs",
    ds.startsWith("Executive summary\r\n\r\nLine one.\r\nLine two.\r\n"),
    JSON.stringify(ds.slice(0, 60)),
  );
  const starts = doc.body!.paragraphs!.map((p) => p.startIndex);
  check("doc paragraph offsets accumulate", JSON.stringify(starts) === JSON.stringify([0, 19, 21, 32]), JSON.stringify(starts));

  const deck = buildSlideSnapshot({ title: "Pitch", slides: ["Intro", "Numbers"] });
  check("slide minimal shape", Array.isArray((deck as { slides: unknown[] }).slides) && typeof deck.id === "string");

  check("kind guard", isUniverDocKind("sheet") && isUniverDocKind("doc") && isUniverDocKind("slide") && !isUniverDocKind("pdf"));

  // ---- validators -------------------------------------------------------
  section("validators");

  check("valid sheet passes", validateSnapshot("sheet", sheet).ok);
  check("valid doc passes", validateSnapshot("doc", JSON.parse(JSON.stringify(doc))).ok);
  check("valid slide passes", validateSnapshot("slide", deck).ok);
  check("non-object rejected", !validateSnapshot("sheet", null).ok);
  check("missing id rejected", !validateSnapshot("sheet", { ...sheet, id: "" }).ok);
  check(
    "sheet without sheets rejected",
    !validateSnapshot("sheet", { id: "x", name: "n", sheets: {}, sheetOrder: [] }).ok,
  );
  check(
    "doc without body rejected",
    !validateSnapshot("doc", { id: "x", documentStyle: {} }).ok,
  );
  const huge = { id: "x", name: "n", sheets: { s1: {} }, sheetOrder: ["s1"], pad: "x".repeat(11 * 1024 * 1024) };
  check("oversize snapshot rejected", !validateSnapshot("sheet", huge).ok);

  // ---- CRUD -------------------------------------------------------------
  section("CRUD + isolation");

  await resetState();

  const created = await createUniverDoc(WS_A, {
    kind: "sheet",
    title: "WS A sheet",
    snapshot: sheet,
    sourceRef: "report:q3",
  });
  check("create returns v1", created.version === 1 && created.title === "WS A sheet");

  const fetched = await getUniverDoc(WS_A, created.id);
  check("get within workspace", fetched?.id === created.id);

  const cross = await getUniverDoc(WS_B, created.id);
  check("cross-workspace get is null", cross === null);

  const listed = await listUniverDocs(WS_A);
  check("list newest-first", listed.length === 1 && listed[0].id === created.id);

  const renamed = await renameUniverDoc(WS_A, created.id, "Renamed");
  check("rename", renamed.title === "Renamed");

  const edited = JSON.parse(JSON.stringify(sheet)) as {
    sheets: Record<string, { cellData: Record<string, Record<string, { v: unknown }>> }>;
  };
  edited.sheets[sheetId].cellData["3"] = { "0": { v: "Extra" } };
  const saved = await saveUniverDocSnapshot(WS_A, created.id, edited, { expectedVersion: 1 });
  check("save bumps version", saved.version === 2);

  let conflicted = false;
  try {
    await saveUniverDocSnapshot(WS_A, created.id, edited, { expectedVersion: 1 });
  } catch (e) {
    conflicted = e instanceof Error && e.message.startsWith("version conflict");
  }
  check("stale expectedVersion → conflict", conflicted);

  let invalidRejected = false;
  try {
    await createUniverDoc(WS_A, { kind: "sheet", title: "bad", snapshot: { nope: true } });
  } catch {
    invalidRejected = true;
  }
  check("invalid snapshot create rejected", invalidRejected);

  let crossSaveBlocked = false;
  try {
    await saveUniverDocSnapshot(WS_B, created.id, edited);
  } catch {
    crossSaveBlocked = true;
  }
  check("cross-workspace save blocked", crossSaveBlocked);

  await deleteUniverDoc(WS_A, created.id);
  check("delete", (await getUniverDoc(WS_A, created.id)) === null);

  // ---- summary ----------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILURES:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
