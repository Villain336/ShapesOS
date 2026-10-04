// ShapesOS — Phase 8: GitHub App mode for the GitHub connector.
//
// When GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are set, ShapesOS acts as a
// GitHub App instead of with a personal access token:
//   1. sign a short-lived app JWT (RS256, node:crypto — no new dependency):
//      iat 60 s in the past (clock drift), exp 9 minutes ahead (GitHub caps
//      it at 10), iss = the app id (GitHub also accepts the client id);
//   2. find the installation for a repository
//      (GET /repos/{owner}/{repo}/installation, JWT auth);
//   3. mint an installation access token
//      (POST /app/installations/{id}/access_tokens, JWT auth) and cache it
//      per installation until shortly before its expires_at.
// Request shapes follow docs.github.com (REST API 2022-11-28). Untested
// against the live API from this sandbox (egress blocked): the unit suite
// stubs fetch and checks the JWT signature with the matching public key.

import { createSign } from "node:crypto";

const API = "https://api.github.com";

/** Refresh an installation token this long before GitHub expires it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Installation ids rarely change; re-look them up after this long. */
const INSTALLATION_TTL_MS = 60 * 60 * 1000;

export interface GitHubAppCredentials {
  appId: string;
  /** PEM private key (PKCS#1 or PKCS#8). Literal "\n" escapes are accepted. */
  privateKey: string;
}

/** Is the App mode configured? Reads GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY. */
export function githubAppCredentialsFromEnv(env: Record<string, string | undefined> = process.env): GitHubAppCredentials | null {
  const appId = (env.GITHUB_APP_ID ?? "").trim();
  const privateKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").trim();
  if (!appId || !privateKey) return null;
  return { appId, privateKey };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Normalise a key pasted into an env var ("\n" escapes, surrounding quotes). */
export function normalizePrivateKey(raw: string): string {
  let k = raw.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\n/g, "\n");
}

/** Sign the app JWT (RS256). `nowMs` is injectable for tests. */
export function createAppJwt(creds: GitHubAppCredentials, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: creds.appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(normalizePrivateKey(creds.privateKey));
  return `${signingInput}.${b64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
}

export interface GitHubAppAuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Installation tokens for one GitHub App, cached per installation until
 * expiry. One instance per process (githubApp()); tests build their own.
 */
export class GitHubAppAuth {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, { id: number; at: number }>();
  private readonly tokens = new Map<number, InstallationToken>();
  private readonly inflight = new Map<number, Promise<InstallationToken>>();

  constructor(private readonly creds: GitHubAppCredentials, deps: GitHubAppAuthDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private async appRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const jwt = createAppJwt(this.creds, this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "shapesos",
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      throw new Error(`GitHub App request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) throw new Error("The ShapesOS GitHub App is not installed on this repository.");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub App API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** The installation that covers owner/repo (cached for an hour). */
  async installationIdFor(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const hit = this.installations.get(key);
    if (hit && this.now() - hit.at < INSTALLATION_TTL_MS) return hit.id;
    const inst = await this.appRequest<{ id: number }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    );
    if (typeof inst.id !== "number") throw new Error("GitHub App installation lookup returned no id");
    this.installations.set(key, { id: inst.id, at: this.now() });
    return inst.id;
  }

  /** A valid installation token (cached until shortly before it expires). */
  async installationToken(installationId: number): Promise<InstallationToken> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS > this.now()) return cached;
    const pending = this.inflight.get(installationId);
    if (pending) return pending;
    const p = (async () => {
      const res = await this.appRequest<{ token: string; expires_at: string }>(
        `/app/installations/${installationId}/access_tokens`,
        { method: "POST" },
      );
      if (!res.token || !res.expires_at) throw new Error("GitHub App token response was missing token/expires_at");
      const tok: InstallationToken = { token: res.token, expiresAt: new Date(res.expires_at), installationId };
      this.tokens.set(installationId, tok);
      return tok;
    })();
    this.inflight.set(installationId, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(installationId);
    }
  }

  /** Token for a repository: installation lookup + cached installation token. */
  async tokenFor(owner: string, repo: string): Promise<InstallationToken> {
    return this.installationToken(await this.installationIdFor(owner, repo));
  }
}

let singleton: { key: string; auth: GitHubAppAuth } | null = null;

/** The process-wide App auth, or null when the App mode is not configured. */
export function githubApp(env: Record<string, string | undefined> = process.env): GitHubAppAuth | null {
  const creds = githubAppCredentialsFromEnv(env);
  if (!creds) return null;
  const key = `${creds.appId}:${creds.privateKey.length}`;
  if (!singleton || singleton.key !== key) singleton = { key, auth: new GitHubAppAuth(creds) };
  return singleton.auth;
}
