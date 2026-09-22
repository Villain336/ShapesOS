// Marketr M21 part D1 — UI contract verifier (skills / connectors / settings).
//
// Checks, without a running server or live API routes:
//   1. Every expected page + component file exists.
//   2. No emoji literals in JSX (Lucide-only icon rule; zero icons used since
//      lucide-react is not installed and no new deps are allowed).
//   3. No icon-library imports at all in the new files.
//   4. Never calls the agent "AI Assistant" — it is "Marketr" everywhere.
//   5. Every /api/... URL fetched by the client components matches the M21
//      contract (both directions: no invented paths, no missing ones).
//   6. Every fetch sends workspaceId.
//   7. Server pages gate with requireWorkspaceRole + getOrCreateWorkspace,
//      render SettingsNav, and use "use client" only in client components.
//
// Run: npx tsx scripts/verify-m21-ui-d1.mts

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const rel = (p: string) => join(ROOT, p);

const PAGES = [
  "app/dashboard/settings/skills/page.tsx",
  "app/dashboard/settings/connectors/page.tsx",
  "app/dashboard/settings/members/page.tsx",
  "app/dashboard/settings/providers/page.tsx",
  "app/dashboard/settings/governance/page.tsx",
  "app/dashboard/settings/security/page.tsx",
  "app/dashboard/settings/notifications/page.tsx",
  "app/dashboard/settings/defaults/page.tsx",
  "app/dashboard/settings/audit/page.tsx",
];

const SHARED = [
  "components/settings/ui.tsx",
  "components/settings/SettingsNav.tsx",
];

const CLIENTS = [
  "components/settings/SkillsManager.tsx",
  "components/settings/ConnectorsManager.tsx",
  "components/settings/PermissionGrantsManager.tsx",
  "components/settings/GovernanceForm.tsx",
  "components/settings/NotificationsForm.tsx",
  "components/settings/DefaultsForm.tsx",
  "components/settings/AuditLogViewer.tsx",
];

const ALL = [...PAGES, ...SHARED, ...CLIENTS];

// The M21 API contract (task text), normalized: ${...} -> :p
const CONTRACT = new Set([
  "/api/skills",
  "/api/skills/registry",
  "/api/skills/preview-url",
  "/api/skills/install",
  "/api/skills/:p/repin",
  "/api/skills/:p",
  "/api/connectors",
  "/api/connectors/mcp",
  "/api/connectors/mcp/:p",
  "/api/connectors/:p/auth-url",
  "/api/connectors/:p/api-key",
  "/api/connections/:p",
  "/api/connections/:p/refresh",
  "/api/settings/workspace",
  "/api/settings/audit",
  "/api/members/grants",
  "/api/members/grants/:p",
]);

let failures = 0;
function fail(msg: string) {
  failures++;
  console.log(`FAIL  ${msg}`);
}
function ok(msg: string) {
  console.log(`ok    ${msg}`);
}

const src: Record<string, string> = {};
for (const f of ALL) {
  if (!existsSync(rel(f))) {
    fail(`missing file: ${f}`);
    continue;
  }
  src[f] = readFileSync(rel(f), "utf8");
  ok(`exists: ${f}`);
}

// 2. No emoji literals
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
for (const f of Object.keys(src)) {
  const m = src[f].match(EMOJI);
  if (m) fail(`emoji literal in ${f}: U+${m[0].codePointAt(0)!.toString(16)}`);
  else ok(`no emoji: ${f}`);
}

// 3. No icon-library imports
for (const f of Object.keys(src)) {
  if (/from\s+["'](lucide-react|@phosphor-icons\/react)["']/.test(src[f])) {
    fail(`icon library import in ${f}`);
  } else {
    ok(`no icon imports: ${f}`);
  }
}

// 4. Never "AI Assistant"
for (const f of Object.keys(src)) {
  if (/ai assistant/i.test(src[f])) fail(`"AI Assistant" in ${f}`);
  else ok(`no "AI Assistant": ${f}`);
}

// 5. Extract /api/... URLs from client components and diff against the contract
function normalize(url: string): string {
  return url
    .split("?")[0]
    .replace(/\$\{[^}]*\}/g, ":p");
}

