// ShapesOS — Phase 22 (chat) demo / browser smoke: inline tool calls and
// approvals on `next dev`, driven by Playwright.
//
// THE MODEL IS A MOCK: a local fake of the OpenAI Responses API
// (lib/chat/__tests__/fake-responses.ts) scripted below — no model is called,
// nothing is spent. research_keywords runs against the labelled MockSeoProvider
// (ALLOW_FAKE_PROVIDERS=1). Everything else (the agent loop, the gate, the
// run timeline, the AG-UI stream, the decisions route) is the real code.
//
// Shows, in light/en and dark/es:
//   a. a safe tool call inline with its arguments and result (records table);
//   b. a spend tool held in the inline approval block;
//   c. the same turn after Approve: the result fills the call's block in
//      place, in the same stream, with no page reload (asserted);
//   d. Deny;
//   e. markdown in an assistant reply (heading, table, list, code);
// plus a short video (.webm) of the approve-in-place flow and an axe pass.
//
// Run INSIDE one heavy.sh call (it starts and stops `next dev`):
//   DATABASE_URL=<migrate url> APP_DATABASE_URL=<app-role url> SHOTS_DIR=<dir> PORT=3194 \
//     npx tsx scripts/smoke/p22-chat/demo.mts

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, openSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const SHOTS = process.env.SHOTS_DIR!;
const PORT = Number(process.env.PORT ?? 3194);
const BASE = `http://localhost:${PORT}`;
const EMAIL = "e2e-admin@example.com";
const PASSWORD = "e2e-admin-password";
const USER_ID = `admin:${EMAIL}`;
const APP_URL = process.env.APP_DATABASE_URL!;
mkdirSync(SHOTS, { recursive: true });

const results: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  const line = `${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`;
  results.push(line);
  console.log(line);
};

const { prisma } = await import("@/lib/prisma");
const { startFakeModel } = await import("@/lib/chat/__tests__/fake-responses");

let server: ChildProcess | null = null;
async function stopServer() {
  if (!server?.pid) return;
  const pgid = server.pid;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    /* gone */
  }
  await new Promise((r) => setTimeout(r, 4000));
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    /* gone */
  }
}

// ── the scripted MOCK model ──────────────────────────────────────────────────
type Item = Record<string, unknown>;
function lastUserText(input: Item[]): string {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i]!;
    if (it.role === "user") return typeof it.content === "string" ? it.content : JSON.stringify(it.content);
  }
  return "";
}
function lastCallName(input: Item[]): string {
  for (let i = input.length - 1; i >= 0; i--) if (input[i]!.type === "function_call") return String(input[i]!.name);
  return "";
}

const KEYWORDS_REPLY = [
  "## Your top keywords",
  "",
  "Five tracked phrases carry most of the **search demand**. The two worth acting on first:",
  "",
  "| Keyword | Volume | Difficulty |",
  "|:--|--:|--:|",
  "| espresso machine | 18100 | 62 |",
  "| burr coffee grinder | 9900 | 48 |",
  "",
  "1. Refresh the *espresso machine* guide — it ranks on page two.",
  "2. Add a comparison table to the grinder page.",
  "",
  "- [x] Keywords loaded",
  "- [ ] Content brief drafted",
  "",
  "Re-run the check any time with `/keywords`. Raw HTML stays text: <b>not bold</b>.",
].join("\n");

let toolCallsSeen = 0;
const model = await startFakeModel({ agentWorker: "off" });
model.script = (body) => {
  const input = (body.input ?? []) as Item[];
  const last = input[input.length - 1];
  const offered = (body.tools ?? []).map((t) => t.name);
  if (last?.type === "function_call_output") {
    const name = lastCallName(input);
    const out = String(last.output ?? "");
    if (name === "get_keywords") return { text: KEYWORDS_REPLY };
    if (name === "research_keywords") return { text: "Done — the ideas are in the table above. **espresso grinder** ideas lean commercial; start with the two highest-volume phrases." };
    if (name === "create_content_draft") return { text: /Not run|denied/i.test(out) ? "Understood — I won't draft it. Tell me if you want a different topic." : "The draft is saved." };
    return { text: "Done." };
  }
  if (!offered.length) return { text: "ok" };
  const user = lastUserText(input);
  toolCallsSeen++;
  if (/top keywords/i.test(user)) return { calls: [{ tool: "get_keywords", args: { limit: "5" } }] };
  if (/research keyword ideas/i.test(user)) return { calls: [{ tool: "research_keywords", args: { seed: "espresso grinder", limit: "6" } }] };
  if (/draft a post/i.test(user)) return { calls: [{ tool: "create_content_draft", args: { topic: "How to dial in espresso" } }] };
  return { text: "Hello — this is the scripted demo model." };
};

