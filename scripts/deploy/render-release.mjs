#!/usr/bin/env node
// ShapesOS — release to Render (deploy PR). Run by .github/workflows/release.yml
// after the images for one commit are in GHCR:
//
//   RENDER_API_KEY=… node scripts/deploy/render-release.mjs \
//     --sha <git sha> --registry ghcr.io/villain336 \
//     --web-service srv-… --worker-service srv-… --migrate-service crn-… \
//     --health-url https://app.shapesos.com/api/health
//
// Order (each step must succeed before the next):
//   1. Remember the live deploy of web and worker (the rollback targets).
//   2. Migrations: deploy the `migrate:<sha>` image to the shapesos-migrate cron
//      service, then run `sh scripts/db/migrate.sh` there as a one-off job
//      (https://render.com/docs/one-off-jobs) and wait for it. A failed
//      migration stops the release here; web and worker are untouched.
//   3. Deploy `worker:<sha>`, wait until live; deploy `runner:<sha>` to web,
//      wait until live (Render health-checks new web instances before
//      switching traffic, https://render.com/docs/deploys#zero-downtime-deploys).
//   4. Smoke: GET --health-url until it answers 200 {status:"ok"} with this
//      commit (the runner image carries MARKETR_GIT_COMMIT).
//   5. Any failure in 3–4: roll web and worker back to the deploys from step 1
//      (POST /v1/services/{id}/rollback, https://render.com/docs/rollbacks),
//      wait for them, and exit 1. Migrations are forward-only (expand/contract),
//      so the previous image runs against the new schema.
//
// Render API (https://api-docs.render.com, base https://api.render.com/v1):
//   POST /services/{id}/deploys {imageUrl}  → 201 deploy | 202 queued (no body)
//   GET  /services/{id}/deploys/{deployId}  → status: created, queued,
//        build_in_progress, update_in_progress, pre_deploy_in_progress, live |
//        build_failed, update_failed, pre_deploy_failed, canceled, deactivated
//   GET  /services/{id}/deploys?limit=N     → [{deploy, cursor}] newest first
//   POST /services/{id}/jobs {startCommand} → job; GET …/jobs/{jobId} → status
//        pending, running | succeeded, failed, canceled
//   POST /services/{id}/rollback {deployId}
// The API key is read from RENDER_API_KEY only (never argv) and never logged.

import { pathToFileURL } from "node:url";

export const DEFAULT_API = "https://api.render.com/v1";
const OK_DEPLOY = new Set(["live"]);
const FAILED_DEPLOY = new Set(["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"]);
const FAILED_JOB = new Set(["failed", "canceled"]);
export const MIGRATE_COMMAND = "sh scripts/db/migrate.sh";

export class ReleaseError extends Error {}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ReleaseError(`unexpected argument ${a}`);
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) throw new ReleaseError(`--${key} needs a value`);
    out[key] = val;
    i++;
  }
  const need = ["sha", "registry", "web-service", "worker-service", "migrate-service", "health-url"];
  const missing = need.filter((k) => !out[k]);
  if (missing.length) throw new ReleaseError(`missing --${missing.join(", --")}`);
  if (!/^[0-9a-f]{7,40}$/.test(out.sha)) throw new ReleaseError("--sha must be a git commit sha");
  if (!/^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/.test(out.registry)) throw new ReleaseError("--registry must look like ghcr.io/<owner>");
  for (const k of ["web-service", "worker-service", "migrate-service"]) {
    if (!/^(srv|crn)-[a-z0-9]+$/.test(out[k])) throw new ReleaseError(`--${k} must be a Render service id (srv-… or crn-…)`);
  }
  let health;
  try {
    health = new URL(out["health-url"]);
  } catch {
    throw new ReleaseError("--health-url must be a URL");
  }
  if (health.protocol !== "https:" && health.hostname !== "127.0.0.1" && health.hostname !== "localhost") {
    throw new ReleaseError("--health-url must be https");
  }
  return {
    sha: out.sha,
    registry: out.registry,
    web: out["web-service"],
    worker: out["worker-service"],
    migrate: out["migrate-service"],
    healthUrl: out["health-url"],
    timeoutMinutes: Number(out["timeout-minutes"] ?? 30),
  };
}

