// Pass 2: rename icon USAGES after import conversion.
// Only renames an old identifier when:
//  - the file's phosphor import contains the mapped (orig -> mapped) pair, and
//  - the file does NOT declare its own local `orig` (const/function/class/import type).
import { execSync } from "node:child_process";
import fs from "node:fs";

const files = execSync('grep -rl "@phosphor-icons/react" app components lib --include="*.tsx" --include="*.ts"')
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

for (const f of files) {
  let src = fs.readFileSync(f, "utf8");
  // find import pairs: "Mapped as Alias" or "Mapped"
  const importRe = /import\s*\{([^}]*)\}\s*from\s*"@phosphor-icons\/react"/;
  const m = src.match(importRe);
  if (!m) continue;
  const pairs = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const am = tok.match(/^(\w+)\s+as\s+(\w+)$/);
      return am ? { mapped: am[1], local: am[2] } : { mapped: tok, local: tok };
    });
  // build reverse map by scanning git diff of the import block is hard; instead
  // re-derive: get the ORIGINAL lucide import from git HEAD.
  const head = execSync(`git show HEAD:${f} 2>/dev/null`, { encoding: "utf8" });
  const headRe = /import\s*\{([^}]*)\}\s*from\s*"lucide-react"/;
  const hm = head.match(headRe);
  if (!hm) continue;
  const origLocals = hm[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const am = tok.match(/^(\w+)\s+as\s+(\w+)$/);
      return am ? am[2] : tok;
    });
  // orig local i-th corresponds to pairs[i-th] (same order)
  const rename = new Map();
  for (let i = 0; i < origLocals.length && i < pairs.length; i++) {
    if (origLocals[i] !== pairs[i].local) rename.set(origLocals[i], pairs[i].local);
  }
  if (!rename.size) continue;

  // guard: skip file if any old name is locally declared
  let skip = false;
  for (const old of rename.keys()) {
    const decl = new RegExp(`\\b(const|let|var|function|class|type|interface)\\s+${old}\\b`);
    if (decl.test(src)) {
      console.warn(`SKIP local-shadow ${old} in ${f}`);
      skip = true;
      break;
    }
  }
  if (skip) continue;

  // remove the import block from consideration, rename remaining occurrences
  const importBlock = m[0];
  const rest = src.replace(importBlock, "\u0000IMPORT\u0000");
  let out = rest;
  for (const [old, local] of rename) {
    out = out.replace(new RegExp(`\\b${old}\\b`, "g"), local);
  }
  out = out.replace("\u0000IMPORT\u0000", importBlock);
  fs.writeFileSync(f, out);
  console.log(`renamed in ${f}:`, [...rename.entries()].map(([a, b]) => `${a}->${b}`).join(", "));
}
