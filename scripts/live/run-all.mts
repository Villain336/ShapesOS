// ShapesOS — Phase 9: run every opt-in live smoke test, one after another.
// Each SKIPS unless its LIVE_* keys are set; exit 1 when any check FAILED.
// Run: npx tsx scripts/live/run-all.mts   (CI: .github/workflows/live-smoke.yml)
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const only = (process.env.LIVE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const all = ["github", "wordpress", "webflow", "vercel", "cloudflare", "netlify", "anthropic"];
let failed = 0;
for (const name of all.filter((n) => !only.length || only.includes(n))) {
  const r = spawnSync("npx", ["tsx", join(here, `${name}.mts`)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) failed++;
}
console.log(failed ? `live smoke: ${failed} provider(s) failed` : "live smoke: no failures (skipped providers are listed above)");
process.exit(failed ? 1 : 0);
