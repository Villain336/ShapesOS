// ShapesOS — Phase 9 live smoke: GitHub (lib/connectors/github.ts), read-only.
// Run: LIVE_GITHUB_TOKEN=… LIVE_GITHUB_REPO=owner/name npx tsx scripts/live/github.mts
import { GitHubSiteFileProvider } from "@/lib/connectors/github";
import { finish, needEnv, optEnv, step } from "./_lib";

const env = needEnv("github", ["LIVE_GITHUB_TOKEN", "LIVE_GITHUB_REPO"]);
if (!env) process.exit(0);
const [owner, repo] = env.LIVE_GITHUB_REPO.split("/");
if (!owner || !repo) {
  console.log("FAIL github — LIVE_GITHUB_REPO must be owner/name");
  process.exit(1);
}
const gh = new GitHubSiteFileProvider({ token: env.LIVE_GITHUB_TOKEN, owner, repo, branch: optEnv("LIVE_GITHUB_BRANCH", "main"), demo: false });
console.log(`github: ${owner}/${repo}`);
await step("token + repo access (test)", () => gh.test(), (r) => r.message);
await step("getRepo", () => gh.getRepo(), (r) => `default branch ${r.defaultBranch}, private=${r.private}`);
await step("listDir /", () => gh.listDir("/"), (l) => `${l.length} entries`);
finish("github");
