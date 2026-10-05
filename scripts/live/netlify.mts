// ShapesOS — Phase 9 live smoke: Netlify (lib/deploy/netlify.ts).
// Run: LIVE_NETLIFY_TOKEN=… [LIVE_NETLIFY_SITE_ID=…] [LIVE_DEPLOY_WRITE=1] npx tsx scripts/live/netlify.mts
import { buildDeployTarget } from "@/lib/deploy";
import { finish, needEnv, optEnv } from "./_lib";
import { deployFlow } from "./_deploy";

const env = needEnv("netlify", ["LIVE_NETLIFY_TOKEN"]);
if (!env) process.exit(0);
console.log("netlify");
const t = buildDeployTarget("netlify", { token: env.LIVE_NETLIFY_TOKEN, siteId: optEnv("LIVE_NETLIFY_SITE_ID"), demo: false });
await deployFlow(t, "shapesos-live-smoke");
finish("netlify");
