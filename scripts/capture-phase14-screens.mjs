// Marketr — Phase 14 final verification screenshots (desktop SaaS only,
// 1440x900). Tico: "I want to see the saas."
//
// Captures:
//   1. actions-desktop.png        — /dashboard/actions (connections + approval queue)
//   2. approvals-desktop.png      — /dashboard/approvals (mission approvals inbox)
//   3. office-sheet-desktop.png   — live Univer sheet (deep-linked)
//   4. office-doc-desktop.png     — Univer doc view (deep-linked)
//   5. office-slide-desktop.png   — Univer slide surface (deep-linked)
//   6. prospects-sheet-desktop.png— "Open in Sheets" flow: prospects -> sheet in office
//   7. usage-desktop.png          — Settings -> Usage (credit pool + Composio card)
//
// Run: node scripts/capture-phase14-screens.mjs
// Credentials parsed literally from the preview .env (never sourced).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v;
const env = Object.fromEntries(
  fs.readFileSync('/home/hatch/workspace/marketr/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())]; })
);
const EMAIL = env.ADMIN_EMAIL;
const PASSWORD = env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('missing ADMIN_EMAIL/ADMIN_PASSWORD in .env'); process.exit(1); }

const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews/sweep/phase14';
fs.mkdirSync(out, { recursive: true });

// Seed the demo docs; the script prints { sheet, doc, slide } ids.
const seedJson = execSync('npx tsx scripts/seed-phase14-demo-docs.mts', { cwd: '/home/hatch/workspace/marketr', encoding: 'utf8' });
const ids = JSON.parse(seedJson.trim().split('\n').pop());
console.log('demo docs:', ids);

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, url, name, wait) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`${name} http:${res ? res.status() : 'n/a'}`);
  if (wait) await wait(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}`, fullPage: false });
  console.log('captured', name);
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);

  await shot(page, 'http://localhost:3000/dashboard/actions', 'actions-desktop.png');
  await shot(page, 'http://localhost:3000/dashboard/approvals', 'approvals-desktop.png');

  const canvasWait = async (p) => {
    await p.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(4000);
  };
  await shot(page, `http://localhost:3000/dashboard/office?open=${ids.sheet}`, 'office-sheet-desktop.png', canvasWait);
  await shot(page, `http://localhost:3000/dashboard/office?open=${ids.doc}`, 'office-doc-desktop.png', canvasWait);
  await shot(page, `http://localhost:3000/dashboard/office?open=${ids.slide}`, 'office-slide-desktop.png', canvasWait);

  // "Open in Sheets" flow: prospects page -> click the button -> lands in office.
  await page.goto('http://localhost:3000/dashboard/prospects', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const btn = page.getByRole('button', { name: /open (in|as) sheets?/i }).first();
  if (await btn.count()) {
    await Promise.all([
      page.waitForURL(/dashboard\/office\?open=/, { timeout: 15000 }),
      btn.click(),
    ]);
    await canvasWait(page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/prospects-sheet-desktop.png`, fullPage: false });
    console.log('captured prospects-sheet-desktop.png');
  } else {
    console.log('WARN: no Open in Sheets button found on prospects page');
  }

  await shot(page, 'http://localhost:3000/dashboard/settings/usage', 'usage-desktop.png', async (p) => {
    await p.waitForTimeout(3000);
  });

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
