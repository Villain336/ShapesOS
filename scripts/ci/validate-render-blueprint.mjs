#!/usr/bin/env node
// ShapesOS — CI check for render.yaml (deploy PR).
//
//   (cd infra/aws && npm ci) && node scripts/ci/validate-render-blueprint.mjs [--live-schema]
//
// 1. render.yaml parses and validates against Render's published JSON schema
//    (https://render.com/schema/render.yaml.json, JSON Schema 2020-12; the
//    copy in infra/render/render.yaml.schema.json keeps CI offline and
//    deterministic). --live-schema also fetches the current schema, validates
//    against it and says whether the copy is out of date.
// 2. Repo-specific rules the schema can't know: images are this repo's GHCR
//    images with the registry credential, every env group / database a
//    service references exists, no env group sets `sync` (Render ignores it
//    there, https://render.com/docs/blueprint-spec#environment-groups), no key
//    is defined twice for one service, and the health check path, start
//    wrapper and migrate script exist in the repo.
// 3. The generated env-group section is fresh (scripts/deploy/render-env.mjs --check).
//
// Ajv and yaml come from infra/aws's own package (the root package gains no
// dependency); run `npm ci` there first.

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_URL = "https://render.com/schema/render.yaml.json";
const IMAGE_RE = /^ghcr\.io\/villain336\/shapesos-(runner|worker|migrate|backup):[A-Za-z0-9._-]+$/;
export const REGISTRY_CREDENTIAL = "ghcr-shapesos";

function loadDeps() {
  const req = createRequire(join(ROOT, "infra", "aws", "package.json"));
  try {
    const Ajv2020 = req("ajv/dist/2020").default;
    const YAML = req("yaml");
    return { Ajv2020, YAML };
  } catch {
    throw new Error("ajv/yaml not found: run `npm ci` in infra/aws first");
  }
}

/** Schema errors for a parsed Blueprint, [] when valid. */
export function schemaProblems(doc, schema, Ajv2020) {
  // strict: false — the published schema uses `deprecated` and other
  // annotations Ajv's strict mode rejects; validation keywords still apply.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(schema);
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`);
}

/** Repo-specific problems for a parsed Blueprint, [] when fine. */
export function semanticProblems(doc, repoRoot = ROOT) {
  const problems = [];
  const services = doc.services ?? [];
  const groups = new Map((doc.envVarGroups ?? []).map((g) => [g.name, g]));
  const databases = new Set((doc.databases ?? []).map((d) => d.name));

  for (const g of groups.values()) {
    for (const v of g.envVars ?? []) {
      if ("sync" in v) problems.push(`envVarGroups.${g.name}.${v.key}: sync is ignored inside env groups — paste the value instead`);
    }
  }
  const seenNames = new Set();
  for (const s of services) {
    const where = `services.${s.name}`;
    if (seenNames.has(s.name)) problems.push(`${where}: duplicate service name`);
    seenNames.add(s.name);
    if (s.runtime === "image") {
      if (!IMAGE_RE.test(s.image?.url ?? "")) problems.push(`${where}: image must be ghcr.io/villain336/shapesos-<target>:<tag>, got ${s.image?.url}`);
      if (s.image?.creds?.fromRegistryCreds?.name !== REGISTRY_CREDENTIAL) problems.push(`${where}: image.creds must use the ${REGISTRY_CREDENTIAL} registry credential`);
    }
    const keys = new Map();
    const note = (k, from) => {
      if (keys.has(k)) problems.push(`${where}: ${k} is set twice (${keys.get(k)} and ${from}); precedence between groups is not guaranteed`);
      else keys.set(k, from);
    };
    for (const v of s.envVars ?? []) {
      if (v.fromGroup) {
        const g = groups.get(v.fromGroup);
        if (!g) {
          problems.push(`${where}: env group ${v.fromGroup} is not defined in this Blueprint`);
          continue;
        }
        for (const gv of g.envVars ?? []) note(gv.key, `group ${g.name}`);
      } else {
        if (v.fromDatabase && !databases.has(v.fromDatabase.name)) problems.push(`${where}.${v.key}: database ${v.fromDatabase.name} is not defined`);
        note(v.key, "the service");
      }
    }
    if (s.type === "web") {
      const hc = s.healthCheckPath ?? "";
      const route = join(repoRoot, "app", ...hc.split("/").filter(Boolean), "route.ts");
      if (!hc) problems.push(`${where}: needs a healthCheckPath`);
      else if (!existsSync(route)) problems.push(`${where}: health check ${hc} has no route (${route.slice(repoRoot.length + 1)})`);
    }
    for (const m of (s.dockerCommand ?? "").matchAll(/\b(scripts\/[\w./-]+\.(?:sh|mjs|mts))\b/g)) {
      if (!existsSync(join(repoRoot, m[1]))) problems.push(`${where}: dockerCommand uses ${m[1]}, which does not exist`);
    }
  }
  for (const required of ["shapesos-web", "shapesos-worker", "shapesos-migrate"]) {
    if (!seenNames.has(required)) problems.push(`services: ${required} is missing (release.yml deploys it)`);
  }
  if (!existsSync(join(repoRoot, "scripts", "db", "migrate.sh"))) problems.push("scripts/db/migrate.sh is missing (the migrate job runs it)");
  return problems;
}

async function main(argv) {
  const { Ajv2020, YAML } = loadDeps();
  const text = readFileSync(join(ROOT, "render.yaml"), "utf8");
  const parsed = YAML.parseDocument(text, { prettyErrors: true });
  if (parsed.errors.length) {
    console.error(`render.yaml: YAML errors:\n  ${parsed.errors.map((e) => e.message).join("\n  ")}`);
    return 1;
  }
  const doc = parsed.toJS();
  const vendored = JSON.parse(readFileSync(join(ROOT, "infra", "render", "render.yaml.schema.json"), "utf8"));
  const problems = schemaProblems(doc, vendored, Ajv2020).map((p) => `schema: ${p}`);
  if (argv.includes("--live-schema")) {
    const res = await fetch(SCHEMA_URL);
    if (!res.ok) throw new Error(`fetching ${SCHEMA_URL}: HTTP ${res.status}`);
    const live = await res.json();
    problems.push(...schemaProblems(doc, live, Ajv2020).map((p) => `live schema: ${p}`));
    const same = JSON.stringify(live) === JSON.stringify(vendored);
    console.log(same ? "render.yaml: the vendored schema matches render.com" : "render.yaml: NOTE the vendored schema differs from render.com — refresh infra/render/render.yaml.schema.json");
  }
  problems.push(...semanticProblems(doc).map((p) => `rule: ${p}`));
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "deploy", "render-env.mjs"), "--check"], { stdio: "pipe" });
  } catch (e) {
    problems.push(`env groups: ${String(e.stderr ?? e.message).trim()}`);
  }
  if (problems.length) {
    console.error(`render.yaml: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(`render.yaml: OK (${doc.services.length} services, ${doc.databases.length} database, ${doc.envVarGroups.length} env groups; schema + repo rules + env groups)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`render.yaml: ${err.message}`);
      process.exit(1);
    },
  );
}
