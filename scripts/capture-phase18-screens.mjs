// Marketr — Phase 18 final verification screenshots (desktop, 1440x900).
//
// Captures (all demo data seeded by scripts/seed-phase18-demo-ads.mts):
//   1. 01-ad-hub.png          — /dashboard/media/advertising (Amazon + StackAdapt
//                               connectable, Walmart Connect + Spotify "Coming soon")
//   2. 02-proposal-inbox.png  — /dashboard/media/advertising/proposals (filters,
//                               pending/approved/rejected lineage)
//   3. 03-unified-reports.png — /dashboard/media/advertising/reports (cross-platform
//                               spend/revenue/ROAS)
//
// Run: node scripts/capture-phase18-screens.mjs
// Credentials parsed literally from the preview .env (never sourced).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v;
const env = Object.fromEntries(
  fs.readFileSync('/home/hatch/workspace/marketr/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())]; }),
);
const EMAIL = env.ADMIN_EMAIL;
const PASSWORD = env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('missing ADMIN_EMAIL/ADMIN_PASSWORD in .env'); process.exit(1); }

const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/your_files/phase18-verification';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, url, name) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`${name} http:${res ? res.status() : 'n/a'}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}`, fullPage: false });
  console.log('captured', name);
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  console.log('logged in');
  await shot(page, 'http://localhost:3000/dashboard/media/advertising', '01-ad-hub.png');
  await shot(page, 'http://localhost:3000/dashboard/media/advertising/proposals', '02-proposal-inbox.png');
  await shot(page, 'http://localhost:3000/dashboard/media/advertising/reports', '03-unified-reports.png');
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
