// ShapesOS — Phase 9 live smoke: Webflow (lib/connectors/webflow.ts), read-only.
// Run: LIVE_WEBFLOW_TOKEN=… [LIVE_WEBFLOW_SITE_ID=…] npx tsx scripts/live/webflow.mts
import { WebflowConnector } from "@/lib/connectors/webflow";
import { finish, needEnv, optEnv, step } from "./_lib";

const env = needEnv("webflow", ["LIVE_WEBFLOW_TOKEN"]);
if (!env) process.exit(0);
const wf = new WebflowConnector({ token: env.LIVE_WEBFLOW_TOKEN, siteId: optEnv("LIVE_WEBFLOW_SITE_ID"), demo: false });
console.log("webflow");
await step("token (test)", () => wf.test(), (r) => r.info);
await step("list sites", () => wf.listSites(), (l) => `${l.length} sites`);
if (optEnv("LIVE_WEBFLOW_SITE_ID")) await step("list pages", () => wf.listContent("page"), (l) => `${l.length} pages`);
finish("webflow");
