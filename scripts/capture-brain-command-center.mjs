// Marketr — Knowledge Brain command-center verification screenshots (desktop only).
// Run: node scripts/capture-brain-command-center.mjs
// Fresh filenames (cache-busting rule: never reuse screenshot names).
// WebGL in headless-shell runs via SwiftShader (--enable-unsafe-swiftshader).
// Note: the 3D camera auto-orbits, so overview waits are kept short (~15s)
// to keep the lobe labels near their designed positions.
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
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const webglErrors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/webgl|WebGL/i.test(t) && /error|fail|not supported|lost/i.test(t)) webglErrors.push(t);
  });
  page.on('pageerror', (e) => webglErrors.push(`pageerror: ${e.message}`));

  await login(page);

  // 1 · Overview: fresh load, short wait (SwiftShader first frames + minimal orbit drift).
  await page.goto('http://localhost:3000/dashboard/intelligence/corpus/brain', { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
  await page.getByText('Chunk distribution by pillar').waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(15000);
  await page.screenshot({ path: `${out}/brain-command-center-v6-desktop.png`, fullPage: false });
  console.log('captured brain-command-center-v6-desktop.png');

  // 2 · Search fly-to: dossier opens with the strict section order.
  await page.fill('input[placeholder="Search sources…"]', 'hopkins');
  await page.waitForTimeout(800);
  const results = page.locator('button:has-text("Scientific Advertising")');
  if (await results.count() > 0) {
    await results.first().click();
    await page.waitForTimeout(8000); // camera flight
  }
  console.log(`dossier opened: ${await page.getByText('What Marketr learned').count() > 0}`);
  await page.screenshot({ path: `${out}/brain-command-center-v6-detail-desktop.png`, fullPage: false });
  console.log('captured brain-command-center-v6-detail-desktop.png');

  // 3 · Sources table: fresh load resets the camera, then scroll to the register rows.
  await page.goto('http://localhost:3000/dashboard/intelligence/corpus/brain', { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(15000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/brain-command-center-v7-table-desktop.png`, fullPage: false });
  console.log('captured brain-command-center-v7-table-desktop.png');

  if (webglErrors.length) console.log('WEBGL ISSUES:', webglErrors.slice(0, 5));
  else console.log('no webgl errors');
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
