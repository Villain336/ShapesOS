// Marketr — Phase 10 verification screenshots (desktop only).
// Run: node scripts/capture-phase10-screens.mjs
// Credentials parsed literally from the preview .env (never sourced).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase10';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);

  const shots = [
    ['/dashboard/intelligence/rank', 'phase10-rank-desktop'],
    ['/dashboard/intelligence/radar', 'phase10-radar-desktop'],
    ['/dashboard/intelligence/ai-visibility', 'phase10-ai-visibility-desktop'],
    ['/dashboard/intelligence/competitors', 'phase10-competitors-desktop'],
    ['/dashboard/intelligence/community', 'phase10-community-desktop'],
    ['/dashboard/intelligence/corpus', 'phase10-corpus-desktop'],
    ['/dashboard/intelligence/data-costs', 'phase10-data-costs-desktop'],
    ['/dashboard/intelligence/difficulty', 'phase10-difficulty-desktop'],
  ];
  for (const [path, name] of shots) {
    let status = 'ok';
    try {
      const res = await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle' });
      if (res) status = `http:${res.status()}`;
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    } catch (e) {
      status = `error:${e.message.slice(0, 80)}`;
      try { await page.screenshot({ path: `${out}/${name}.png`, fullPage: false }); } catch {}
    }
    console.log(`captured ${name} (${status})`);
  }
  await browser.close();
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
