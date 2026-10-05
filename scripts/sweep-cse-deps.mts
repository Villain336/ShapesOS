// Marketr — Phase 10 M6: Google CSE shutdown sweep.
// Google Custom Search Engine shuts down 2027-01-01 (SPEC-PHASE10 §2 🚫).
// Nothing — Marketr code or documented BYO-key user setups — may depend on it.
// Run: npx tsx scripts/sweep-cse-deps.mts
// Exit 0 = clean. Exit 1 = references found (report them, migrate before the cutoff).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".turbo", "dist", "build", ".pgdata"]);
// The scanner's own pattern strings would self-match — exclude it.
// docs/specs/SPEC-PHASE10.md documents the CSE shutdown ban itself (the §2 🚫 list);
// it is the prohibition's documentation, not a code/config dependency.
const SKIP_FILES = new Set(["scripts/sweep-cse-deps.mts", "docs/specs/SPEC-PHASE10.md"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".mp4", ".pdf", ".zip"]);

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "customsearch.googleapis.com (CSE API host)", re: /customsearch\.googleapis\.com/i },
  { name: "cse.google.com (CSE console)", re: /cse\.google\.com/i },
  { name: "Custom Search Engine / Custom Search JSON API", re: /custom\s+search\s+(engine|json|api)/i },
  { name: "CSE API key param (key=…&cx=…)", re: /[?&]cx=[\w:-]+/ },
  { name: "googleapis.com/customsearch path", re: /googleapis\.com\/customsearch/i },
  { name: "programmable search engine", re: /programmable\s+search\s+engine/i },
];

interface Hit {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

const hits: Hit[] = [];

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && st.size < 2_000_000) yield full;
  }
}

function extOf(f: string): string {
  const i = f.lastIndexOf(".");
  return i >= 0 ? f.slice(i).toLowerCase() : "";
}

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.has(rel)) continue;
  if (SKIP_EXT.has(extOf(file))) continue;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Skip minified / generated noise unless it actually matches a pattern below.
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({
          file: relative(ROOT, file),
          line: i + 1,
          pattern: p.name,
          text: line.trim().slice(0, 160),
        });
        break; // one hit per line is enough
      }
    }
  });
}

console.log("═".repeat(64));
console.log("Marketr — Google CSE shutdown sweep (cutoff 2027-01-01)");
console.log("═".repeat(64));

if (hits.length === 0) {
  console.log("CLEAN: no Google CSE / Custom Search dependencies found.");
  console.log("Scanned: all repo files (node_modules, .next, .git excluded).");
  process.exit(0);
}

console.log(`FOUND ${hits.length} reference(s) — migrate before 2027-01-01:\n`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}`);
  console.log(`    [${h.pattern}] ${h.text}`);
}
process.exit(1);
