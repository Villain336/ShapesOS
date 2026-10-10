// ShapesOS — Phase 21A round 2 (WS=agentweb): the deployment's Web Bot Auth keys at rest.
//
// One Ed25519 key pair per deployment (not per workspace: the identity is "ShapesOS agent
// traffic from this install"). The private half is stored ONLY as a secrets() envelope in
// agentweb_identity_keys: AES-256-GCM under MARKETR_CREDENTIALS_KEY by default, the
// managed KMS provider on hosted (lib/secrets). There is no env variable that holds the
// signing key, plaintext or otherwise, on any deployment.
//
// Rotation story:
//   - a key is active for ROTATE_AFTER_DAYS (90); the first signing request after that
//     creates a new key (ensureActiveKey) and retires the old one;
//   - a retired key stays in the public directory for RETIRED_GRACE_DAYS (7), so a
//     signature made just before the rotation (valid at most 24 h) and verifiers' cached
//     directories keep working; then pruneRetiredKeys deletes it;
//   - rotateKey() does the same on demand (suspected leak, staff change): the operator
//     calls it, and may prune immediately;
//   - at most one active key exists (a partial unique index); two instances racing to make
//     the first key both end up using the winner's.
// Verifiers learn the new key from the directory (they re-fetch on an unknown keyid); the
// agent's identity URL never changes. Cloudflare's verified-agents programme is an owner
// step (UNVERIFIED-LIVE).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import { generateKeyPair, keyPairFromJwk, type KeyPair } from "./httpsig";

export const ROTATE_AFTER_DAYS = 90;
export const RETIRED_GRACE_DAYS = 7;
const DAY = 86_400_000;
const CACHE_MS = 60_000;

let cache: { key: KeyPair; until: number } | null = null;

/** Test seam. */
export function __resetKeyCache(): void {
  cache = null;
}

type Row = { id: string; publicX: string; privateEnc: string };
const load = (row: Row): KeyPair => keyPairFromJwk({ x: row.publicX, d: secrets().decrypt(row.privateEnc) });

async function create(now: Date): Promise<KeyPair | null> {
  const pair = generateKeyPair();
  try {
    await prisma.agentwebIdentityKey.create({
      data: { id: pair.kid, publicX: pair.x, privateEnc: secrets().encrypt(pair.d), status: "active", createdAt: now, rotateAfter: new Date(now.getTime() + ROTATE_AFTER_DAYS * DAY) },
    });
    return pair;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null; // someone else made the first key
    throw err;
  }
}

/** The key to sign with now; creates the first key, or rotates an old one. */
export async function ensureActiveKey(now: Date = new Date()): Promise<KeyPair> {
  if (cache && cache.until > now.getTime()) return cache.key;
  let row = await prisma.agentwebIdentityKey.findFirst({ where: { status: "active" } });
  if (row && row.rotateAfter.getTime() <= now.getTime()) {
    await rotateKey(now);
    row = await prisma.agentwebIdentityKey.findFirst({ where: { status: "active" } });
  }
  let key: KeyPair | null = row ? load(row) : await create(now);
  if (!key) {
    row = await prisma.agentwebIdentityKey.findFirst({ where: { status: "active" } });
    if (!row) throw new Error("Could not create or read the agent signing key.");
    key = load(row);
  }
  cache = { key, until: now.getTime() + CACHE_MS };
  return key;
}

/** Retire the active key and make a new one active. Returns the new key. */
export async function rotateKey(now: Date = new Date()): Promise<KeyPair> {
  cache = null;
  await prisma.agentwebIdentityKey.updateMany({ where: { status: "active" }, data: { status: "retired", retiredAt: now } });
  const key = await create(now);
  if (!key) throw new Error("Another instance rotated the signing key at the same moment.");
  cache = { key, until: now.getTime() + CACHE_MS };
  return key;
}

export interface DirectoryKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  nbf: number;
  exp: number;
}

/** What the public directory lists: the active key and retired keys still inside their grace. */
export async function directoryKeys(now: Date = new Date()): Promise<DirectoryKey[]> {
  const rows = await prisma.agentwebIdentityKey.findMany({ orderBy: { createdAt: "desc" } });
  const out: DirectoryKey[] = [];
  for (const r of rows) {
    if (r.status === "retired" && (!r.retiredAt || r.retiredAt.getTime() + RETIRED_GRACE_DAYS * DAY <= now.getTime())) continue;
    const expMs = r.status === "active" ? r.rotateAfter.getTime() + RETIRED_GRACE_DAYS * DAY : (r.retiredAt as Date).getTime() + RETIRED_GRACE_DAYS * DAY;
    out.push({ kty: "OKP", crv: "Ed25519", x: r.publicX, kid: r.id, use: "sig", nbf: Math.floor(r.createdAt.getTime() / 1000), exp: Math.floor(expMs / 1000) });
  }
  return out;
}

export async function pruneRetiredKeys(now: Date = new Date(), opts: { immediately?: boolean } = {}): Promise<number> {
  const cutoff = opts.immediately ? now : new Date(now.getTime() - RETIRED_GRACE_DAYS * DAY);
  const r = await prisma.agentwebIdentityKey.deleteMany({ where: { status: "retired", retiredAt: { lte: cutoff } } });
  return r.count;
}
