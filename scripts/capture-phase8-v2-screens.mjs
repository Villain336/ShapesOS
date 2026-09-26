// Marketr — Phase 8 v2 demo screenshots (populated UI, house-pattern check).
// Run: node scripts/capture-phase8-v2-screens.mjs desktop|iphone
// Reads the seeded campaign id from /tmp/phase8-demo-ids.json (written by
// seed-demo-phase8.mts). Credentials from the preview .env at runtime.
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

const ids = JSON.parse(fs.readFileSync('/tmp/phase8-demo-ids.json', 'utf8'));
if (!ids.campaignId) { console.error('missing campaignId in /tmp/phase8-demo-ids.json'); process.exit(1); }

const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews';

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function capture(device) {
  const isMobile = device === 'iphone';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext(
    isMobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
      : { viewport: { width: 1440, height: 900 } }
  );
  const page = await context.newPage();
  await login(page);

  const shots = [
    [`/dashboard/substrate/graph`, `phase8-graph-${device}-v2`],
    [`/dashboard/substrate/campaigns/${ids.campaignId}`, `phase8-campaign-${device}-v2`],
    [`/dashboard/substrate/memory`, `phase8-memory-${device}-v2`],
  ];
  for (const [path, name] of shots) {
    await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
    console.log(`captured ${name}`);
  }
  await browser.close();
}

const which = process.argv[2] || 'desktop';
await capture(which).catch((e) => { console.error('FAILED', e.message); process.exit(1); });
