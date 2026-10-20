// ShapesOS — beta legal pages (WS=legal): the subprocessor registry is the
// ONE list /subprocessors and /privacy render, and it must cover every
// provider the code can be configured with. The guard fails when a provider
// env var is added to .env.example, or a row to lib/providers/key-sources.ts,
// without a registry row (or an explicit "not a subprocessor" reason).
// Pure (no DB). Run: npx tsx --test lib/legal/__tests__/subprocessors.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_SUBPROCESSOR_ENV,
  PROVIDER_ENV_PATTERN,
  SUBPROCESSORS,
  SUBPROCESSOR_BASIS_LABEL,
  envExampleProviderKeys,
  subprocessorProblems,
  subprocessorsByBasis,
} from "../subprocessors";
import { KEY_SOURCES } from "@/lib/providers/key-sources";

const ROOT = join(__dirname, "..", "..", "..");
const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");

describe("subprocessor registry", () => {
  it("has no problems against the live provider registry and .env.example", () => {
    assert.deepEqual(subprocessorProblems(KEY_SOURCES.map((k) => k.id), envExample), []);
  });

  it("a provider env var added to .env.example without a registry row is reported", () => {
    const problems = subprocessorProblems(KEY_SOURCES.map((k) => k.id), envExample + "\n# NEWVENDOR_API_KEY=\n");
    assert.deepEqual(problems, ["NEWVENDOR_API_KEY is a provider env var in .env.example with no subprocessor row and no NOT_SUBPROCESSOR_ENV reason"]);
  });

  it("a key-source row without a subprocessor row is reported", () => {
    const problems = subprocessorProblems([...KEY_SOURCES.map((k) => k.id), "brand-new-vendor"], envExample);
    assert.deepEqual(problems, ["key source brand-new-vendor has no subprocessor row (keySourceIds) and no UNLISTED_KEY_SOURCES reason"]);
  });

  it("the provider pattern catches the shapes keys actually take", () => {
    for (const k of ["FOO_API_KEY", "FOO_CLIENT_SECRET", "FOO_DSN", "FOO_ACCESS_TOKEN", "FOO_BASE_URL", "FOO_WEBHOOK_SECRET", "FOO_LOGIN"]) {
      assert.ok(PROVIDER_ENV_PATTERN.test(k), k);
    }
    for (const k of ["APP_PORT", "FEATURE_GBP_MANAGEMENT", "NODE_ENV"]) assert.ok(!PROVIDER_ENV_PATTERN.test(k), k);
    assert.ok(envExampleProviderKeys(envExample).includes("ANTHROPIC_API_KEY"));
  });

  it("names the providers the beta actually runs on, with the facts the privacy page states", () => {
    const by = (id: string) => SUBPROCESSORS.find((s) => s.id === id);
    for (const id of ["render", "cloudflare", "anthropic", "openai", "stripe", "resend", "e2b", "zernio", "sentry", "google-signin"]) {
      assert.ok(by(id), `${id} row`);
    }
    assert.equal(by("render")!.basis, "platform");
    assert.match(by("render")!.location, /United States/);
    assert.match(by("anthropic")!.retention, /LLM_ALLOW_RETENTION_MODELS/);
    assert.match(by("openai")!.retention, /store: false/);
    assert.equal(by("sentry")!.basis, "when_configured");
    assert.ok(by("render")!.envVars.length === 0 || by("render")!.keySourceIds.length === 0, "infrastructure rows need no key source");
    // Nothing claims a certification we do not hold.
    for (const s of SUBPROCESSORS) assert.doesNotMatch(`${s.purpose} ${s.dataShared} ${s.retention}`, /we are SOC ?2|our SOC ?2|ISO ?27001 certified/i, s.id);
  });

  it("every basis has a label and at least one row; reasons in the allow-lists are sentences", () => {
    for (const basis of Object.keys(SUBPROCESSOR_BASIS_LABEL) as Array<keyof typeof SUBPROCESSOR_BASIS_LABEL>) {
      assert.ok(subprocessorsByBasis(basis).length > 0, basis);
    }
    for (const [k, why] of Object.entries(NOT_SUBPROCESSOR_ENV)) assert.ok(why.length > 15, k);
  });
});
