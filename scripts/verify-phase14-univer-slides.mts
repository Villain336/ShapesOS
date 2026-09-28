// Phase 14 slice 9 — real slide surface (raw OSS @univerjs/slides + slides-ui).
// Exercises: ISlideData builder shape, validator acceptance of the new shape
// AND the slice 6/7/8 stub shape, embedded rich-text docs validity.
// Run: npx tsx scripts/verify-phase14-univer-slides.mts

import { buildSlideSnapshot, validateSnapshot } from "../lib/univer/snapshots";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n## slide snapshot builder (real ISlideData)");
{
  const snap = buildSlideSnapshot({
    title: "Launch Deck",
    slides: [
      { title: "Intro", body: "Welcome\nto the deck" },
      "Just a string slide",
    ],
  }) as unknown as Record<string, any>;

  check("has id/title", typeof snap.id === "string" && snap.title === "Launch Deck");
  check("16:9 pageSize", snap.pageSize?.width === 960 && snap.pageSize?.height === 540);
  check("two pages in order", Array.isArray(snap.body?.pageOrder) && snap.body.pageOrder.length === 2);

  const p0 = snap.body.pages[snap.body.pageOrder[0]];
  check("page has title + body text elements", p0 && Object.keys(p0.pageElements ?? {}).length === 2);
  const els = Object.values(p0.pageElements ?? {}) as Array<any>;
  check("elements are TEXT type", els.every((e) => e.type === 2));
  const titleRich = els.find((e) => e.title === "Title")?.richText?.rich;
  check("title textbox carries rich doc", typeof titleRich?.body?.dataStream === "string" && titleRich.body.dataStream.includes("Intro"));
  check("title doc validates as doc", validateSnapshot("doc", titleRich).ok);
  const bodyRich = els.find((e) => e.title === "Body")?.richText?.rich;
  check("body paragraphs preserved", (bodyRich?.body?.dataStream ?? "").includes("to the deck"));
  check("white page background", p0.pageBackgroundFill?.rgb === "#FFFFFF");

  const p1 = snap.body.pages[snap.body.pageOrder[1]];
  const p1Title = (Object.values(p1.pageElements ?? {}) as Array<any>).find((e) => e.title === "Title");
  check("string slide → title fallback", (p1Title?.richText?.rich?.body?.dataStream ?? "").includes("Just a string slide"));

  check("real slide snapshot validates", validateSnapshot("slide", snap).ok);
}

console.log("\n## validator backward compatibility");
{
  // Slice 6/7/8 minimal stub shape — docs created before slice 9 must load.
  const stub = { id: "slide_old", title: "Old", appVersion: "1.0.2", slides: [{ id: "slide_0", title: "T", body: "B" }] };
  check("old stub shape still accepted", validateSnapshot("slide", stub).ok);
  check("garbage rejected", !validateSnapshot("slide", { id: "x" }).ok);
  check("empty pages rejected", !validateSnapshot("slide", { id: "x", title: "T", body: { pages: {} } }).ok);
}

console.log("\n## empty deck");
{
  const snap = buildSlideSnapshot({ title: "Empty", slides: [] }) as unknown as Record<string, any>;
  check("empty deck validates structurally", typeof snap.id === "string" && Array.isArray(snap.body?.pageOrder));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (failures.length) { console.log("FAILURES:", failures.join(", ")); process.exit(1); }
