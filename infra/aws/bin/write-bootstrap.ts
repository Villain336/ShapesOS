// Writes bootstrap/bootstrap.yaml: the GitHub OIDC roles as a standalone
// CloudFormation template (deployed once from CloudShell, before cdk bootstrap).
//   npm run bootstrap-template            write it
//   npm run bootstrap-template -- --check exit 1 if the committed file is stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapTemplateYaml } from "../lib/bootstrap-template.ts";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "bootstrap", "bootstrap.yaml");
const yaml = bootstrapTemplateYaml();
if (process.argv.includes("--check")) {
  if (readFileSync(file, "utf8") !== yaml) {
    console.error("bootstrap/bootstrap.yaml is stale: npm run bootstrap-template");
    process.exit(1);
  }
  console.log("bootstrap/bootstrap.yaml: up to date");
} else {
  writeFileSync(file, yaml);
  console.log(`wrote ${file}`);
}
