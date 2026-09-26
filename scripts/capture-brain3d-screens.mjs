// Marketr — Knowledge Brain 3D verification screenshots (desktop only).
// Run: node scripts/capture-brain3d-screens.mjs
// Credentials parsed literally from the preview .env (never sourced).
// WebGL in headless-shell runs via SwiftShader (--enable-unsafe-swiftshader).
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

  const res = await page.goto('http://localhost:3000/dashboard/intelligence/corpus/brain', { waitUntil: 'networkidle' });
  console.log(`brain page http:${res ? res.status() : 'n/a'}`);

  // Confirm the 3D view is the default and a WebGL canvas exists.
  await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
  const viewLabel = await page.getByText('Bead model', { exact: false }).count();
  console.log(`3d-legend visible: ${viewLabel > 0}`);

  // Let bloom, auto-rotation, and the breathing glow settle.
  await page.waitForTimeout(45000); // SwiftShader needs time to present the first frames
  await page.screenshot({ path: `${out}/brain3d-desktop.png`, fullPage: false });
  console.log('captured brain3d-desktop.png');

  // Search fly-to: type a query, click the first result → camera flies + detail panel opens.
  await page.fill('input[placeholder="Search sources…"]', 'hopkins');
  await page.waitForTimeout(800);
  const results = page.locator('button:has-text("Scientific Advertising")');
  const n = await results.count();
  console.log(`search results for hopkins: ${n}`);
  if (n > 0) {
    await results.first().click();
    await page.waitForTimeout(6000); // camera flight
  }
  const opened = await page.getByText('What Marketr learned').count();
  console.log(`detail panel opened: ${opened > 0}`);
  await page.screenshot({ path: `${out}/brain3d-detail-desktop.png`, fullPage: false });
  console.log('captured brain3d-detail-desktop.png');

  // 2D toggle still works.
  await page.getByRole('button', { name: '2D' }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/brain3d-2dtoggle-desktop.png`, fullPage: false });
  console.log('captured brain3d-2dtoggle-desktop.png');

  if (webglErrors.length) {
    console.log('WEBGL/PAGE ERRORS:');
    webglErrors.slice(0, 10).forEach((e) => console.log(' -', e));
  } else {
    console.log('no webgl/page errors');
  }
  await browser.close();
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
