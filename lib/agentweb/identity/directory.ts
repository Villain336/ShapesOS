// ShapesOS — Phase 21A round 2 (WS=agentweb): the public key directory (PURE).
//
// GET /.well-known/http-message-signatures-directory answers with the JWKS of our public
// keys, media type application/http-message-signatures-directory+json, signed with
// tag="http-message-signatures-directory" over the request authority (Cloudflare's Web Bot
// Auth page). Only public members (kty, crv, x, kid, use, nbf, exp) are ever written; the
// private scalar "d" cannot appear because it is not a field of DirectoryKey.

import type { DirectoryKey } from "./keys-store";
import { signDirectoryResponse, type KeyPair } from "./httpsig";

export const DIRECTORY_MEDIA_TYPE = "application/http-message-signatures-directory+json";
export const DIRECTORY_TTL_SEC = 300;

export function buildDirectoryResponse(input: { keys: DirectoryKey[]; signingKey: KeyPair; authority: string; nowSec: number }): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ keys: input.keys.map((k) => ({ kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, use: k.use, nbf: k.nbf, exp: k.exp })) });
  const sig = signDirectoryResponse({ authority: input.authority, keys: input.signingKey, created: input.nowSec, expires: input.nowSec + DIRECTORY_TTL_SEC });
  return {
    body,
    headers: {
      "content-type": DIRECTORY_MEDIA_TYPE,
      "cache-control": `public, max-age=${DIRECTORY_TTL_SEC}`,
      "Signature-Input": sig["Signature-Input"],
      Signature: sig.Signature,
    },
  };
}
