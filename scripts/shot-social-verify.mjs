// Wave B Slice 1 UI verification: desktop screenshots of the single social entry.
// Reads admin credentials from .env at runtime (same pattern as the preview keeper).
// Usage: node scripts/shot-social-verify.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const OUT = fileURLToPath(new URL("../verify-shots/", import.meta.url));
mkdirSync(OUT, { recursive: true });

function envVal(name) {
  const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name}`);
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:3100/login", { waitUntil: "networkidle" });
await page.fill('input[type="email"], input[name="email"]', envVal("ADMIN_EMAIL"));
await page.fill('input[type="password"], input[name="password"]', envVal("ADMIN_PASSWORD"));
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard**", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);

// 1. The single social entry.
await page.goto("http://localhost:3100/dashboard/social", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + "social-entry-20260928.png" });

// 2. Project-specific social page redirects to /dashboard/social.
await page.goto("http://localhost:3100/dashboard/projects/demo-proj/social", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: OUT + "project-social-redirect-20260928.png" });
console.log("final url:", page.url());

await browser.close();
console.log("done");
