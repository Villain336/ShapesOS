// Prints the JSON to paste into the Secrets Manager secret shapesos/<group>:
// every key the owner provides, empty. Fill in what you use; empty keys are
// ignored at start (scripts/deploy/runtime-env.mjs).
//   npm run secret-skeleton -- shared|web|worker
import { readConfig } from "../lib/config.ts";
import { awsEnvPlan, secretSkeleton, type Group } from "../lib/env-plan.ts";

const group = process.argv[2] as Group;
if (!["shared", "web", "worker"].includes(group)) {
  console.error("usage: npm run secret-skeleton -- shared|web|worker");
  process.exit(2);
}
const plan = awsEnvPlan(readConfig(() => undefined), { filesBucketName: "<files bucket>" });
console.log(JSON.stringify(secretSkeleton(plan, group), null, 2));
