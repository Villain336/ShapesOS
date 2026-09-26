// Marketr — Knowledge Brain verification screenshots (desktop only).
// Run: node scripts/capture-brain-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/brain';
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

  const res = await page.goto('http://localhost:3000/dashboard/intelligence/corpus/brain', { waitUntil: 'networkidle' });
  console.log(`brain page http:${res ? res.status() : 'n/a'}`);
  // Wait for the graph to load and the force layout to settle.
  await page.waitForSelector('canvas', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/brain-desktop.png`, fullPage: false });
  console.log('captured brain-desktop.png');

  // Click actual neurons until the detail panel opens (node positions are
  // deterministic for this corpus; candidates read from a prior capture).
  const candidates = [
    [875, 370], // Scientific Advertising (growth)
    [735, 375], // My Life in Advertising (marketing)
    [520, 280], // large marketing neuron, top cluster
    [930, 245], // growth neuron, top right
  ];
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(900);
    const opened = await page.getByText("What Marketr learned").count();
    if (opened > 0) break;
  }
  await page.screenshot({ path: `${out}/brain-detail-desktop.png`, fullPage: false });
  console.log('captured brain-detail-desktop.png');
  await browser.close();
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