export function imageRef(registry, target, sha) {
  return `${registry}/shapesos-${target}:${sha}`;
}

/** A small Render API client with retry on 429/5xx. */
export function renderClient({ apiKey, base = DEFAULT_API, fetchImpl = fetch, sleep, log }) {
  if (!apiKey) throw new ReleaseError("RENDER_API_KEY is not set");
  async function call(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt >= 5) throw new ReleaseError(`${method} ${path}: ${err.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const ra = Number(res.headers.get("retry-after"));
        log(`  Render API ${res.status} on ${method} ${path}; retrying`);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * attempt);
        continue;
      }
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (!res.ok) {
        const msg = json?.message ?? text.slice(0, 200);
        throw new ReleaseError(`${method} ${path}: HTTP ${res.status}${msg ? ` (${msg})` : ""}`);
      }
      return { status: res.status, json };
    }
  }
  return { call };
}

const unwrapDeploy = (x) => (x && x.deploy ? x.deploy : x);

export async function latestLiveDeploy(api, serviceId) {
  const { json } = await api.call("GET", `/services/${serviceId}/deploys?status=live&limit=1`);
  const d = Array.isArray(json) ? unwrapDeploy(json[0]) : null;
  return d?.id ? d : null;
}

/** Trigger an image deploy and return its id (handles 202 "queued"). */
export async function triggerImageDeploy(api, serviceId, imageUrl, { sleep, now }) {
  const startedAt = now();
  const { status, json } = await api.call("POST", `/services/${serviceId}/deploys`, { imageUrl });
  if (status !== 202 && json?.id) return json.id;
  // Queued behind a running deploy (the "wait" overlapping-deploy policy,
  // https://render.com/docs/deploys#handling-overlapping-deploys): find it.
  for (let i = 0; i < 60; i++) {
    const { json: list } = await api.call("GET", `/services/${serviceId}/deploys?limit=10`);
    const hit = (Array.isArray(list) ? list : [])
      .map(unwrapDeploy)
      .find((d) => d?.image?.ref === imageUrl && Date.parse(d.createdAt ?? 0) >= startedAt - 60_000);
    if (hit?.id) return hit.id;
    await sleep(5000);
  }
  throw new ReleaseError(`deploy of ${imageUrl} to ${serviceId} was queued but never appeared`);
}

export async function waitForDeploy(api, serviceId, deployId, { sleep, now, timeoutMs, log, label }) {
  const deadline = now() + timeoutMs;
  let last = "";
  while (now() < deadline) {
    const { json } = await api.call("GET", `/services/${serviceId}/deploys/${deployId}`);
    const status = json?.status ?? "unknown";
    if (status !== last) log(`  ${label}: ${status}`);
    last = status;
    if (OK_DEPLOY.has(status)) return;
    if (FAILED_DEPLOY.has(status)) throw new ReleaseError(`${label} deploy ${deployId} ended ${status}`);
    await sleep(10_000);
  }
  throw new ReleaseError(`${label} deploy ${deployId} was not live after ${Math.round(timeoutMs / 60000)} min (last status ${last})`);
}

export async function runJob(api, serviceId, startCommand, { sleep, now, timeoutMs, log }) {
  const { json } = await api.call("POST", `/services/${serviceId}/jobs`, { startCommand });
  const jobId = json?.id;
  if (!jobId) throw new ReleaseError("Render did not return a job id");
  log(`  migrate job ${jobId} started`);
  const deadline = now() + timeoutMs;
  let last = "";
  while (now() < deadline) {
    const { json: job } = await api.call("GET", `/services/${serviceId}/jobs/${jobId}`);
    const status = job?.status ?? "pending";
    if (status !== last) log(`  migrate job: ${status}`);
    last = status;
    if (status === "succeeded") return jobId;
    if (FAILED_JOB.has(status)) throw new ReleaseError(`migration job ${jobId} ${status} — see the job's logs on shapesos-migrate (One-off Jobs)`);
    await sleep(10_000);
  }
  throw new ReleaseError(`migration job ${jobId} did not finish within ${Math.round(timeoutMs / 60000)} min`);
}

