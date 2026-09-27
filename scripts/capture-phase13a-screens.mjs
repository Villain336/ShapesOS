// Marketr — Phase 13 Wave A verification screenshots (desktop only).
// Run: node scripts/capture-phase13a-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase13a';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, name, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`captured ${name}`);
  } catch (e) {
    console.log(`FAILED ${name}: ${e.message.slice(0, 140)}`);
    try { await page.screenshot({ path: `${out}/${name}-error.png`, fullPage: false }); } catch {}
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

  // 1. Root marketing/login page (no auth)
  await shot(page, 'v13a-01-root-landing', 'http://localhost:3000/');

  await login(page);

  // 2. Overview (renamed home) — sidebar shows "Assistant", "Overview"
  await shot(page, 'v13a-02-overview', 'http://localhost:3000/dashboard');
  // 3. Settings landing (was 404)
  await shot(page, 'v13a-03-settings-landing', 'http://localhost:3000/dashboard/settings');
  // 4. Brand kits (theming live preview)
  await shot(page, 'v13a-04-brand-kits', 'http://localhost:3000/dashboard/settings/brand-kits');
  // 5. White-label ops
  await shot(page, 'v13a-05-white-label', 'http://localhost:3000/dashboard/settings/white-label');
  // 6. Billing hub
  await shot(page, 'v13a-06-billing', 'http://localhost:3000/dashboard/billing');
  // 7. Studio (Canva tab gone)
  await shot(page, 'v13a-07-studio', 'http://localhost:3000/dashboard/studio');

  console.log(`pageerrors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('  PAGEERROR:', e);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