const seen = new Set<string>();
const perFile = new Map<string, string[]>();
for (const f of CLIENTS) {
  if (!src[f]) continue;
  const urls: string[] = [];
  const re = /["'`](\/api\/[^"'`\s]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src[f]))) {
    const n = normalize(m[1]);
    urls.push(n);
    seen.add(n);
  }
  perFile.set(f, urls);
  if (urls.length === 0) fail(`no /api URLs extracted from ${f}`);
  else ok(`${f}: ${urls.length} api call(s)`);
}
for (const u of seen) {
  if (!CONTRACT.has(u)) fail(`invented api path (not in contract): ${u}`);
}
for (const c of CONTRACT) {
  if (!seen.has(c)) fail(`contract path never used: ${c}`);
}
if ([...seen].every((u) => CONTRACT.has(u)) && [...CONTRACT].every((c) => seen.has(c))) {
  ok("api contract: extracted paths match contract exactly (both directions)");
}

// 6. Every fetch sends workspaceId
function fetchRegions(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (true) {
    const idx = s.indexOf("fetch(", i);
    if (idx === -1) break;
    let depth = 0;
    let j = idx + "fetch(".length - 1; // the '('
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(s.slice(idx, j + 1));
    i = j + 1;
  }
  return out;
}
for (const f of CLIENTS) {
  if (!src[f]) continue;
  const regions = fetchRegions(src[f]);
  const qHasWs = /const q = `[^`]*workspaceId/.test(src[f]);
  const paramsHasWs = /new URLSearchParams\(\{\s*workspaceId/.test(src[f]);
  for (const r of regions) {
    // Body may be built in a variable before the call, e.g.
    //   const body = { workspaceId, permission };
    //   fetch(url, { method: "POST", body: JSON.stringify(body) })
    const bodyId = r.match(/body:\s*JSON\.stringify\((\w+)\)/);
    let bodyHasWs = false;
    if (bodyId) {
      const decl = src[f].match(new RegExp(`const ${bodyId[1]}[^;]*;`));
      bodyHasWs = !!decl && decl[0].includes("workspaceId");
    }
    const sends =
      r.includes("workspaceId") ||
      bodyHasWs ||
      (r.includes("${q}") && qHasWs) ||
      (r.includes("params()") && paramsHasWs);
    if (!sends) fail(`fetch without workspaceId in ${f}: ${r.slice(0, 80)}…`);
  }
  ok(`workspaceId on all fetches: ${f} (${regions.length})`);
}

// 7. Server-page gating + nav
for (const f of PAGES) {
  if (!src[f]) continue;
  const s = src[f];
  if (!s.includes("requireWorkspaceRole")) fail(`no requireWorkspaceRole gate: ${f}`);
  if (!s.includes("getOrCreateWorkspace")) fail(`no getOrCreateWorkspace: ${f}`);
  if (!s.includes("SettingsNav")) fail(`no SettingsNav: ${f}`);
  if (!s.includes('export const dynamic = "force-dynamic"')) fail(`not force-dynamic: ${f}`);
  if (s.includes("fetch(")) fail(`server page fetches (should gate only): ${f}`);
  if (/["']use client["']/.test(s)) fail(`"use client" in server page: ${f}`);
  ok(`gating ok: ${f}`);
}
for (const f of CLIENTS) {
  if (!src[f]) continue;
  // "use client" must be the first statement (a leading comment block is fine)
  const head = src[f].slice(0, 600);
  if (!/^\s*(\/\/[^\n]*\n|\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(head))
    fail(`missing "use client": ${f}`);
  else ok(`"use client": ${f}`);
}
for (const f of SHARED) {
  if (!src[f]) continue;
  if (f.endsWith("SettingsNav.tsx")) {
    for (const p of ["/dashboard/settings/skills", "/dashboard/settings/connectors",
      "/dashboard/settings/members", "/dashboard/settings/providers",
      "/dashboard/settings/governance", "/dashboard/settings/security",
      "/dashboard/settings/notifications", "/dashboard/settings/defaults",
      "/dashboard/settings/audit"]) {
      if (!src[f].includes(p)) fail(`SettingsNav missing link ${p}`);
    }
    ok("SettingsNav links all 9 sections");
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
