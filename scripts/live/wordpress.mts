// ShapesOS — Phase 9 live smoke: WordPress (lib/connectors/wordpress.ts), read-only.
// Run: LIVE_WORDPRESS_URL=https://… LIVE_WORDPRESS_USER=… LIVE_WORDPRESS_APP_PASSWORD=… npx tsx scripts/live/wordpress.mts
import { WordPressConnector } from "@/lib/connectors/wordpress";
import { finish, needEnv, step } from "./_lib";

const env = needEnv("wordpress", ["LIVE_WORDPRESS_URL", "LIVE_WORDPRESS_USER", "LIVE_WORDPRESS_APP_PASSWORD"]);
if (!env) process.exit(0);
console.log(`wordpress: ${new URL(env.LIVE_WORDPRESS_URL).host}`);
const wp = await step("SSRF-validated connector (create)", () =>
  WordPressConnector.create({ baseUrl: env.LIVE_WORDPRESS_URL, username: env.LIVE_WORDPRESS_USER, appPassword: env.LIVE_WORDPRESS_APP_PASSWORD, demo: false }),
);
if (wp) {
  await step("credentials (test)", () => wp.test(), (r) => r.info);
  await step("list posts", () => wp.listContent("post"), (l) => `${l.length} posts`);
  await step("list pages", () => wp.listContent("page"), (l) => `${l.length} pages`);
}
finish("wordpress");