export async function smoke(healthUrl, sha, { fetchImpl = fetch, sleep, now, timeoutMs, log }) {
  const deadline = now() + timeoutMs;
  let last = "no answer";
  while (now() < deadline) {
    try {
      const res = await fetchImpl(healthUrl, { headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
      const body = await res.json().catch(() => null);
      const commit = typeof body?.commit === "string" ? body.commit : "";
      if (res.status === 200 && body?.status === "ok" && commit && (sha.startsWith(commit) || commit.startsWith(sha))) {
        log(`  smoke: ${healthUrl} → 200 ok, commit ${commit}`);
        return;
      }
      last = `HTTP ${res.status}, status ${body?.status ?? "?"}, commit ${commit || "?"}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(10_000);
  }
  throw new ReleaseError(`smoke test failed: ${healthUrl} (${last})`);
}

export async function release(opts, deps) {
  const { sleep, now, log } = deps;
  const api = deps.api ?? renderClient({ apiKey: deps.apiKey, base: deps.base, fetchImpl: deps.fetchImpl, sleep, log });
  const timeoutMs = opts.timeoutMinutes * 60_000;
  const step = { sleep, now, log, timeoutMs };

  log(`release ${opts.sha}`);
  log("1/5 recording the live deploys (rollback targets)");
  const previous = {
    web: await latestLiveDeploy(api, opts.web),
    worker: await latestLiveDeploy(api, opts.worker),
  };
  log(`  web: ${previous.web?.id ?? "none (first release)"}, worker: ${previous.worker?.id ?? "none (first release)"}`);

  log("2/5 migrations");
  const migrateImage = imageRef(opts.registry, "migrate", opts.sha);
  const migrateDeploy = await triggerImageDeploy(api, opts.migrate, migrateImage, step);
  await waitForDeploy(api, opts.migrate, migrateDeploy, { ...step, label: "shapesos-migrate" });
  await runJob(api, opts.migrate, MIGRATE_COMMAND, step);

  const changed = [];
  try {
    log("3/5 worker");
    const workerDeploy = await triggerImageDeploy(api, opts.worker, imageRef(opts.registry, "worker", opts.sha), step);
    changed.push("worker");
    await waitForDeploy(api, opts.worker, workerDeploy, { ...step, label: "shapesos-worker" });
    log("4/5 web");
    const webDeploy = await triggerImageDeploy(api, opts.web, imageRef(opts.registry, "runner", opts.sha), step);
    changed.push("web");
    await waitForDeploy(api, opts.web, webDeploy, { ...step, label: "shapesos-web" });
    log("5/5 smoke");
    await smoke(opts.healthUrl, opts.sha, { fetchImpl: deps.smokeFetch ?? deps.fetchImpl, ...step, timeoutMs: Math.min(timeoutMs, 5 * 60_000) });
  } catch (err) {
    log(`FAILED: ${err.message}`);
    const rolled = [];
    for (const name of ["web", "worker"]) {
      if (!changed.includes(name)) continue;
      const prev = previous[name];
      const id = name === "web" ? opts.web : opts.worker;
      if (!prev) {
        log(`  ${name}: no earlier deploy to roll back to`);
        continue;
      }
      try {
        const { json } = await api.call("POST", `/services/${id}/rollback`, { deployId: prev.id });
        log(`  ${name}: rolling back to ${prev.id}`);
        if (json?.id) await waitForDeploy(api, id, json.id, { ...step, label: `${name} rollback` });
        rolled.push(name);
      } catch (rbErr) {
        log(`  ${name}: ROLLBACK FAILED (${rbErr.message}) — roll back in the Render dashboard (Deploys → Rollback)`);
      }
    }
    throw new ReleaseError(`release ${opts.sha} failed: ${err.message}${rolled.length ? `; rolled back ${rolled.join(" and ")}` : ""}`);
  }
  log(`released ${opts.sha}`);
  return { previous };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = (m) => console.log(m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    await release(opts, { apiKey: process.env.RENDER_API_KEY, sleep, now: Date.now, log, fetchImpl: fetch });
  })().then(
    () => process.exit(0),
    (err) => {
      console.error(`::error::${err.message}`);
      process.exit(1);
    },
  );
}
