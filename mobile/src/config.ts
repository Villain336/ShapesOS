// ShapesOS mobile — backend configuration.
//
// The app talks to the SAME Next.js backend as the web app. No separate
// mobile API surface, no separate agent logic.
//
// Server URL resolution order (first that is set wins):
//   1. The in-app "Server" setting (self-hosted installs; persisted on the
//      device — see ServerUrlStore below and the login / settings screens)
//   2. EXPO_PUBLIC_API_BASE_URL (build-time env; set per EAS profile in eas.json)
//   3. app.config.ts → extra.apiBaseUrl (SHAPESOS_API_BASE_URL at config time)
//   4. http://localhost:3000 (dev)
//
// NOTE for physical devices: the dev server's localhost is the PHONE's
// localhost. Point the URL at the dev machine's LAN IP
// (e.g. http://192.168.1.10:3000) when running on hardware.

import Constants from "expo-constants";

export const FALLBACK_BASE_URL = "http://localhost:3000";

/** The build's default server (env → app config → localhost). */
export function resolveDefaultBaseUrl(
  env: Record<string, string | undefined> = process.env,
  extra: { apiBaseUrl?: string } | undefined = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined,
): string {
  for (const candidate of [env.EXPO_PUBLIC_API_BASE_URL, extra?.apiBaseUrl]) {
    const n = normalizeServerUrl(candidate ?? "");
    if (n.ok) return n.url;
  }
  return FALLBACK_BASE_URL;
}

/** Back-compat: the build default, resolved once at startup. */
export const API_BASE_URL = resolveDefaultBaseUrl();

export type ServerUrlResult = { ok: true; url: string; insecure: boolean } | { ok: false; error: string };

/** Hosts where plain http is acceptable (dev machines and private networks). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h === "::1" || h === "10.0.2.2") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Validate and normalize a server URL typed by a user (or read from config):
 * https anywhere; http only for localhost / private-network hosts (a session
 * cookie must never cross the internet in clear text). A bare host gets
 * https://. Path is kept (sub-path deployments), trailing slashes dropped;
 * query, fragment and credentials are refused.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter your ShapesOS server address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Use an https:// address." };
  }
  if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address." };
  if (url.search || url.hash) return { ok: false, error: "Use just the server address, without ? or #." };
  if (!url.hostname) return { ok: false, error: "That doesn't look like a web address." };
  const insecure = url.protocol === "http:";
  if (insecure && !isPrivateHost(url.hostname)) {
    return { ok: false, error: "Use https:// for servers on the internet." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.protocol}//${url.host}${path}`, insecure };
}

/** Persisted in-app server setting (null = use the build default). */
export interface ServerUrlStore {
  get(): Promise<string | null>;
  set(url: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryServerUrlStore implements ServerUrlStore {
  private value: string | null = null;
  async get() {
    return this.value;
  }
  async set(url: string) {
    this.value = url;
  }
  async clear() {
    this.value = null;
  }
}

const SERVER_URL_KEY = "shapesos.serverUrl.v1";

/** SecureStore-backed server setting (lazy import keeps tests dependency-free). */
export function createServerUrlStore(): ServerUrlStore {
  const load = async () => {
    try {
      return await import("expo-secure-store");
    } catch {
      return null;
    }
  };
  return {
    async get() {
      const s = await load();
      try {
        return s ? await s.getItemAsync(SERVER_URL_KEY) : null;
      } catch {
        return null;
      }
    },
    async set(url: string) {
      const s = await load();
      if (s) await s.setItemAsync(SERVER_URL_KEY, url);
    },
    async clear() {
      const s = await load();
      if (s) await s.deleteItemAsync(SERVER_URL_KEY);
    },
  };
}

/** The effective server: the saved setting when valid, else the build default. */
export async function resolveServerUrl(store: ServerUrlStore, fallback: string = API_BASE_URL): Promise<string> {
  const saved = await store.get().catch(() => null);
  if (saved) {
    const n = normalizeServerUrl(saved);
    if (n.ok) return n.url;
  }
  return fallback;
}

/**
 * Check that a URL is a reachable ShapesOS server before saving it: the
 * liveness probe (GET /api/health/live) answers 200 with no I/O on the server.
 */
export async function probeServer(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/health/live`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `The server answered ${res.status}. Is this a ShapesOS server?` };
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach that server. Check the address and your connection." };
  }
}
