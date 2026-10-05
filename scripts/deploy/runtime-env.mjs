#!/usr/bin/env node
// ShapesOS — hosted runtime environment (deploy PR). Used by
// scripts/deploy/with-runtime-env.sh, which runs this and then exec's the app.
//
// 1. Secret blobs (AWS): ECS injects each Secrets Manager secret of the
//    shapesos/<group> family as ONE env var holding JSON (SHAPESOS_ENV_JSON_*,
//    infra/aws). Every non-empty key in them is exported, unless the same key
//    is already set. Empty placeholders are skipped, so a key nobody filled in
//    stays unset (the code's own default applies) instead of becoming "".
// 2. DATABASE_URL: Render can't interpolate one env var into another
//    (https://render.com/docs/blueprint-spec#variable-interpolation), and its
//    database reference only gives the OWNER's connection string — the app
//    must never connect as the owner (owners skip FORCE ROW LEVEL SECURITY).
//    So web and worker get the parts and the URL is composed here:
//      SHAPESOS_DB_HOST / SHAPESOS_DB_PORT / SHAPESOS_DB_NAME   (private host)
//      APP_DB_USER / APP_DB_PASSWORD                            (the app role)
//    `--owner` composes the owner's URL from SHAPESOS_DB_OWNER_USER /
//    SHAPESOS_DB_OWNER_PASSWORD instead (the AWS migrate task). Every part is
//    percent-encoded (Render's generated passwords are base64: + / =). An
//    existing DATABASE_URL (compose, a manual override) is kept.
//
// Output: `export KEY='value'` lines for sh `eval` (single-quoted, so no
// expansion). Exit 1 with a message on stderr when DATABASE_URL can't be
// formed — the wrapper then refuses to start instead of running without a DB.

import { pathToFileURL } from "node:url";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys to export from SHAPESOS_ENV_JSON_* blobs (sorted by blob name; first wins). */
export function envFromJsonBlobs(env) {
  const out = new Map();
  const problems = [];
  for (const name of Object.keys(env).filter((k) => k.startsWith("SHAPESOS_ENV_JSON")).sort()) {
    let parsed;
    try {
      parsed = JSON.parse(env[name] ?? "");
    } catch {
      problems.push(`${name} is not valid JSON`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${name} must be a JSON object`);
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!KEY_RE.test(k) || k.startsWith("SHAPESOS_ENV_JSON")) {
        problems.push(`${name}: ignored key ${JSON.stringify(k)}`);
        continue;
      }
      if (v === null || v === undefined) continue;
      const value = typeof v === "string" ? v : String(v);
      if (value === "") continue;
      if ((env[k] ?? "") !== "") continue; // an explicit env var wins
      if (!out.has(k)) out.set(k, value);
    }
  }
  return { values: out, problems };
}

/** @returns {{ url: string } | { error: string }} */
export function composeDatabaseUrl(env, { owner = false } = {}) {
  const existing = (env.DATABASE_URL ?? "").trim();
  if (existing) return { url: existing };
  const userKey = owner ? "SHAPESOS_DB_OWNER_USER" : "APP_DB_USER";
  const passKey = owner ? "SHAPESOS_DB_OWNER_PASSWORD" : "APP_DB_PASSWORD";
  const host = (env.SHAPESOS_DB_HOST ?? "").trim();
  const port = (env.SHAPESOS_DB_PORT ?? "").trim() || "5432";
  const name = (env.SHAPESOS_DB_NAME ?? "").trim();
  const user = (env[userKey] ?? "").trim();
  const password = env[passKey] ?? "";
  const missing = [
    ["SHAPESOS_DB_HOST", host],
    ["SHAPESOS_DB_NAME", name],
    [userKey, user],
    [passKey, password],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return { error: `DATABASE_URL is unset and so are ${missing.join(", ")}` };
  if (!/^\d{1,5}$/.test(port)) return { error: "SHAPESOS_DB_PORT must be a port number" };
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return { error: "SHAPESOS_DB_HOST must be a host name" };
  const enc = encodeURIComponent;
  return { url: `postgresql://${enc(user)}:${enc(password)}@${host}:${port}/${enc(name)}` };
}

/** sh single-quote: 'it'\''s' */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The full `export …` script, or an error. */
export function runtimeExports(env, { owner = false } = {}) {
  const { values, problems } = envFromJsonBlobs(env);
  const merged = { ...env };
  for (const [k, v] of values) merged[k] = v;
  const db = composeDatabaseUrl(merged, { owner });
  if ("error" in db) return { error: db.error, problems };
  const lines = [...values].map(([k, v]) => `export ${k}=${shQuote(v)}`);
  if ((env.DATABASE_URL ?? "").trim() === "") lines.push(`export DATABASE_URL=${shQuote(db.url)}`);
  return { script: lines.join("\n"), problems, exported: [...values.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const owner = process.argv.includes("--owner");
  const r = runtimeExports(process.env, { owner });
  for (const p of r.problems) console.error(`[runtime-env] ${p}`);
  if ("error" in r) {
    console.error(`[runtime-env] ${r.error}`);
    process.exit(1);
  }
  // Names only — never values.
  if (r.exported.length) console.error(`[runtime-env] loaded ${r.exported.length} setting(s) from secret blobs`);
  process.stdout.write(r.script + "\n");
}
