// ShapesOS — Phase 8: sandbox configuration, read from the environment (PURE).
//
// One function over an env object (process.env in production, a literal in
// tests) so every provider and the Settings → Providers inventory agree on
// what is configured. No key material ever leaves this module except to the
// provider that needs it.
//
//   SANDBOX_PROVIDER        docker (default) | e2b | daytona | off
//   DOCKER_HOST             unix:///var/run/docker.sock (default) or a socket path
//   SANDBOX_IMAGE           image for Docker sandboxes (default: SANDBOX_DEFAULT_IMAGE)
//   SANDBOX_CPUS            CPUs per sandbox (default 2)
//   SANDBOX_MEMORY_MB       memory per sandbox (default 2048; swap = memory)
//   SANDBOX_PIDS            process limit (default 512)
//   SANDBOX_DISK_MB         workdir size cap; Docker: a tmpfs-backed volume
//                           of this size (unset = no hard cap — see docker.ts)
//   SANDBOX_IDLE_MINUTES    destroy after this long without a command (default 30)
//   SANDBOX_EGRESS_ALLOW    extra hosts the sandbox may reach (comma-separated)
//   SANDBOX_PREVIEW_HOST    where the Docker preview gateway's host port is
//                           reachable from the app (default 127.0.0.1)
//   SANDBOX_PREVIEW_BIND    the Docker host IP that port is published on
//                           (default 127.0.0.1 — loopback only)
//   SANDBOX_SNAPSHOT_DIR    Docker checkpoint tarballs (default .data/sandbox-snapshots)
//   SANDBOX_SNAPSHOT_MAX_MB biggest checkpoint kept (default 1024)
//   E2B_API_KEY, E2B_DOMAIN (default e2b.app), E2B_TEMPLATE (default base)
//   DAYTONA_API_KEY, DAYTONA_API_URL (default https://app.daytona.io/api),
//   DAYTONA_SNAPSHOT (optional base snapshot name)

import type { SandboxProviderName } from "./types";

export type EnvLike = Record<string, string | undefined>;

/**
 * The default Docker image: official Node 24 LTS (krypton) on Debian
 * bookworm — node, npm, git, python3, curl, tar, coreutils `timeout`, and a
 * non-root `node` user (uid 1000, home /home/node). Pinned by exact tag AND
 * the multi-arch index digest read from Docker Hub on 2026-10-04, so a
 * re-pushed tag can never change what runs. ripgrep is NOT in this image;
 * the grep tool falls back to grep -rn.
 */
export const SANDBOX_DEFAULT_IMAGE =
  "node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4";

/**
 * Hosts every sandbox may reach: package registries and GitHub. Anything
 * else is refused by the egress gateway (Docker), the provider's allow-list
 * (E2B allowOut, Daytona domainAllowList). Extend with SANDBOX_EGRESS_ALLOW.
 */
export const DEFAULT_EGRESS_ALLOW: readonly string[] = [
  // npm / yarn
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // GitHub (clone, API, release + raw downloads)
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export interface SandboxConfig {
  /** The provider asked for; null = "off" (code tools disabled on purpose). */
  provider: SandboxProviderName | null;
  /** Set when SANDBOX_PROVIDER holds something we don't know. */
  invalidProvider: string | null;
  docker: { socketPath: string; image: string; previewHost: string; previewBind: string; snapshotDir: string; snapshotMaxBytes: number };
  e2b: { apiKey: string | null; domain: string; template: string };
  daytona: { apiKey: string | null; apiUrl: string; snapshot: string | null };
  resources: { cpus: number; memoryMb: number; pids: number; diskMb: number | null };
  idleSeconds: number;
  egressAllow: string[];
}

function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number((v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0 || !(v ?? "").trim()) return def;
  return Math.min(Math.max(n, min), max);
}

function str(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

/** DOCKER_HOST → a unix socket path (tcp:// hosts are not supported: no TLS here). */
export function dockerSocketPath(dockerHost: string | undefined): string {
  const h = (dockerHost ?? "").trim();
  if (!h) return "/var/run/docker.sock";
  if (h.startsWith("unix://")) return h.slice("unix://".length) || "/var/run/docker.sock";
  if (h.startsWith("/")) return h;
  // tcp://… would need TLS client certs to be safe; refuse rather than run
  // an unauthenticated plain-TCP Docker API.
  return "";
}

/** A host name for an egress allow-list: lower-case, no scheme/port/path. */
export function normalizeEgressHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
  return h;
}

export function sandboxConfig(env: EnvLike = process.env): SandboxConfig {
  const rawProvider = (env.SANDBOX_PROVIDER ?? "").trim().toLowerCase();
  let provider: SandboxProviderName | null = "docker";
  let invalidProvider: string | null = null;
  if (rawProvider === "off" || rawProvider === "none" || rawProvider === "0") provider = null;
  else if (rawProvider === "e2b" || rawProvider === "daytona" || rawProvider === "docker") provider = rawProvider;
  else if (rawProvider) {
    provider = null;
    invalidProvider = rawProvider;
  }
  const extra = (env.SANDBOX_EGRESS_ALLOW ?? "")
    .split(",")
    .map(normalizeEgressHost)
    .filter((h): h is string => !!h);
  const disk = Number((env.SANDBOX_DISK_MB ?? "").trim());
  return {
    provider,
    invalidProvider,
    docker: {
      socketPath: dockerSocketPath(env.DOCKER_HOST),
      image: str(env.SANDBOX_IMAGE) ?? SANDBOX_DEFAULT_IMAGE,
      previewHost: str(env.SANDBOX_PREVIEW_HOST) ?? "127.0.0.1",
      previewBind: str(env.SANDBOX_PREVIEW_BIND) ?? "127.0.0.1",
      snapshotDir: str(env.SANDBOX_SNAPSHOT_DIR) ?? ".data/sandbox-snapshots",
      snapshotMaxBytes: num(env.SANDBOX_SNAPSHOT_MAX_MB, 1024, 1, 64 * 1024) * 1024 * 1024,
    },
    e2b: {
      apiKey: str(env.E2B_API_KEY),
      domain: str(env.E2B_DOMAIN) ?? "e2b.app",
      template: str(env.E2B_TEMPLATE) ?? "base",
    },
    daytona: {
      apiKey: str(env.DAYTONA_API_KEY),
      apiUrl: (str(env.DAYTONA_API_URL) ?? "https://app.daytona.io/api").replace(/\/+$/, ""),
      snapshot: str(env.DAYTONA_SNAPSHOT),
    },
    resources: {
      cpus: num(env.SANDBOX_CPUS, 2, 0.25, 64),
      memoryMb: num(env.SANDBOX_MEMORY_MB, 2048, 128, 256 * 1024),
      pids: Math.round(num(env.SANDBOX_PIDS, 512, 16, 65536)),
      diskMb: Number.isFinite(disk) && disk > 0 ? Math.min(Math.max(Math.round(disk), 64), 1024 * 1024) : null,
    },
    idleSeconds: Math.round(num(env.SANDBOX_IDLE_MINUTES, 30, 1, 24 * 60) * 60),
    egressAllow: [...new Set([...DEFAULT_EGRESS_ALLOW, ...extra])],
  };
}

/** Does `host` match an allow-list entry (exact, or "*.suffix" for subdomains)? */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  return allow.some((a) => (a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a));
}
