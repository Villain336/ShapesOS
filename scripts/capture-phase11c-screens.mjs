// Marketr — Phase 11c top-10 integrations verification screenshots (desktop only).
// Run: node scripts/capture-phase11c-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase11c';
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
    await page.waitForTimeout(1400);
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
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));
  await login(page);
  await page.goto(EDITOR, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // 1. Templates panel — 242 templates with search + categories
  await shot(page, 'v11c-01-templates-pack', async () => {
    await page.getByRole('button', { name: 'Templates' }).click();
    await page.waitForTimeout(800);
  });

  // 2. Icons panel — Iconify default search
  await shot(page, 'v11c-02-iconify', async () => {
    await page.getByRole('button', { name: 'Icons' }).click();
    await page.waitForTimeout(1200);
  });

  // 3. Text panel — curated font picker (Fontsource)
  await shot(page, 'v11c-03-font-picker', async () => {
    await page.getByRole('button', { name: 'Text' }).click();
    await page.waitForTimeout(800);
    const pickers = page.locator('button[aria-label="Font family"]');
    if (await pickers.count() > 0) { await pickers.first().click(); await page.waitForTimeout(800); }
  });
  await page.keyboard.press('Escape');

  // 4. Brand panel — Brandfetch autofill + palette generation
  await shot(page, 'v11c-04-brandfetch-palette', async () => {
    await page.getByRole('button', { name: 'Brand' }).click();
    await page.waitForTimeout(800);
  });

  // 5. 3D panel — Poly Haven stickers
  await shot(page, 'v11c-05-polyhaven-3d', async () => {
    await page.getByRole('button', { name: '3D' }).click();
    await page.waitForTimeout(1200);
  });

  // 6. Photos panel — Pexels/Pixabay providers
  await shot(page, 'v11c-06-stock-providers', async () => {
    await page.getByRole('button', { name: 'Photos' }).click();
    await page.waitForTimeout(1000);
  });

  // 7. Settings -> Providers (BYO keys)
  await shot(page, 'v11c-07-providers-settings', async () => {
    await page.goto('http://localhost:3000/dashboard/settings/providers', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  });

  console.log(`page errors: ${errors.length}`, errors.slice(0, 5));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
