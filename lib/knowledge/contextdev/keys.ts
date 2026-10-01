// Marketr — Wave 2 context.dev slice 1: vault API-key resolution.
//
// The Context.dev API key is a static key stored via lib/vault/apikey.ts
// storeApiKey (connectorKey "contextdev"). The tokenRef scheme matches the
// shared shape from Phase 18 slice 1 ("vault:oauth:<platform>:<connectionId>"
// — the scheme name predates key-based platforms but the pointer shape is
// shared). The key is never logged — errors carry codes only.

import { prisma } from "@/lib/prisma";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { storeApiKey } from "@/lib/vault/apikey";
import { createContextDevClient, ContextDevError } from "./client";

export const CONTEXTDEV_CONNECTOR_KEY = "contextdev";

export class ContextDevKeyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextDevKeyError";
    this.code = code;
  }
}

/** Parse "vault:oauth:contextdev:<connectionId>". Throws on any other shape. */
export function parseTokenRef(tokenRef: string): { platform: string; connectionId: string } {
  const m = /^vault:oauth:([a-z0-9-]+):(.+)$/.exec((tokenRef ?? "").trim());
  if (!m) {
    throw new ContextDevKeyError("BAD_TOKEN_REF", "tokenRef is not a vault reference");
  }
  return { platform: m[1], connectionId: m[2] };
}

export function tokenRefFor(connectionId: string): string {
  return `vault:oauth:contextdev:${connectionId}`;
}

/**
 * Validate a Context.dev API key with a single 1-credit scrape of the
 * stable example.com page. Returns true on any 2xx, false on auth failure.
 * Network errors propagate — a validation that cannot reach Context.dev
 * must not be reported as "invalid key".
 */
export async function validateContextDevKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const client = createContextDevClient({ apiKey }, fetchImpl);
  try {
    await client.scrapeMarkdown("https://example.com");
    return true;
  } catch (err) {
    if (err instanceof ContextDevError && err.code === "AUTH_FAILED") return false;
    throw err;
  }
}

/**
 * Store (or re-store) the workspace's Context.dev API key in the vault.
 * Does not call the API — call validateContextDevKey first from the route.
 */
export async function storeContextDevKey(
  userId: string,
  workspaceId: string,
  apiKey: string,
  label = "Context.dev",
): Promise<{ connectionId: string; tokenRef: string }> {
  if (!apiKey.trim()) {
    throw new ContextDevKeyError("EMPTY_KEY", "API key must not be empty");
  }
  const connection = await storeApiKey(userId, workspaceId, CONTEXTDEV_CONNECTOR_KEY, label, apiKey);
  return { connectionId: connection.id, tokenRef: tokenRefFor(connection.id) };
}

/**
 * Resolve the workspace's Context.dev API key from the vault.
 * Fail closed: no connection / wrong state / missing key → coded error.
 */
export async function resolveContextDevKey(
  workspaceId: string,
): Promise<{ apiKey: string; connectionId: string }> {
  const connection = await prisma.connectorConnection.findFirst({
    where: { workspaceId, connectorKey: CONTEXTDEV_CONNECTOR_KEY },
    select: { id: true, status: true },
  });
  if (!connection) {
    throw new ContextDevKeyError("NOT_CONNECTED", "No Context.dev API key connected for this workspace");
  }
  if (connection.status !== "active") {
    throw new ContextDevKeyError("CONNECTION_INACTIVE", "Context.dev connection is not active — reconnect the key");
  }
  const credential = await getDecryptedCredential(connection.id);
  const payload = credential?.payload;
  const apiKey = payload && typeof payload.apiKey === "string" ? payload.apiKey : null;
  if (!apiKey) {
    throw new ContextDevKeyError("REKEY_REQUIRED", "Vault credential has no API key — reconnect the Context.dev key");
  }
  return { apiKey, connectionId: connection.id };
}
