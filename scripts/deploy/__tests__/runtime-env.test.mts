// Deploy PR: the hosted start wrapper (scripts/deploy/runtime-env.mjs +
// with-runtime-env.sh): secret blobs, DATABASE_URL for the app role, quoting.
// Run: npx tsx --test scripts/deploy/__tests__/runtime-env.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { composeDatabaseUrl, envFromJsonBlobs, runtimeExports, shQuote } from "../runtime-env.mjs";

const PARTS = {
  SHAPESOS_DB_HOST: "dpg-abc123-a",
  SHAPESOS_DB_PORT: "5432",
  SHAPESOS_DB_NAME: "shapesos",
  APP_DB_USER: "shapesos_app",
  APP_DB_PASSWORD: "Ab+c/d=e@f:g?h#i%j", // base64 plus URL-hostile characters
};

describe("composeDatabaseUrl", () => {
  it("composes the app-role URL with every part percent-encoded", () => {
    const r = composeDatabaseUrl(PARTS);
    assert.ok("url" in r);
    assert.equal(r.url, "postgresql://shapesos_app:Ab%2Bc%2Fd%3De%40f%3Ag%3Fh%23i%25j@dpg-abc123-a:5432/shapesos");
    const u = new URL(r.url);
    assert.equal(decodeURIComponent(u.password), PARTS.APP_DB_PASSWORD);
    assert.equal(u.hostname, "dpg-abc123-a");
  });
  it("keeps an existing DATABASE_URL (compose, manual override)", () => {
    assert.deepEqual(composeDatabaseUrl({ ...PARTS, DATABASE_URL: "postgresql://x:y@db/z" }), { url: "postgresql://x:y@db/z" });
  });
  it("treats an empty DATABASE_URL as unset (the worker image sets it to \"\")", () => {
    assert.ok("url" in composeDatabaseUrl({ ...PARTS, DATABASE_URL: "" }));
  });
  it("defaults the port and names every missing part", () => {
    const { SHAPESOS_DB_PORT: _p, ...noPort } = PARTS;
    assert.match((composeDatabaseUrl(noPort) as { url: string }).url, /:5432\/shapesos$/);
    const r = composeDatabaseUrl({ SHAPESOS_DB_PORT: "5432" });
    assert.deepEqual(r, { error: "DATABASE_URL is unset and so are SHAPESOS_DB_HOST, SHAPESOS_DB_NAME, APP_DB_USER, APP_DB_PASSWORD" });
  });
  it("rejects a bad port or host instead of building a broken URL", () => {
    assert.ok("error" in composeDatabaseUrl({ ...PARTS, SHAPESOS_DB_PORT: "54x2" }));
    assert.ok("error" in composeDatabaseUrl({ ...PARTS, SHAPESOS_DB_HOST: "evil/host@x" }));
  });
  it("--owner uses the owner's credentials, never the app role's", () => {
    const r = composeDatabaseUrl({ ...PARTS, SHAPESOS_DB_OWNER_USER: "shapesos_owner", SHAPESOS_DB_OWNER_PASSWORD: "pw" }, { owner: true });
    assert.deepEqual(r, { url: "postgresql://shapesos_owner:pw@dpg-abc123-a:5432/shapesos" });
    assert.ok("error" in composeDatabaseUrl(PARTS, { owner: true }));
  });
});

