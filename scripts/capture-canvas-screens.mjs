// Marketr Phase 11 "Canvas" verification screenshots (desktop only).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v;
const env = Object.fromEntries(fs.readFileSync('/home/hatch/workspace/marketr/.env', 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())]; }));
const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews/sweep/canvas';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);
await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
await page.fill('input[placeholder="Email"]', env.ADMIN_EMAIL);
await page.fill('input[placeholder="Password"]', env.ADMIN_PASSWORD);
await page.click('form button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 15000 });
// Create a design from the instagram-post template via API (cookies included).
const created = await page.evaluate(async () => {
  const r = await fetch('/api/studio/designs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Phase 11 demo design', templateKey: 'instagram-post' }) });
  return { status: r.status, body: await r.json() };
});
console.log('create design:', created.status, created.body?.design?.id ?? JSON.stringify(created.body).slice(0, 200));
const id = created.body?.design?.id;
if (!id) { console.error('NO DESIGN ID'); process.exit(1); }
async function snap(path) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('captured', path.split('/').pop());
}
// Editor with designed template.
await page.goto(`http://localhost:3000/dashboard/studio/designs/${id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => console.log('no canvas found'));
await page.waitForTimeout(12000);
await snap(`${out}/canvas-v1-editor-desktop.png`);
// Open Templates panel.
const tplBtn = page.getByRole('button', { name: /templates/i });
if (await tplBtn.count() > 0) { await tplBtn.first().click(); await page.waitForTimeout(2500); }
await snap(`${out}/canvas-v1-templates-desktop.png`);
// Studio Designs tab (dense table).
await page.goto('http://localhost:3000/dashboard/studio', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);
const tab = page.getByRole('button', { name: /^designs$/i });
if (await tab.count() > 0) { await tab.first().click(); await page.waitForTimeout(3000); }
await snap(`${out}/canvas-v1-designs-tab-desktop.png`);
if (errs.length) { console.log('PAGE ERRORS:'); errs.slice(0, 8).forEach((e) => console.log(' -', e)); } else console.log('no page errors');
await browser.close();