try {
  // ── seed: keywords on the E2E project ──
  const ws = await prisma.workspace.findFirstOrThrow({ where: { ownerUserId: USER_ID } });
  const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: ws.id, domain: "e2e-example.com" } });
  const kws = [
    ["espresso machine", 18100, 62],
    ["burr coffee grinder", 9900, 48],
    ["pour over kettle", 6600, 35],
    ["cold brew ratio", 5400, 22],
    ["descale espresso machine", 2900, 18],
  ] as const;
  for (const [phrase, volume, difficulty] of kws) {
    await prisma.keyword.upsert({
      where: { projectId_phrase: { projectId: project.id, phrase } },
      create: { projectId: project.id, phrase, volume, difficulty, tracked: true, list: "Q4 targets" },
      update: { volume, difficulty },
    });
  }

  // ── server ──
  const log = openSync(path.join(SHOTS, "next-dev.log"), "w");
  server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      DATABASE_URL: APP_URL,
      NEXTAUTH_URL: BASE,
      APP_URL: BASE,
      ADMIN_EMAIL: EMAIL,
      ADMIN_PASSWORD: PASSWORD,
      RATE_LIMIT_READ_PER_MIN: "2000",
      NEXT_TELEMETRY_DISABLED: "1",
      ALLOW_FAKE_PROVIDERS: "1",
      AGENT_WORKER: "off",
      OPENUI_TELEMETRY_DISABLED: "1",
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
  });
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/login`)).ok;
    } catch {
      /* starting */
    }
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  ok("next dev came up", up);
  if (!up) throw new Error("server did not start");

  // ── browser ──
  const require = createRequire(path.join(REPO, "package.json"));
  const { chromium } = require("playwright") as typeof import("playwright");
  const AXE = require.resolve("axe-core/axe.min.js");
  const exe = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome"].find((p) => existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector('button[role="tab"], input[type="password"]', { timeout: 120000 });
  const adminTab = page.getByRole("tab", { name: "Admin" });
  if (await adminTab.count()) await adminTab.click();
  await page.getByPlaceholder("Email").fill(EMAIL, { timeout: 60000 });
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/dashboard**", { timeout: 60000 });
  ok("signed in", true);
  const storage = await ctx.storageState();

  const setPrefs = async (p: typeof page, prefs: Record<string, unknown>) => {
    const res = await p.request.fetch(`${BASE}/api/preferences`, { method: "PATCH", data: prefs });
    if (res.status() !== 200) throw new Error(`prefs ${res.status()}`);
  };
  const newThreadUrl = async (p: typeof page) => {
    const res = await p.request.post(`${BASE}/api/chat/threads`, { data: { projectId: project.id } });
    const data = (await res.json()) as { thread: { id: string } };
    return `${BASE}/dashboard/assistant?project=${project.id}&thread=${data.thread.id}`;
  };
  const send = async (p: typeof page, text: string) => {
    const box = p.getByRole("textbox", { name: "Prompt" });
    await box.click();
    await box.fill(text);
    await box.press("Enter");
  };
  const axe = async (label: string) => {
    await page.addScriptTag({ path: AXE });
    const v = await page.evaluate(async () => {
      const w = window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } };
      return (await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] })).violations;
    });
    const bad = v.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.impact} ${x.id}: ${x.help} -- ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    ok(`axe ${label}: zero serious/critical`, bad.length === 0, `${v.length} violations total; ${bad.join(" ;; ")}`);
  };

  for (const mode of [
    { theme: "light", language: "en", tag: "light-en", done: "Done", approved: "Approved", denied: "Denied" },
    { theme: "dark", language: "es", tag: "dark-es", done: "Hecho", approved: "Aprobado", denied: "Rechazado" },
  ] as const) {
    await setPrefs(page, { theme: mode.theme, language: mode.language });
    let navigations = 0;
    await page.goto(await newThreadUrl(page), { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 120000 });
    const onNav = (f: import("playwright").Frame) => {
      if (f === page.mainFrame()) navigations++;
    };
    page.on("framenavigated", onNav);

    // (a) + (e): a safe read tool inline, then a markdown reply.
    await send(page, "Show my top keywords");
    const kwBlock = page.locator('section[aria-label^="get_keywords:"]');
    await kwBlock.waitFor({ timeout: 120000 });
    await page.getByRole("heading", { name: "Your top keywords" }).waitFor({ timeout: 120000 });
    ok(`${mode.tag}: safe tool block shows Done`, (await kwBlock.getAttribute("aria-label"))?.includes(mode.done) === true, (await kwBlock.getAttribute("aria-label")) ?? "");
    ok(`${mode.tag}: records table inline (5 keyword rows)`, (await kwBlock.locator("tbody tr").count()) === 5, String(await kwBlock.locator("tbody tr").count()));
    await kwBlock.getByRole("button", { name: /Arguments|Argumentos/ }).click();
    ok(`${mode.tag}: arguments shown`, (await kwBlock.locator("pre").first().textContent())?.includes('"limit"') === true);
    const md = page.locator("main").getByRole("table").last();
    ok(`${mode.tag}: markdown table rendered`, (await md.locator("tbody tr").count()) === 2);
    ok(`${mode.tag}: raw HTML stays text`, (await page.getByText("<b>not bold</b>").count()) === 1);
    await kwBlock.screenshot({ path: path.join(SHOTS, `a-safe-tool-inline-args-result-${mode.tag}.png`) });
    await page.screenshot({ path: path.join(SHOTS, `e-markdown-reply-${mode.tag}.png`) });

    // (b) a spend tool held in the inline approval block.
    await send(page, "Research keyword ideas for espresso grinders");
    const approval = page.locator("article[data-approval-block]").last();
    await approval.waitFor({ timeout: 120000 });
    await approval.locator('[data-decision="approve"]').waitFor({ timeout: 60000 });
    const rkBlock = page.locator('section[aria-label^="research_keywords:"]');
    ok(`${mode.tag}: spend call is held (one block, waiting)`, (await rkBlock.count()) === 1);
    ok(`${mode.tag}: the "reply yes" prose is replaced by the block`, (await page.getByText(/Reply \*\*yes\*\*|Reply yes to confirm/).count()) === 0);
    await approval.scrollIntoViewIfNeeded();
    await approval.screenshot({ path: path.join(SHOTS, `b-spend-tool-approval-block-${mode.tag}.png`) });
    await page.screenshot({ path: path.join(SHOTS, `b-spend-tool-approval-page-${mode.tag}.png`) });

    // (c) Approve: the result fills the same block, same stream, no reload.
    await page.evaluate(() => {
      (window as unknown as { __p22NoReload: number }).__p22NoReload = 42;
    });
    const navBefore = navigations;
    await approval.locator('[data-decision="approve"]').click();
    await page.waitForFunction(
      (done) => {
        const el = document.querySelector('section[aria-label^="research_keywords:"]');
        return !!el && (el.getAttribute("aria-label") ?? "").includes(done);
      },
      mode.done,
      { timeout: 120000 },
    );
    await page.getByText(/ideas are in the table above/).waitFor({ timeout: 120000 });
    const marker = await page.evaluate(() => (window as unknown as { __p22NoReload?: number }).__p22NoReload);
    ok(`${mode.tag}: approve → result in place with NO reload`, marker === 42 && navigations === navBefore, `marker=${marker} navigations=${navigations - navBefore}`);
    ok(`${mode.tag}: still exactly one research_keywords block`, (await rkBlock.count()) === 1);
    ok(`${mode.tag}: the result rows render in that block`, (await rkBlock.locator("tbody tr").count()) > 0, String(await rkBlock.locator("tbody tr").count()));
    ok(`${mode.tag}: the approval item says ${mode.approved}`, (await approval.getByText(mode.approved, { exact: true }).count()) >= 1);
    await rkBlock.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `c-after-approve-result-in-place-${mode.tag}.png`) });
    await rkBlock.screenshot({ path: path.join(SHOTS, `c-after-approve-tool-block-${mode.tag}.png`) });

    // (d) Deny.
    await send(page, "Draft a post about dialing in espresso");
    const second = page.locator("article[data-approval-block]").last();
    await page.waitForFunction(() => document.querySelectorAll("article[data-approval-block]").length >= 2, undefined, { timeout: 120000 });
    await second.locator('[data-decision="deny"]').click();
    await page.getByText(/won't draft it|won’t draft it/).waitFor({ timeout: 120000 });
    ok(`${mode.tag}: deny → the item says ${mode.denied}`, (await second.getByText(mode.denied, { exact: true }).count()) >= 1);
    const draftBlock = page.locator('section[aria-label^="create_content_draft:"]');
    ok(`${mode.tag}: the denied call never ran (Stopped, one block)`, (await draftBlock.count()) === 1 && !((await draftBlock.getAttribute("aria-label")) ?? "").includes(mode.done), (await draftBlock.getAttribute("aria-label")) ?? "");
    await second.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `d-deny-${mode.tag}.png`) });
    await second.screenshot({ path: path.join(SHOTS, `d-deny-block-${mode.tag}.png`) });

    // A reload renders the same blocks from the persisted thread.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('section[aria-label^="research_keywords:"]').waitFor({ timeout: 120000 });
    ok(`${mode.tag}: after a reload, still one block per call (no duplicate chips)`, (await page.locator('section[aria-label^="research_keywords:"]').count()) === 1 && (await page.locator('section[aria-label^="get_keywords:"]').count()) === 1);
    await axe(`${mode.tag} (assistant with tool, approval and denied blocks)`);
    page.off("framenavigated", onNav);
  }

  // ── video: the approve-in-place flow (light/en) ──
  await setPrefs(page, { theme: "light", language: "en" });
  const videoDir = path.join(SHOTS, "video-tmp");
  mkdirSync(videoDir, { recursive: true });
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: storage, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
  const vpage = await vctx.newPage();
  const url = await newThreadUrl(vpage);
  await vpage.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  await vpage.getByRole("textbox", { name: "Prompt" }).waitFor({ timeout: 120000 });
  await vpage.waitForTimeout(800);
  await send(vpage, "Research keyword ideas for espresso grinders");
  const vApproval = vpage.locator("article[data-approval-block]").last();
  await vApproval.locator('[data-decision="approve"]').waitFor({ timeout: 120000 });
  await vpage.waitForTimeout(1500);
  await vApproval.locator('[data-decision="approve"]').hover();
  await vpage.waitForTimeout(500);
  await vApproval.locator('[data-decision="approve"]').click();
  await vpage.getByText(/ideas are in the table above/).waitFor({ timeout: 120000 });
  await vpage.locator('section[aria-label^="research_keywords:"]').scrollIntoViewIfNeeded();
  await vpage.waitForTimeout(2500);
  await vctx.close();
  const vids = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (vids[0]) renameSync(path.join(videoDir, vids[0]), path.join(SHOTS, "approve-in-place-flow-light-en.webm"));
  ok("video of the approve-in-place flow saved", vids.length === 1);

  ok("no page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  ok("the mock model was used (no real model call)", toolCallsSeen > 0 && model.requests.length > 0, `${model.requests.length} mock requests`);
  await browser.close();
} catch (err) {
  ok("demo ran to the end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(0, 4).join("\n")}` : String(err));
} finally {
  await stopServer();
  await model.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}
