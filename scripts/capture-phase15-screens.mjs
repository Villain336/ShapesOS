// Marketr — Phase 15 final verification screenshots (desktop SaaS only,
// 1440x900). Tico: "I want to see the saas."
//
// Captures:
//   1. toolkits-desktop.png  — Actions → Toolkits directory (full firehose)
//   2. approvals-desktop.png — Actions → Approvals queue
//   3. activity-desktop.png  — Actions → Activity (budget panel + drift panel)
//
// Run: node scripts/capture-phase15-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase15';
fs.mkdirSync(out, { recursive: true });

// Seed the drift demo; prints { added, removed, renamed, rowsWritten }.
try {
  const seedJson = execSync('npx tsx scripts/seed-phase15-drift-demo.mts', { cwd: '/home/hatch/workspace/marketr', encoding: 'utf8' });
  console.log('drift demo:', seedJson.trim().split('\n').pop());
} catch (e) {
  console.log('WARN: drift seed failed, continuing with empty state');
}

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shotTab(page, tabName, file) {
  await page.goto('http://localhost:3000/dashboard/actions', { waitUntil: 'domcontentloaded' });
  const tab = page.getByRole('button', { name: new RegExp(`^${tabName}`) }).first();
  await tab.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/${file}`, fullPage: false });
  console.log('captured', file);
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);

  await shotTab(page, 'Toolkits', 'toolkits-desktop.png');
  await shotTab(page, 'Approvals', 'approvals-desktop.png');
  await shotTab(page, 'Activity', 'activity-desktop.png');

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
