import { chromium } from 'playwright-core';

const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews';

async function capture(device) {
  const isMobile = device === 'iphone';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const context = await browser.newContext(
    isMobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
      : { viewport: { width: 1440, height: 900 } }
  );
  const page = await context.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', 'admin@marketr.local');
  await page.fill('input[placeholder="Password"]', 'preview-demo-2026');
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard|attribution/, { timeout: 15000 });
  await page.goto('http://localhost:3000/dashboard/attribution', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // scroll to the measurement bundles section
  const section = page.locator('text=Measurement bundles').first();
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  if (isMobile) await page.evaluate(() => window.scrollBy(0, 260));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/physical-attribution-${device}.png`, fullPage: false });
  await browser.close();
  console.log(`captured ${device}`);
}

const which = process.argv[2] || 'desktop';
await capture(which).catch((e) => { console.error('FAILED', e.message); process.exit(1); });
