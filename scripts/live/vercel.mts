// ShapesOS — Phase 9 live smoke: Vercel (lib/deploy/vercel.ts).
// Run: LIVE_VERCEL_TOKEN=… [LIVE_VERCEL_TEAM_ID=…] [LIVE_VERCEL_PROJECT=…] [LIVE_DEPLOY_WRITE=1] npx tsx scripts/live/vercel.mts
import { buildDeployTarget } from "@/lib/deploy";
import { finish, needEnv, optEnv } from "./_lib";
import { deployFlow } from "./_deploy";

const env = needEnv("vercel", ["LIVE_VERCEL_TOKEN"]);
if (!env) process.exit(0);
console.log("vercel");
const t = buildDeployTarget("vercel", { token: env.LIVE_VERCEL_TOKEN, teamId: optEnv("LIVE_VERCEL_TEAM_ID"), projectId: optEnv("LIVE_VERCEL_PROJECT"), demo: false });
await deployFlow(t, optEnv("LIVE_VERCEL_PROJECT", "shapesos-live-smoke"));
finish("vercel");
