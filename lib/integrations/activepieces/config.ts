// Marketr — Activepieces engine configuration (Phase 12, Worker 3).
//
// Server-only: env reading + reachability check. The API key is never logged
// or returned to the browser — status() only reports configured/not.
//
// Extends the Settings → Providers BYO-keys pattern (Phase 11c): everything
// degrades cleanly with no key/engine configured.

import type { ActivepiecesEngineStatus } from "./types";

/** Normalize an engine base URL: trim, drop trailing slashes. */
export function normalizeEngineUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.trim().replace(/\/+$/, "");
  return t.length > 0 ? t : null;
}

/** Read the engine config from the environment (server-only). */
export function readActivepiecesConfig(): { url: string | null; apiKey: string | null } {
  const url = normalizeEngineUrl(process.env.ACTIVEPIECES_URL);
  const apiKey = process.env.ACTIVEPIECES_API_KEY?.trim() || null;
  return { url, apiKey: apiKey && apiKey.length > 0 ? apiKey : null };
}

/** True only when both ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY are set. */
export function isActivepiecesConfigured(): boolean {
  const { url, apiKey } = readActivepiecesConfig();
  return url !== null && apiKey !== null;
}

/**
 * Engine status for the Settings → Providers page and API guards.
 * Key material is never included — only presence booleans.
 */
export function activepiecesStatus(): ActivepiecesEngineStatus {
  const { url, apiKey } = readActivepiecesConfig();
  const configured = url !== null && apiKey !== null;
  return { configured, url, hasApiKey: apiKey !== null };
}

/**
 * The API prefix after the engine base URL. Modern engines serve the
 * platform API at `/v1/...`; override with ACTIVEPIECES_API_PREFIX when
 * talking to an older engine that uses `/api/v1/...`.
 */
export function activepiecesApiPrefix(): string {
  const raw = process.env.ACTIVEPIECES_API_PREFIX?.trim();
  return raw && raw.length > 0 ? raw.replace(/\/+$/, "") : "/v1";
}

/**
 * Poll the engine for liveness: GET {url}{prefix}/flows with the API key.
 * Returns ok:false with a human-readable reason — never throws for
 * connectivity problems (callers translate to honest UI states).
 */
export async function probeActivepiecesEngine(timeoutMs = 8000): Promise<
  { ok: true; latencyMs: number } | { ok: false; reason: string }
> {
  const status = activepiecesStatus();
  if (!status.configured || !status.url) {
    return { ok: false, reason: "not-configured" };
  }
  const { apiKey } = readActivepiecesConfig();
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${status.url}${activepiecesApiPrefix()}/flows?limit=1`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      return { ok: false, reason: `engine answered ${r.status}` };
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg.includes("abort") ? "connection timed out" : msg };
  } finally {
    clearTimeout(timer);
  }
}