describe("envFromJsonBlobs", () => {
  it("exports non-empty keys, skips empty placeholders, lets explicit env win", () => {
    const env = {
      ANTHROPIC_API_KEY: "explicit",
      SHAPESOS_ENV_JSON_SHARED: JSON.stringify({ ANTHROPIC_API_KEY: "from-blob", OPENAI_API_KEY: "sk-x", SENTRY_DSN: "", N: 5, Z: null }),
      SHAPESOS_ENV_JSON_WEB: JSON.stringify({ OPENAI_API_KEY: "later-blob-loses", STRIPE_WEBHOOK_SECRET: "whsec" }),
    };
    const { values, problems } = envFromJsonBlobs(env);
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.fromEntries(values), { OPENAI_API_KEY: "sk-x", N: "5", STRIPE_WEBHOOK_SECRET: "whsec" });
  });
  it("reports malformed blobs and refuses odd keys", () => {
    const { values, problems } = envFromJsonBlobs({
      SHAPESOS_ENV_JSON_A: "{not json",
      SHAPESOS_ENV_JSON_B: "[1,2]",
      SHAPESOS_ENV_JSON_C: JSON.stringify({ "BAD-KEY": "x", "1X": "y", SHAPESOS_ENV_JSON_D: "{}", OK_KEY: "v" }),
    });
    assert.deepEqual(Object.fromEntries(values), { OK_KEY: "v" });
    assert.equal(problems.length, 5, problems.join("\n"));
  });
});

describe("runtimeExports", () => {
  it("can take the database password from a blob (AWS: the app-role secret)", () => {
    const { APP_DB_PASSWORD: _pw, ...rest } = PARTS;
    const r = runtimeExports({ ...rest, SHAPESOS_ENV_JSON_DB: JSON.stringify({ APP_DB_PASSWORD: "p'w" }) });
    assert.ok("script" in r);
    assert.match(r.script!, /^export APP_DB_PASSWORD='p'\\''w'$/m);
    assert.match(r.script!, /^export DATABASE_URL='postgresql:\/\/shapesos_app:p'\\''w@dpg-abc123-a:5432\/shapesos'$/m);
  });
  it("does not re-export an existing DATABASE_URL", () => {
    const r = runtimeExports({ DATABASE_URL: "postgresql://a:b@c/d" });
    assert.ok("script" in r);
    assert.doesNotMatch(r.script!, /DATABASE_URL/);
  });
  it("fails when no DATABASE_URL can be formed", () => {
    assert.ok("error" in runtimeExports({}));
  });
  it("shQuote survives quotes, newlines and $(…)", () => {
    assert.equal(shQuote("a'b"), `'a'\\''b'`);
    const tricky = "line1\nline2 $(touch /tmp/pwned) `x` \"q\" 'single'";
    const out = spawnSync("sh", ["-c", `v=${shQuote(tricky)}; printf '%s' "$v"`], { encoding: "utf8" });
    assert.equal(out.stdout, tricky);
  });
});

describe("with-runtime-env.sh", () => {
  const SCRIPT = join(process.cwd(), "scripts/deploy/with-runtime-env.sh");
  const run = (env: Record<string, string>, args: string[]) =>
    spawnSync("sh", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

  it("exports the composed URL and blob values, then exec's the command", () => {
    const r = run(
      { ...PARTS, SHAPESOS_ENV_JSON_SHARED: JSON.stringify({ PEM: "-----BEGIN-----\nabc\n-----END-----" }) },
      ["node", "-e", "process.stdout.write(JSON.stringify({u: process.env.DATABASE_URL, p: process.env.PEM}))"],
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.u, "postgresql://shapesos_app:Ab%2Bc%2Fd%3De%40f%3Ag%3Fh%23i%25j@dpg-abc123-a:5432/shapesos");
    assert.equal(out.p, "-----BEGIN-----\nabc\n-----END-----");
    assert.match(r.stderr, /loaded 1 setting\(s\) from secret blobs/);
    assert.doesNotMatch(r.stderr, /abc|Ab\+c/, "values never reach the log");
  });
  it("--owner composes the owner URL", () => {
    const r = run({ ...PARTS, SHAPESOS_DB_OWNER_USER: "owner", SHAPESOS_DB_OWNER_PASSWORD: "o" }, ["--owner", "sh", "-c", 'printf %s "$DATABASE_URL"']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "postgresql://owner:o@dpg-abc123-a:5432/shapesos");
  });
  it("refuses to start without database settings, and without a command", () => {
    const r = run({}, ["sh", "-c", "echo started"]);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /started/);
    assert.match(r.stderr, /DATABASE_URL is unset/);
    assert.equal(run(PARTS, []).status, 2);
  });
});
