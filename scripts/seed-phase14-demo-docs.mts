// Marketr — Phase 14 final verification: seed demo office docs for the
// admin workspace (sheet, doc, slide) so screenshots show real content.
// Idempotent: deletes prior "Phase 14 demo" docs first.
//
// Run: npx tsx scripts/seed-phase14-demo-docs.mts
// Requires: DATABASE_URL. Credentials parsed literally from .env.

import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { createUniverDoc } from "../lib/univer/docs";
import { buildSheetSnapshot, buildDocSnapshot, buildSlideSnapshot } from "../lib/univer/snapshots";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";

function env(): Record<string, string> {
  const strip = (v: string) =>
    v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'") ? v.slice(1, -1) : v;
  return Object.fromEntries(
    readFileSync("/home/hatch/workspace/marketr/.env", "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), strip(l.slice(i + 1).trim())];
      }),
  );
}

async function main() {
  const { ADMIN_EMAIL } = env();
  if (!ADMIN_EMAIL) throw new Error("ADMIN_EMAIL missing in .env");
  // No User model in the Prisma schema (auth is external) — the admin
  // workspace is named "<ADMIN_EMAIL>'s workspace".
  const ws = await prisma.workspace.findFirst({
    where: { name: `${ADMIN_EMAIL}'s workspace` },
    select: { id: true },
  });
  if (!ws) throw new Error(`no workspace named ${ADMIN_EMAIL}'s workspace`);
  const workspaceId = ws.id;
  console.log("workspace:", workspaceId);

  await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.deleteMany({ where: { workspaceId, title: { startsWith: "Phase 14 demo" } } }),
  );

  const sheet = await createUniverDoc(workspaceId, {
    kind: "sheet",
    title: "Phase 14 demo — Prospect list",
    sourceRef: "prospects:demo",
    snapshot: buildSheetSnapshot({
      title: "Phase 14 demo — Prospect list",
      headers: ["Company", "Contact", "Title", "Email", "Score", "Status"],
      rows: [
        ["Acme Corp", "Jane Doe", "VP Marketing", "jane@acme.com", 92, "New"],
        ["Beta LLC", "John Smith", "Founder", "john@beta.com", 78, "Contacted"],
        ["Gamma Inc", "Ana Ruiz", "CMO", "ana@gamma.com", 85, "Qualified"],
        ["Delta Co", "Tom Lee", "Director", "tom@delta.com", 64, "New"],
      ],
    }),
  });

  const doc = await createUniverDoc(workspaceId, {
    kind: "doc",
    title: "Phase 14 demo — Q3 content brief",
    sourceRef: "reports:demo",
    snapshot: buildDocSnapshot({
      title: "Phase 14 demo — Q3 content brief",
      heading: "Q3 content brief",
      paragraphs: [
        "This brief was generated from the Q3 analytics report and opened as an editable document.",
        { text: "Priority: publish the pricing comparison guide first.", boldRanges: [[0, 8]] },
        { text: "Channels", headingLevel: 2 },
        "Blog, newsletter, and LinkedIn. Each piece links back to the ROI calculator.",
      ],
    }),
  });

  const slide = await createUniverDoc(workspaceId, {
    kind: "slide",
    title: "Phase 14 demo — Pitch deck",
    snapshot: buildSlideSnapshot({
      title: "Phase 14 demo — Pitch deck",
      slides: [
        { title: "GrowthOS", body: "The marketing OS for agencies\nand founders" },
        { title: "Traction", body: "Pilot users see more leads\nwithin 30 days" },
        { title: "Ask", body: "Join the private beta" },
      ],
    }),
  });

  console.log(JSON.stringify({ sheet: sheet.id, doc: doc.id, slide: slide.id }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
