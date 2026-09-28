// Marketr — Phase 13C clipper verification screenshots (desktop only).
// Run: node scripts/capture-phase13c-screens.mjs
// Seed first: npx tsx scripts/seed-phase13c-shots.mts
// Clean after: npx tsx scripts/seed-phase13c-shots.mts --clean
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v.slice(0);
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase13c';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, name, action) {
  try {
    await action();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`captured ${name}`);
  } catch (e) {
    console.log(`FAILED ${name}: ${e.message.slice(0, 140)}`);
    try { await page.screenshot({ path: `${out}/${name}-error.png`, fullPage: false }); } catch {}
  }
}

async function clickTab(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(900);
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

  await login(page);

  // 1. Clips module — Sources tab (seeded source row)
  await shot(page, 'v13c-01-clips-sources', async () => {
    await page.goto('http://localhost:3000/dashboard/clips', { waitUntil: 'networkidle', timeout: 30000 });
  });

  // 2. Clips tab — 4 seeded clips with virality scores + statuses
  await shot(page, 'v13c-02-clips-table', async () => { await clickTab(page, 'Clips'); });

  // 3. Jobs tab — finished generate job
  await shot(page, 'v13c-03-clips-jobs', async () => { await clickTab(page, 'Jobs'); });

  // 4. New source dialog (upload/URL flow)
  await shot(page, 'v13c-04-new-source-dialog', async () => {
    await clickTab(page, 'Sources');
    await page.getByRole('button', { name: /new source/i }).click();
    await page.waitForTimeout(600);
  });

  console.log(`pageerrors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('  PAGEERROR:', e);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
