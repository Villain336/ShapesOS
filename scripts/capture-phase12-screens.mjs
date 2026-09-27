// Marketr — Phase 12 verification screenshots (desktop only, SaaS proof).
// Run: node scripts/capture-phase12-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase12';
fs.mkdirSync(out, { recursive: true });

const errors = [];
async function shot(page, name, url, act) {
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`${name}: http ${res ? res.status() : 'n/a'}`);
    await page.waitForTimeout(2500);
    if (act) await act(page);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`  captured ${name}.png`);
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    console.log(`  FAILED ${name}: ${e.message}`);
  }
}

async function clickTab(page, label) {
  const btn = page.getByRole('button', { name: label }).first();
  if (await btn.count()) { await btn.click(); return; }
  const link = page.getByText(label, { exact: true }).first();
  if (await link.count()) await link.click();
}

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 120)}`));

  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  console.log('logged in');

  // 1. Studio → Pages (GrapesJS surface)
  await shot(page, 'v12-01-studio-pages', 'http://localhost:3000/dashboard/studio/pages');

  // 2. Nurture → Broadcasts (Listmonk)
  await shot(page, 'v12-02-nurture-broadcasts', 'http://localhost:3000/dashboard/nurture',
    async (p) => { await clickTab(p, 'Broadcasts'); });

  // 3. Social (Postiz)
  await shot(page, 'v12-03-social-postiz', 'http://localhost:3000/dashboard/social');

  // 4. Analytics (Umami)
  await shot(page, 'v12-04-analytics-umami', 'http://localhost:3000/dashboard/analytics');

  // 5. Experiments (GrowthBook)
  await shot(page, 'v12-05-experiments', 'http://localhost:3000/dashboard/settings/experiments');

  // 6. Signing (Documenso)
  await shot(page, 'v12-06-signing', 'http://localhost:3000/dashboard/settings/signing');

  // 7. Repurpose (OpenNotebook-style)
  await shot(page, 'v12-07-repurpose', 'http://localhost:3000/dashboard/intelligence/repurpose');

  // 8. Providers (new Phase 12 provider cards)
  await shot(page, 'v12-08-providers', 'http://localhost:3000/dashboard/settings/providers');

  // 9. Missions list
  await shot(page, 'v12-09-missions', 'http://localhost:3000/dashboard/missions');

  // 10. Mission detail → Tasks tab (Plane). Click first mission row.
  try {
    await page.goto('http://localhost:3000/dashboard/missions', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const first = page.locator('a[href*="/dashboard/missions/"]').first();
    if (await first.count()) {
      await first.click();
      await page.waitForTimeout(2500);
      await clickTab(page, 'Tasks');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/v12-10-mission-tasks.png`, fullPage: false });
      console.log('  captured v12-10-mission-tasks.png');
    } else {
      console.log('  no missions found; skipping v12-10');
    }
  } catch (e) {
    errors.push(`v12-10: ${e.message}`);
    console.log(`  FAILED v12-10: ${e.message}`);
  }

  // 11. Payload admin (may have its own auth — capture whatever renders)
  await shot(page, 'v12-11-payload-admin', 'http://localhost:3000/admin');

  await browser.close();
  console.log(`\ndone. page errors: ${errors.length}`);
  errors.slice(0, 20).forEach((e) => console.log('  ERR:', e));
}

main().catch((e) => { console.error(e); process.exit(1); });
