// Marketr — Phase 13D verification screenshots (desktop only).
// Run: node scripts/capture-phase13d-screens.mjs
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
const out = '/home/hatch/workspace/marketr/previews/sweep/phase13d';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function shot(page, name, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
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
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
  await login(page);
  await shot(page, 'v13d-01-voice-agents', 'http://localhost:3000/dashboard/voice');
  await shot(page, 'v13d-02-voice-sessions', 'http://localhost:3000/dashboard/voice/sessions');
  await shot(page, 'v13d-03-voice-scripts', 'http://localhost:3000/dashboard/voice/scripts');
  await shot(page, 'v13d-04-voice-consent', 'http://localhost:3000/dashboard/voice/consent');
  await shot(page, 'v13d-05-voice-studio', 'http://localhost:3000/dashboard/voice/studio');
  await shot(page, 'v13d-06-voice-pronunciation', 'http://localhost:3000/dashboard/voice/pronunciation');
  console.log('PAGE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
}
main();
