// Marketr — full-SaaS screenshot sweep (capture only, no code changes).
// Run: node scripts/capture-full-sweep.mjs
// Captures every dashboard route at desktop (1440x900) and iPhone (390x844).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const stripQuotes = (v) => (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) ? v.slice(1, -1) : v;
const env = Object.fromEntries(
  fs.readFileSync('/home/hatch/workspace/marketr/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())]; })
);
const EMAIL = env.ADMIN_EMAIL, PASSWORD = env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error('missing creds'); process.exit(1); }

const PID = 'cmuhk2qk4001vzse5bm7gylf9';       // project
const POOL = 'cmughl2dv976e1121bf0fc5fd';      // budget pool
const APPR = 'cmugiiioj0005zst9a5u1us09';      // media approval
const OUTR = 'cmugm37621a4ff1c5a35c00cf';     // outreach campaign
const SCAMP = 'cmuhk2qkr0025zse5ifwg7orq';     // substrate campaign

// [route, slug]
const ROUTES = [
  // core
  ['/dashboard', 'dashboard-root'],
  ['/dashboard/alerts', 'alerts'],
  ['/dashboard/assistant', 'assistant'],
  ['/dashboard/attribution', 'attribution'],
  ['/dashboard/calls', 'calls'],
  ['/dashboard/crm', 'crm'],
  ['/dashboard/files', 'files'],
  ['/dashboard/nurture', 'nurture'],
  ['/dashboard/prospects', 'prospects'],
  ['/dashboard/reports', 'reports'],
  ['/dashboard/reviews', 'reviews'],
  // projects
  [`/dashboard/projects/${PID}`, 'projects-overview'],
  [`/dashboard/projects/${PID}/ads`, 'projects-ads'],
  [`/dashboard/projects/${PID}/ai-search`, 'projects-ai-search'],
  [`/dashboard/projects/${PID}/automations`, 'projects-automations'],
  [`/dashboard/projects/${PID}/automations/schedules`, 'projects-schedules'],
  [`/dashboard/projects/${PID}/automations/schedules/new`, 'projects-schedules-new'],
  [`/dashboard/projects/${PID}/autopilot`, 'projects-autopilot'],
  [`/dashboard/projects/${PID}/backlinks`, 'projects-backlinks'],
  [`/dashboard/projects/${PID}/chat`, 'projects-chat'],
  [`/dashboard/projects/${PID}/competitors`, 'projects-competitors'],
  [`/dashboard/projects/${PID}/content`, 'projects-content'],
  [`/dashboard/projects/${PID}/decay`, 'projects-decay'],
  [`/dashboard/projects/${PID}/ide`, 'projects-ide'],
  [`/dashboard/projects/${PID}/internal-links`, 'projects-internal-links'],
  [`/dashboard/projects/${PID}/keywords`, 'projects-keywords'],
  [`/dashboard/projects/${PID}/local`, 'projects-local'],
  [`/dashboard/projects/${PID}/newsletter`, 'projects-newsletter'],
  [`/dashboard/projects/${PID}/programmatic`, 'projects-programmatic'],
  [`/dashboard/projects/${PID}/radar`, 'projects-radar'],
  [`/dashboard/projects/${PID}/rankings`, 'projects-rankings'],
  [`/dashboard/projects/${PID}/sites`, 'projects-sites'],
  [`/dashboard/projects/${PID}/sites/new`, 'projects-sites-new'],
  [`/dashboard/projects/${PID}/social`, 'projects-social'],
  [`/dashboard/projects/${PID}/studio`, 'projects-studio'],
  [`/dashboard/projects/${PID}/settings`, 'projects-settings'],
  [`/dashboard/projects/${PID}/settings/automation`, 'projects-settings-automation'],
  [`/dashboard/projects/${PID}/settings/data`, 'projects-settings-data'],
  [`/dashboard/projects/${PID}/settings/files`, 'projects-settings-files'],
  [`/dashboard/projects/${PID}/settings/general`, 'projects-settings-general'],
  [`/dashboard/projects/${PID}/settings/publishing`, 'projects-settings-publishing'],
  [`/dashboard/projects/${PID}/settings/skills`, 'projects-settings-skills'],
  // studio
  ['/dashboard/studio', 'studio'],
  // mail
  ['/dashboard/direct-mail', 'mail'],
  ['/dashboard/direct-mail/eddm', 'mail-eddm'],
  ['/dashboard/direct-mail/reconciliation', 'mail-reconciliation'],
  // media
  ['/dashboard/media', 'media'],
  [`/dashboard/media/approvals/${APPR}`, 'media-approvals-id'],
  ['/dashboard/media/attribution', 'media-attribution'],
  ['/dashboard/media/audio', 'media-audio'],
  ['/dashboard/media/dooh', 'media-dooh'],
  ['/dashboard/media/pools', 'media-pools'],
  [`/dashboard/media/pools/${POOL}`, 'media-pools-id'],
  ['/dashboard/media/radio-print', 'media-radio-print'],
  ['/dashboard/media/reconciliation', 'media-reconciliation'],
  // authority
  ['/dashboard/authority', 'authority'],
  ['/dashboard/authority/aeo', 'authority-aeo'],
  ['/dashboard/authority/intelligence', 'authority-intelligence'],
  ['/dashboard/authority/listings', 'authority-listings'],
  ['/dashboard/authority/outreach', 'authority-outreach'],
  [`/dashboard/authority/outreach/campaigns/${OUTR}`, 'authority-outreach-id'],
  ['/dashboard/authority/reviews', 'authority-reviews'],
  // flywheel
  ['/dashboard/flywheel', 'flywheel'],
  ['/dashboard/flywheel/ctv', 'flywheel-ctv'],
  ['/dashboard/flywheel/dsp', 'flywheel-dsp'],
  ['/dashboard/flywheel/launch', 'flywheel-launch'],
  ['/dashboard/flywheel/reallocation', 'flywheel-reallocation'],
  ['/dashboard/flywheel/recycling', 'flywheel-recycling'],
  ['/dashboard/flywheel/tests', 'flywheel-tests'],
  ['/dashboard/flywheel/tests/new', 'flywheel-tests-new'],
  // substrate
  ['/dashboard/substrate', 'substrate'],
  ['/dashboard/substrate/graph', 'substrate-graph'],
  ['/dashboard/substrate/graph/connectors', 'substrate-graph-connectors'],
  ['/dashboard/substrate/graph/er-queue', 'substrate-graph-er-queue'],
  ['/dashboard/substrate/campaigns', 'substrate-campaigns'],
  [`/dashboard/substrate/campaigns/${SCAMP}`, 'substrate-campaigns-id'],
  ['/dashboard/substrate/campaigns/new', 'substrate-campaigns-new'],
  ['/dashboard/substrate/campaigns/proposals', 'substrate-campaigns-proposals'],
  ['/dashboard/substrate/memory', 'substrate-memory'],
  ['/dashboard/substrate/memory/learnings', 'substrate-memory-learnings'],
  ['/dashboard/substrate/memory/playbook', 'substrate-memory-playbook'],
  ['/dashboard/substrate/memory/recall', 'substrate-memory-recall'],
  // settings
  ['/dashboard/settings/alerts', 'settings-alerts'],
  ['/dashboard/settings/api-mcp', 'settings-api-mcp'],
  ['/dashboard/settings/audit', 'settings-audit'],
  ['/dashboard/settings/brand-kits', 'settings-brand-kits'],
  ['/dashboard/settings/connectors', 'settings-connectors'],
  ['/dashboard/settings/defaults', 'settings-defaults'],
  ['/dashboard/settings/governance', 'settings-governance'],
  ['/dashboard/settings/mail', 'settings-mail'],
  ['/dashboard/settings/media', 'settings-media'],
  ['/dashboard/settings/members', 'settings-members'],
  ['/dashboard/settings/notifications', 'settings-notifications'],
  ['/dashboard/settings/providers', 'settings-providers'],
  ['/dashboard/settings/security', 'settings-security'],
  ['/dashboard/settings/skills', 'settings-skills'],
  ['/dashboard/settings/usage', 'settings-usage'],
];

