// Marketr milestone 21, part D2 — UI verification.
// Project settings pages + chat file-attach UI.
//
// Run: npx tsx scripts/verify-m21-ui-d2.mts
// No database, no network: pure file scans against the M21 contract.
//
// Checks:
//  1. Every settings page file exists.
//  2. No emoji literals in the new JSX/TSX.
//  3. Every fetch URL in the new components matches the API contract list.
//  4. AssistantClient's component signature/props are intact.
//  5. AttachmentMenu is wired into AiChatPanel; sendMessage sends attachmentIds.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. Files exist ───────────────────────────────────────────
const EXPECTED_FILES = [
  "app/dashboard/projects/[id]/settings/layout.tsx",
  "app/dashboard/projects/[id]/settings/page.tsx",
  "app/dashboard/projects/[id]/settings/SettingsTabs.tsx",
  "app/dashboard/projects/[id]/settings/general/page.tsx",
  "app/dashboard/projects/[id]/settings/general/GeneralForm.tsx",
  "app/dashboard/projects/[id]/settings/skills/page.tsx",
  "app/dashboard/projects/[id]/settings/skills/SkillsClient.tsx",
  "app/dashboard/projects/[id]/settings/data/page.tsx",
  "app/dashboard/projects/[id]/settings/data/DataClient.tsx",
  "app/dashboard/projects/[id]/settings/files/page.tsx",
  "app/dashboard/projects/[id]/settings/files/FilesClient.tsx",
  "app/dashboard/projects/[id]/settings/automation/page.tsx",
  "app/dashboard/projects/[id]/settings/automation/AutomationClient.tsx",
  "app/dashboard/projects/[id]/settings/publishing/page.tsx",
  "app/dashboard/projects/[id]/settings/publishing/PublishingClient.tsx",
  "components/chat/AttachmentMenu.tsx",
  "scripts/verify-m21-ui-d2.mts",
];

for (const f of EXPECTED_FILES) {
  check(`file exists: ${f}`, existsSync(join(ROOT, f)));
}

// ── 2. No emoji literals ─────────────────────────────────────
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(rel));
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const SCAN_DIRS = [
  "app/dashboard/projects/[id]/settings",
  "components/chat",
];
const scanFiles = SCAN_DIRS.flatMap(tsxFiles);
check("scan set non-empty", scanFiles.length > 0, `${scanFiles.length} files`);
for (const f of scanFiles) {
  const src = readFileSync(join(ROOT, f), "utf8");
  const match = EMOJI_RE.exec(src);
  check(`no emoji: ${f}`, !match, match ? `found ${JSON.stringify(match[0])}` : "");
}

// ── 3. Fetch URLs match the contract ─────────────────────────
const CONTRACT = [
  "/api/projects/[x]/skills",
  "/api/connectors",
  "/api/projects/[x]/data-sources",
  "/api/projects/[x]/data-sources/[x]",
  "/api/projects/[x]/files",
  "/api/projects/[x]/files/[x]",
  "/api/projects/[x]/files/[x]/download",
  "/api/projects/[x]/settings",
  "/api/chat/threads/[x]/messages",
].map((u) => u.toLowerCase());

function normalize(url: string): string {
  return url
    .split("?")[0] // strip query strings
    .replace(/\$\{[^}]+\}/g, "[x]") // template placeholders
    .replace(/\[[^\]/]+\]/g, "[x]") // [projectId], [bindingId], ...
    .toLowerCase();
}

const FETCH_RE = /fetch\(\s*[`'"]([^`'"]+)[`'"]/g;
const foundUrls = new Map<string, string>(); // normalized -> file
for (const f of scanFiles) {
  const src = readFileSync(join(ROOT, f), "utf8");
  let m: RegExpExecArray | null;
  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src)) !== null) {
    const raw = m[1];
    if (!raw.startsWith("/api/")) continue; // ignore non-API fetches
    foundUrls.set(normalize(raw), f);
  }
}
// Pre-existing chat thread routes (not M21 contract, but not introduced by
// D2 — the sendMessage POST to /messages is the one D2 extended).
const PRE_EXISTING = ["/api/chat/threads", "/api/chat/threads/[x]"];

check("found fetch URLs to verify", foundUrls.size > 0, `${foundUrls.size}`);
for (const [url, file] of foundUrls) {
  const inContract = CONTRACT.includes(url);
  const preExisting = PRE_EXISTING.includes(url) && file.endsWith("ChatContext.tsx");
  check(
    `contract URL ${url} (${file})`,
    inContract || preExisting,
    preExisting ? "" : "not in contract",
  );
}

// ── 4. AssistantClient signature intact ──────────────────────
const assistantSrc = readFileSync(
  join(ROOT, "components/chat/AssistantClient.tsx"),
  "utf8",
);
const signatureMatch = /export default function AssistantClient\(\{([\s\S]*?)\}\s*:\s*\{/.exec(
  assistantSrc,
);
check("AssistantClient default export intact", signatureMatch !== null);
const sigProps = signatureMatch ? signatureMatch[1] : "";
for (const prop of [
  "project",
  "projects",
  "canEdit",
  "mockMode",
  "memberCount",
  "currentUserId",
  "initialTab",
]) {
  check(`AssistantClient prop intact: ${prop}`, new RegExp(`\\b${prop}\\b`).test(sigProps));
}

// ── 5. Attach wiring ─────────────────────────────────────────
const panelSrc = readFileSync(join(ROOT, "components/AiChatPanel.tsx"), "utf8");
check("AiChatPanel renders <AttachmentMenu", /<AttachmentMenu\s*\/>/.test(panelSrc));
const ctxSrc = readFileSync(join(ROOT, "components/chat/ChatContext.tsx"), "utf8");
check("sendMessage posts attachmentIds", /attachmentIds/.test(ctxSrc));
check("ChatContext exposes pendingAttachments", /pendingAttachments/.test(ctxSrc));
check(
  "AttachmentMenu imports Paperclip",
  /Paperclip/.test(
    readFileSync(join(ROOT, "components/chat/AttachmentMenu.tsx"), "utf8"),
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
