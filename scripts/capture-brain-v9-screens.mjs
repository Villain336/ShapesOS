// Marketr — v9 Tier 1S synthesis verification screenshots (desktop only).
// Run: node scripts/capture-brain-v9-screens.mjs
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


async function snap(page, path) {
  // CDP capture: skips Playwright's font-ready wait, which stalls on this heavy page.
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('captured', path.split('/').pop());
}

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

  // Health strip (top of page) — shows the new Cataloged stat.
  await page.waitForTimeout(8000);
  await snap(page, `${out}/brain-v9-health-desktop.png`);

  // Galaxy with the expanded catalog (339 nodes).
  await page.waitForTimeout(45000);
  await snap(page, `${out}/brain-v9-galaxy-desktop.png`);

  // Source register with the new Status column.
  const table = page.getByText('Source register', { exact: false });
  if (await table.count() > 0) {
    await table.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await snap(page, `${out}/brain-v9-register-desktop.png`);
  } else {
    console.log('register heading NOT found');
  }

  if (webglErrors.length) {
    console.log('WEBGL/PAGE ERRORS:');
    webglErrors.slice(0, 10).forEach((e) => console.log(' -', e));
  } else {
    console.log('no webgl/page errors');
  }
  await browser.close();
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
