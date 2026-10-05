// ShapesOS — Phase 15.1: regenerate the table in docs/KEYS.md from the typed
// registry (lib/providers/key-sources.ts). The unit suite fails when the
// committed table drifts from the registry; run this after editing it:
//   npx tsx scripts/docs/generate-keys-md.mts
import { readFileSync, writeFileSync } from "node:fs";
import { keysMarkdownTable } from "../../lib/providers/key-sources";

const PATH = new URL("../../docs/KEYS.md", import.meta.url);
const BEGIN = "<!-- BEGIN keys-table (generated: npx tsx scripts/docs/generate-keys-md.mts) -->";
const END = "<!-- END keys-table -->";
const doc = readFileSync(PATH, "utf8");
const a = doc.indexOf(BEGIN);
const b = doc.indexOf(END);
if (a < 0 || b < a) throw new Error("docs/KEYS.md is missing the keys-table markers");
writeFileSync(PATH, `${doc.slice(0, a + BEGIN.length)}\n${keysMarkdownTable()}\n${doc.slice(b)}`);
console.log("docs/KEYS.md table regenerated");
