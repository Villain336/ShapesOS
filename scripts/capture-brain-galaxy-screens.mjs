// Marketr — Knowledge Brain GALAXY verification screenshots (desktop only).
// Run: node scripts/capture-brain-galaxy-screens.mjs
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

  await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
  const legend = await page.getByText('Galaxy model', { exact: false }).count();
  console.log(`galaxy-legend visible: ${legend > 0}`);

  // Intro flight (~6.5s) + SwiftShader settle + sparkle bloom.
  await page.waitForTimeout(50000);
  await page.screenshot({ path: `${out}/brain-galaxy-overview-desktop.png`, fullPage: false });
  console.log('captured brain-galaxy-overview-desktop.png');

  // Cinematic tour: click the tour button, capture mid-tour (design cluster leg).
  const tourBtn = page.getByRole('button', { name: /Cinematic tour/ });
  if (await tourBtn.count() > 0) {
    await tourBtn.click();
    await page.waitForTimeout(9000); // ~2.4s fly + dwell into leg 2
    await page.screenshot({ path: `${out}/brain-galaxy-tour-desktop.png`, fullPage: false });
    console.log('captured brain-galaxy-tour-desktop.png');
    // Skip the rest of the tour.
    const skipBtn = page.getByRole('button', { name: /Skip tour/ });
    if (await skipBtn.count() > 0) await skipBtn.click();
    await page.waitForTimeout(3000);
  } else {
    console.log('tour button NOT found');
  }

  // Search fly-to: type a query, click the first result → camera flies + dossier opens.
  await page.fill('input[placeholder="Search sources…"]', 'hopkins');
  await page.waitForTimeout(800);
  const results = page.locator('button:has-text("Scientific Advertising")');
  const n = await results.count();
  console.log(`search results for hopkins: ${n}`);
  if (n > 0) {
    await results.first().click();
    await page.waitForTimeout(8000); // camera flight + settle
  }
  const opened = await page.getByText('What Marketr learned').count();
  console.log(`detail panel opened: ${opened > 0}`);
  await page.screenshot({ path: `${out}/brain-galaxy-detail-desktop.png`, fullPage: false });
  console.log('captured brain-galaxy-detail-desktop.png');

  if (webglErrors.length) {
    console.log('WEBGL/PAGE ERRORS:');
    webglErrors.slice(0, 10).forEach((e) => console.log(' -', e));
  } else {
    console.log('no webgl/page errors');
  }
  await browser.close();
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
