// Marketr — Knowledge Brain orbs + particle-morph verification screenshots.
// Run: node scripts/capture-brain-orbs-screens.mjs
// Credentials parsed literally from the preview .env (never sourced).
// WebGL/WebGPU in headless-shell run via SwiftShader.
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
const out = '/home/hatch/workspace/marketr/previews/sweep/brain-orbs';
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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-unsafe-webgpu'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message).slice(0, 200)}`));

  await login(page);

  const res = await page.goto('http://localhost:3000/dashboard/intelligence/corpus/brain', { waitUntil: 'networkidle' });
  console.log(`brain page http:${res ? res.status() : 'n/a'}`);

  await page.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});

  // Probe WebGPU (drives the orb farm) and WebGL.
  const caps = await page.evaluate(async () => {
    const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    let adapter = false;
    if (webgpu) {
      try { adapter = !!(await navigator.gpu.requestAdapter()); } catch { adapter = false; }
    }
    return { webgpu, adapter };
  });
  console.log(`webgpu: ${JSON.stringify(caps)}`);

  // Let bloom, orb farm texture, and breathing settle. SwiftShader is slow.
  await page.waitForTimeout(60000);
  await page.screenshot({ path: `${out}/brain-orbs-galaxy-desktop.png`, fullPage: false });
  console.log('captured brain-orbs-galaxy-desktop.png');

  // Trigger a manual morph and catch it mid-flight (~1s into the 1.8s tween).
  const morphBtn = page.getByRole('button', { name: /Morph field|Morphing/ });
  if (await morphBtn.count()) {
    await morphBtn.first().click();
    await page.waitForTimeout(1100);
    await page.screenshot({ path: `${out}/brain-orbs-morph-desktop.png`, fullPage: false });
    console.log('captured brain-orbs-morph-desktop.png');
  } else {
    console.log('morph button not found');
  }

  console.log(`errors(${errors.length}):`);
  errors.slice(0, 15).forEach((e) => console.log(`  ${e}`));
  await browser.close();
}

main().catch((e) => { console.error('capture failed:', e.message); process.exit(1); });
