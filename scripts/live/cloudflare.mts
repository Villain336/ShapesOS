// ShapesOS — Phase 9 live smoke: Cloudflare Pages (lib/deploy/cloudflare.ts).
// Run: LIVE_CLOUDFLARE_TOKEN=… LIVE_CLOUDFLARE_ACCOUNT_ID=… [LIVE_CLOUDFLARE_PROJECT=…] [LIVE_DEPLOY_WRITE=1] npx tsx scripts/live/cloudflare.mts
import { buildDeployTarget } from "@/lib/deploy";
import { finish, needEnv, optEnv } from "./_lib";
import { deployFlow } from "./_deploy";

const env = needEnv("cloudflare", ["LIVE_CLOUDFLARE_TOKEN", "LIVE_CLOUDFLARE_ACCOUNT_ID"]);
if (!env) process.exit(0);
console.log("cloudflare pages");
const project = optEnv("LIVE_CLOUDFLARE_PROJECT", "shapesos-live-smoke");
const t = buildDeployTarget("cloudflare-pages", { token: env.LIVE_CLOUDFLARE_TOKEN, accountId: env.LIVE_CLOUDFLARE_ACCOUNT_ID, projectName: project, demo: false });
await deployFlow(t, project);
finish("cloudflare");
