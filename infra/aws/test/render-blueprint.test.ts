// render.yaml checks (scripts/ci/validate-render-blueprint.mjs): the schema
// and repo rules accept the committed Blueprint and catch real mistakes.
// Lives here because Ajv and yaml are this package's dev dependencies.
// Run: cd infra/aws && npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import { schemaProblems, semanticProblems } from "../../../scripts/ci/validate-render-blueprint.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(`${ROOT}infra/render/render.yaml.schema.json`, "utf8"));
const blueprint = () => parse(readFileSync(`${ROOT}render.yaml`, "utf8")) as Record<string, any>;

describe("render.yaml", () => {
  it("validates against Render's JSON schema", () => {
    assert.deepEqual(schemaProblems(blueprint(), schema, Ajv2020), []);
  });
  it("passes the repo rules", () => {
    assert.deepEqual(semanticProblems(blueprint(), ROOT), []);
  });
  it("the schema rejects an unknown plan and an unknown field", () => {
    const doc = blueprint();
    doc.services[0].plan = "2c-9g";
    doc.services[1].dockerTarget = "worker";
    assert.ok(schemaProblems(doc, schema, Ajv2020).length >= 2);
  });
  it("the rules catch a foreign image, a missing group, sync in a group and a duplicate key", () => {
    const doc = blueprint();
    doc.services[0].image.url = "docker.io/someone/else:latest";
    doc.services[1].envVars.push({ fromGroup: "nope" });
    doc.envVarGroups[1].envVars.push({ key: "SOME_SECRET", sync: false });
    doc.services[0].envVars.unshift({ key: "DEPLOYMENT_MODE", value: "self_hosted" });
    const p = semanticProblems(doc, ROOT).join("\n");
    assert.match(p, /image must be ghcr\.io\/villain336/);
    assert.match(p, /env group nope is not defined/);
    assert.match(p, /sync is ignored inside env groups/);
    assert.match(p, /DEPLOYMENT_MODE is set twice/);
  });
  it("the rules catch a health check without a route and a missing start script", () => {
    const doc = blueprint();
    doc.services[0].healthCheckPath = "/api/healthz";
    doc.services[1].dockerCommand = "sh scripts/deploy/nope.sh node x.js";
    const p = semanticProblems(doc, ROOT).join("\n");
    assert.match(p, /health check \/api\/healthz has no route/);
    assert.match(p, /scripts\/deploy\/nope\.sh, which does not exist/);
  });
  it("migrations run before the app: the migrate service holds the owner URL, web and worker never do", () => {
    const doc = blueprint();
    const svc = (n: string) => doc.services.find((s: { name: string }) => s.name === n);
    const migrate = svc("shapesos-migrate");
    assert.deepEqual(migrate.envVars.find((v: { key?: string }) => v.key === "DATABASE_URL").fromDatabase, { name: "shapesos-db", property: "connectionString" });
    for (const n of ["shapesos-web", "shapesos-worker"]) {
      const vars = svc(n).envVars as Array<{ key?: string; fromDatabase?: { property: string } }>;
      assert.ok(!vars.some((v) => v.key === "DATABASE_URL"), `${n} composes DATABASE_URL at start`);
      assert.ok(!vars.some((v) => v.fromDatabase?.property === "connectionString" || v.fromDatabase?.property === "password"), `${n} never sees the owner's credentials`);
      assert.match(svc(n).dockerCommand, /^sh scripts\/deploy\/with-runtime-env\.sh /);
    }
    assert.equal(svc("shapesos-web").healthCheckPath, "/api/health/live");
    assert.ok(svc("shapesos-web").scaling.minInstances >= 2);
    assert.equal(doc.databases[0].postgresMajorVersion, "16");
  });
});
