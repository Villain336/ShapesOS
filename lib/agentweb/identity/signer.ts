// ShapesOS — Phase 21A round 2 (WS=agentweb): the deployment's request signer.
//
// Web Bot Auth needs an HTTPS identity URL whose /.well-known/http-message-signatures-
// directory lists our public keys. That URL is this deployment's public origin (APP_URL,
// else NEXTAUTH_URL). Without an https origin (local dev, a LAN install) there is nothing a
// verifier could fetch, so requests go out unsigned, still carrying the honest user agent:
// signing with an identity nobody can resolve would only look broken.

import { ensureActiveKey } from "./keys-store";
import { signRequest, type KeyPair } from "./httpsig";
import type { Signer } from "./agent-fetch";

export const SIGNATURE_TTL_SEC = 60;
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** The agent's identity origin (https only), or null. */
export function agentIdentityOrigin(env: Record<string, string | undefined> = process.env): string | null {
  for (const raw of [env.APP_URL, env.NEXTAUTH_URL]) {
    try {
      if (raw) {
        const u = new URL(raw);
        if (u.protocol === "https:") return u.origin;
      }
    } catch {
      /* not a URL */
    }
  }
  return null;
}

export function makeSigner(opts: { keys: () => Promise<KeyPair>; origin: string; nowSec?: () => number }): Signer {
  return async ({ url, method }) => {
    const created = Math.floor((opts.nowSec ?? (() => Date.now() / 1000))());
    return signRequest({ url, method, keys: await opts.keys(), created, expires: created + SIGNATURE_TTL_SEC, signatureAgent: { url: opts.origin } });
  };
}

let shared: Signer | null | undefined;

/** The deployment's signer, or null when it has no https identity. */
export function deploymentSigner(env: Record<string, string | undefined> = process.env): Signer | null {
  if (env === process.env && shared !== undefined) return shared;
  const origin = agentIdentityOrigin(env);
  const s = origin ? makeSigner({ keys: () => ensureActiveKey(), origin }) : null;
  if (env === process.env) shared = s;
  return s;
}

/** Test seam. */
export function __resetSigner(): void {
  shared = undefined;
}
