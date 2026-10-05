// ShapesOS — Phase 9: shared helpers for the opt-in real-API smoke tests.
//
// Every scripts/live/*.mts drives the APP'S OWN adapters (lib/connectors,
// lib/deploy, lib/llm) against the real provider, so a pass proves our code,
// not a hand-written curl. Each one SKIPS (exit 0, "SKIP: …") unless its
// LIVE_* keys are set, so nothing here ever runs in normal CI — only the
// workflow_dispatch job in .github/workflows/live-smoke.yml sets them.
// Read-only by default; anything that creates provider state (a deploy, a
// rollback) also needs LIVE_DEPLOY_WRITE=1.

export const LIVE_ENV = process.env;

/** The values of `keys`, or null after printing a SKIP line (missing ones named). */
export function needEnv(name: string, keys: string[]): Record<string, string> | null {
  const missing = keys.filter((k) => !(LIVE_ENV[k] ?? "").trim());
  if (missing.length) {
    console.log(`SKIP ${name}: set ${missing.join(", ")} to run this live smoke test.`);
    return null;
  }
  return Object.fromEntries(keys.map((k) => [k, (LIVE_ENV[k] ?? "").trim()]));
}

export function optEnv(key: string, fallback = ""): string {
  return (LIVE_ENV[key] ?? "").trim() || fallback;
}

/** True when the run may create provider state (deploys, rollbacks). */
export function writesAllowed(): boolean {
  return optEnv("LIVE_DEPLOY_WRITE") === "1";
}

let failed = 0;

/** Run one check; prints PASS / FAIL with the (secret-free) detail. */
export async function step<T>(label: string, fn: () => Promise<T>, describe?: (v: T) => string): Promise<T | undefined> {
  const started = Date.now();
  try {
    const v = await fn();
    console.log(`  PASS ${label}${describe ? ` — ${describe(v)}` : ""} (${Date.now() - started} ms)`);
    return v;
  } catch (err) {
    failed++;
    console.log(`  FAIL ${label} — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function finish(name: string): never {
  console.log(failed ? `${name}: ${failed} check(s) FAILED` : `${name}: all checks passed`);
  process.exit(failed ? 1 : 0);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A one-page site that says when and by what it was deployed. */
export function smokePage(provider: string, n: number): { path: string; content: string }[] {
  const at = new Date().toISOString();
  return [
    {
      path: "index.html",
      content: `<!doctype html><html><head><meta charset="utf-8"><title>ShapesOS smoke ${n}</title></head><body><h1>ShapesOS live smoke test</h1><p>${provider} deploy ${n} at ${at}</p></body></html>\n`,
    },
  ];
}