const exe = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const out = '/home/hatch/workspace/marketr/previews/sweep';
fs.mkdirSync(out, { recursive: true });

async function login(page) {
  await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder="Email"]', { timeout: 20000 });
  await page.fill('input[placeholder="Email"]', EMAIL);
  await page.fill('input[placeholder="Password"]', PASSWORD);
  await page.click('form button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 20000 });
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
  let ok = 0, fail = [];
  for (const [path, slug] of ROUTES) {
    try {
      await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${out}/${slug}-${device}.png`, fullPage: false });
      ok++;
      // extra: graph view of the mind-map toggle
      if (slug === 'substrate-graph') {
        const toggle = page.getByRole('button', { name: /^Graph$/ });
        if (await toggle.count()) {
          await toggle.first().click();
          await page.waitForTimeout(2500);
          await page.screenshot({ path: `${out}/substrate-graph-view-${device}.png`, fullPage: false });
          console.log(`captured substrate-graph-view-${device} (mind-map)`);
        }
      }
    } catch (e) {
      fail.push(`${slug}: ${e.message.slice(0, 120)}`);
    }
  }
  await browser.close();
  console.log(`${device}: ${ok} captured, ${fail.length} failed`);
  for (const f of fail) console.log('FAIL', f);
}

await capture('desktop');
await capture('iphone');
