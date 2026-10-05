// ShapesOS — print a workspace's CallRail webhook secret.
//
//   CALLRAIL_WEBHOOK_SECRET=… npx tsx scripts/callrail-webhook-secret.mts <workspaceId>
//
// Each workspace's CallRail webhook signs with its own secret, derived from
// the host CALLRAIL_WEBHOOK_SECRET (lib/media/callrail.ts). Configure the
// printed URL + secret in that workspace's CallRail account.
import { callRailWorkspaceWebhookSecret } from "../lib/media/callrail";

const workspaceId = process.argv[2];
const host = process.env.CALLRAIL_WEBHOOK_SECRET;
if (!workspaceId || !host) {
  console.error("usage: CALLRAIL_WEBHOOK_SECRET=… npx tsx scripts/callrail-webhook-secret.mts <workspaceId>");
  process.exit(2);
}
const base = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? "https://<your-host>").replace(/\/$/, "");
console.log(`webhook URL: ${base}/api/webhooks/callrail?w=${encodeURIComponent(workspaceId)}`);
console.log(`secret:      ${callRailWorkspaceWebhookSecret(host, workspaceId)}`);
