// Marketr — Phase 11 follow-up: batch + share modals (desktop only).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v;
const env = Object.fromEntries(
  fs.readFileSync('/home/hatch/workspace/marketr/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())]; })
);
const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews/sweep/phase11';

async function main() {
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', env.ADMIN_EMAIL);
  await page.fill('input[placeholder="Password"]', env.ADMIN_PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  await page.goto('http://localhost:3000/dashboard/studio/designs/cmujrhbzp0003zsiub9qe8bd7', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Ensure no dropdown is open: click canvas, then Escape twice.
  await page.mouse.click(500, 450);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  try {
    await page.getByRole('button', { name: 'Batch', exact: true }).click({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/p11-06-batch-modal.png` });
    console.log('captured p11-06-batch-modal');
  } catch (e) { console.log('FAILED batch:', e.message.slice(0, 100)); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  try {
    await page.getByRole('button', { name: 'Share', exact: true }).click({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/p11-07-share-modal.png` });
    console.log('captured p11-07-share-modal');
  } catch (e) { console.log('FAILED share:', e.message.slice(0, 100)); }

  await browser.close();
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
