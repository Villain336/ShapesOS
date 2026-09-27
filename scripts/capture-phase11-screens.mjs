// Marketr — Phase 11 seven-feature verification screenshots (desktop only).
// Run: node scripts/capture-phase11-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase11';
fs.mkdirSync(out, { recursive: true });

const DESIGN_ID = 'cmujrhbzp0003zsiub9qe8bd7';
const EDITOR = `http://localhost:3000/dashboard/studio/designs/${DESIGN_ID}`;

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, name, fn) {
  try {
    await fn();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`captured ${name}`);
  } catch (e) {
    console.log(`FAILED ${name}: ${e.message.slice(0, 120)}`);
    try { await page.screenshot({ path: `${out}/${name}-error.png`, fullPage: false }); } catch {}
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await page.goto(EDITOR, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 1. Editor overview
  await shot(page, 'p11-01-editor-overview', async () => {});

  // 2. Elements panel -> add bar chart + QR
  await shot(page, 'p11-02-chart-qr-canvas', async () => {
    await page.getByRole('button', { name: 'Elements' }).click();
    await page.waitForTimeout(800);
    await page.getByTitle('Insert Bar chart').click();
    await page.waitForTimeout(500);
    await page.getByTitle('Insert QR code').click();
    await page.waitForTimeout(500);
    // click canvas center to deselect
    await page.mouse.click(720, 500);
  });

  // 3. Select the chart -> chart editor in toolbar
  await shot(page, 'p11-03-chart-editor', async () => {
    // select chart via elements list is unreliable; click roughly where chart was placed
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  // 4. Export dropdown (SVG option)
  await shot(page, 'p11-04-export-svg', async () => {
    await page.getByRole('button', { name: /Export/i }).click();
    await page.waitForTimeout(600);
  });
  await page.keyboard.press('Escape');

  // 5. Magic resize dropdown
  await shot(page, 'p11-05-magic-resize', async () => {
    const btn = page.getByTitle(/Magic resize/);
    await btn.click();
    await page.waitForTimeout(600);
  });
  await page.keyboard.press('Escape');

  // 6. Batch modal
  await shot(page, 'p11-06-batch-modal', async () => {
    await page.getByTitle(/Batch generate/).click();
    await page.waitForTimeout(800);
  });
  await page.keyboard.press('Escape');

  // 7. Share modal
  await shot(page, 'p11-07-share-modal', async () => {
    await page.getByTitle(/Share links/).click();
    await page.waitForTimeout(800);
  });
  await page.keyboard.press('Escape');

  // 8. Comments rail tab
  await shot(page, 'p11-08-comments-panel', async () => {
    await page.getByRole('button', { name: 'Comments' }).click();
    await page.waitForTimeout(800);
  });

  // 9. Photos (Unsplash) rail tab — honest missing-key state
  await shot(page, 'p11-09-unsplash-panel', async () => {
    await page.getByRole('button', { name: 'Photos' }).click();
    await page.waitForTimeout(1000);
  });

  // 10. Rich text: select a text element -> Text panel shows fragment controls
  await shot(page, 'p11-10-rich-text', async () => {
    await page.getByRole('button', { name: 'Text' }).click();
    await page.waitForTimeout(800);
  });

  // 11. Public share page (no login needed)
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pub = await ctx2.newPage();
  const token = fs.readFileSync('/tmp/live-share-token.txt', 'utf8').trim();
  await shot(pub, 'p11-11-public-share', async () => {
    await pub.goto(`http://localhost:3000/s/${token}`, { waitUntil: 'networkidle' });
    await pub.waitForTimeout(2000);
  });

  await browser.close();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
