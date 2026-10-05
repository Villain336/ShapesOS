// ShapesOS Phase 15.1 — the key-source registry is the ONE source of truth:
// every provider has a class, BYOK entries point at real forms, Connect rows
// cover their connectors' env vars, every env var is documented, and
// docs/KEYS.md is exactly what the registry generates. (Pure, no DB.)
// Run: npx tsx --test lib/providers/__tests__/key-sources.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KEY_CLASS_LABEL,
  KEY_SOURCES,
  keySourceProblems,
  keysMarkdownTable,
  keySourcesByClass,
  type KeyClass,
} from "../key-sources";
import { SIDECAR_KEYS, WORKSPACE_CREDENTIALS, cleanCredentialValues, credentialDef, sidecarEnvVars } from "../workspace-credentials";
import { MODEL_KEY_CONNECTOR } from "@/lib/llm/workspace-keys";
import { BUILT_IN_CONNECTORS } from "@/lib/connectors/m21/registry";

const ROOT = join(__dirname, "..", "..", "..");
const credIds = WORKSPACE_CREDENTIALS.map((d) => d.id);

describe("key-source registry", () => {
  it("has no problems: unique ids, a class each, BYOK where the class allows it, env names for platform/connect/self-host", () => {
    assert.deepEqual(keySourceProblems(credIds), []);
  });

  it("covers every class the owner decided, with the plan's anchor providers", () => {
    for (const cls of Object.keys(KEY_CLASS_LABEL) as KeyClass[]) assert.ok(keySourcesByClass(cls).length > 0, cls);
    const cls = (id: string) => KEY_SOURCES.find((e) => e.id === id)?.class;
    assert.equal(cls("anthropic"), "both");
    assert.equal(cls("openai"), "both");
    assert.equal(cls("dataforseo"), "both");
    assert.equal(cls("contextdev"), "both");
    assert.equal(cls("twilio"), "platform");
    assert.equal(cls("e2b"), "platform");
    assert.equal(cls("gusto"), "connect");
    assert.equal(cls("google"), "connect");
    assert.equal(cls("smartlead"), "byok");
    assert.equal(cls("instantly"), "byok");
    assert.equal(cls("mail-print"), "byok");
    for (const s of SIDECAR_KEYS) assert.equal(cls(s), "self_host", s);
  });

  it("model and sidecar rows point at the Settings → Providers forms", () => {
    const at = (id: string) => KEY_SOURCES.find((e) => e.id === id)!.byok;
    assert.deepEqual(at("anthropic"), { credential: "model:anthropic" });
    assert.deepEqual(at("openai"), { credential: "model:openai" });
    assert.deepEqual(at("smartlead"), { credential: "outreach:smartlead" });
    for (const s of SIDECAR_KEYS) assert.deepEqual(at(s), { credential: `sidecar:${s}` });
    // The vault connector keys the router reads are the ones the forms write.
    assert.equal(credentialDef("model:anthropic")!.connectorKey, MODEL_KEY_CONNECTOR.anthropic);
    assert.equal(credentialDef("model:openai")!.connectorKey, MODEL_KEY_CONNECTOR.openai);
  });

  it("a self-host row lists exactly the env vars its sidecar reads", () => {
    for (const s of SIDECAR_KEYS) {
      const e = KEY_SOURCES.find((x) => x.id === s)!;
      assert.deepEqual([...e.envVars].sort(), [...sidecarEnvVars(s)].sort(), s);
    }
  });

  it("a Connect row covers the env vars of every built-in connector it serves", () => {
    for (const e of keySourcesByClass("connect")) {
      for (const key of e.m21 ?? []) {
        const meta = BUILT_IN_CONNECTORS.find((c) => c.key === key);
        assert.ok(meta, `${e.id}: unknown m21 connector ${key}`);
        for (const v of meta.oauth?.envVars ?? []) assert.ok(e.envVars.includes(v), `${e.id} misses ${v} (from ${key})`);
      }
    }
  });

  it("every env var the registry names is documented in .env.example", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^#? ?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const missing = KEY_SOURCES.flatMap((e) => e.envVars.filter((v) => !documented.has(v)).map((v) => `${e.id}:${v}`));
    assert.deepEqual(missing, []);
  });

  it("docs/KEYS.md carries exactly the table the registry generates", () => {
    const doc = readFileSync(join(ROOT, "docs", "KEYS.md"), "utf8");
    const begin = doc.indexOf("<!-- BEGIN keys-table");
    const end = doc.indexOf("<!-- END keys-table -->");
    assert.ok(begin >= 0 && end > begin, "markers present");
    const table = doc.slice(doc.indexOf("\n", begin) + 1, end).trim();
    assert.equal(table, keysMarkdownTable(), "run: npx tsx scripts/docs/generate-keys-md.mts");
    for (const e of KEY_SOURCES) assert.ok(table.includes(`| ${e.label} | ${KEY_CLASS_LABEL[e.class]} |`), e.id);
  });
});

describe("workspace credential forms", () => {
  it("secrets are marked secret; URLs are url fields; ids are unique", () => {
    assert.equal(new Set(credIds).size, credIds.length);
    for (const d of WORKSPACE_CREDENTIALS) {
      for (const f of d.fields) {
        if (/key|token|secret/i.test(f.name) && !/clientKey|websiteToken/.test(f.name)) assert.equal(f.secret, true, `${d.id}.${f.name}`);
        if (/url|host/i.test(f.name)) assert.equal(f.type, "url", `${d.id}.${f.name}`);
      }
    }
  });

  it("clean values: required fields enforced, unknown fields dropped, URLs trimmed", () => {
    const d = credentialDef("sidecar:postiz")!;
    assert.deepEqual(cleanCredentialValues(d, { url: "https://p.example.com/", apiKey: " k ", extra: "x" }), {
      ok: true,
      payload: { url: "https://p.example.com", apiKey: "k" },
    });
    assert.deepEqual(cleanCredentialValues(d, { url: "https://p.example.com" }), { ok: false, error: "API key is required." });
  });
});
