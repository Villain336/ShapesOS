// Phase 21A round 2 (WS=agentweb): the deployment's Web Bot Auth keys and the public
// directory, on real Postgres as the app role.
//   - the first request creates ONE active key; racing creators still end with one;
//   - the private half is stored only as a secrets() envelope (never the raw scalar);
//   - the directory route lists public keys only, signed over the host it was asked on;
//   - rotation: a new active key, the old one retired but still listed during its grace,
//     then gone from the directory and prunable; an aged key rotates by itself;
//   - the signer's output verifies against what the directory says.
// Listed in scripts/test/db-tests.txt.
import "dotenv/config";
import { randomBytes } from "node:crypto";
process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { __resetKeyCache, directoryKeys, ensureActiveKey, pruneRetiredKeys, rotateKey, ROTATE_AFTER_DAYS, RETIRED_GRACE_DAYS } from "../identity/keys-store";
import { makeSigner } from "../identity/signer";
import { verifyDirectoryResponse, verifyRequest } from "../identity/httpsig";
import { GET as directoryRoute } from "@/app/.well-known/http-message-signatures-directory/route";

const DAY = 86_400_000;
const wipe = () => prisma.agentwebIdentityKey.deleteMany({});

before(async () => {
  await wipe();
  __resetKeyCache();
});
after(async () => {
  await wipe();
  await prisma.$disconnect();
});

describe("deployment signing key", () => {
  it("racing first requests end with exactly one active key", async () => {
    const keys = await Promise.all(Array.from({ length: 6 }, () => ensureActiveKey(new Date())));
    assert.equal(new Set(keys.map((k) => k.kid)).size, 1);
    assert.equal(await prisma.agentwebIdentityKey.count({ where: { status: "active" } }), 1);
  });

  it("stores the private half only as an envelope", async () => {
    const key = await ensureActiveKey(new Date());
    const [row] = await prisma.agentwebIdentityKey.findMany({});
    assert.ok(row!.privateEnc.length > 40);
    assert.ok(!row!.privateEnc.includes(key.d), "the raw private scalar is not in the stored value");
    assert.equal(row!.publicX, key.x);
  });
});

describe("the public directory route", () => {
  it("is signed over the asked host, lists public keys only, and matches what the signer uses", async () => {
    __resetKeyCache();
    const res = await directoryRoute(new Request("https://app.shapesos.test/.well-known/http-message-signatures-directory"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/http-message-signatures-directory+json");
    const text = await res.text();
    const body = JSON.parse(text);
    const key = await ensureActiveKey(new Date());
    assert.deepEqual(body.keys.map((k: { kid: string }) => k.kid), [key.kid]);
    assert.ok(!text.includes(key.d) && !/"d"\s*:/.test(text));
    const now = Math.floor(Date.now() / 1000);
    const headers = { "Signature-Input": res.headers.get("signature-input")!, Signature: res.headers.get("signature")! };
    assert.equal(verifyDirectoryResponse({ authority: "app.shapesos.test", headers, x: body.keys[0].x, now }).ok, true);
    assert.equal(verifyDirectoryResponse({ authority: "other.test", headers, x: body.keys[0].x, now }).ok, false);
    // a signer for this deployment produces requests the published key verifies
    const signed = await makeSigner({ keys: () => ensureActiveKey(), origin: "https://app.shapesos.test" })({ url: "https://shop.example/x" });
    assert.equal(verifyRequest({ url: "https://shop.example/x", headers: signed!, resolveKey: (id) => (body.keys.find((k: { kid: string }) => k.kid === id)?.x ?? null), now }).ok, true);
  });
});

describe("rotation", () => {
  it("rotateKey: new active key, old key retired but still listed during its grace, then gone", async () => {
    const t0 = new Date();
    const before = await ensureActiveKey(t0);
    const next = await rotateKey(t0);
    assert.notEqual(next.kid, before.kid);
    assert.equal(await prisma.agentwebIdentityKey.count({ where: { status: "active" } }), 1);
    assert.deepEqual((await directoryKeys(t0)).map((k) => k.kid).sort(), [before.kid, next.kid].sort());
    const later = new Date(t0.getTime() + (RETIRED_GRACE_DAYS + 1) * DAY);
    assert.deepEqual((await directoryKeys(later)).map((k) => k.kid), [next.kid]);
    assert.equal(await pruneRetiredKeys(later), 1);
    assert.equal(await prisma.agentwebIdentityKey.count(), 1);
  });

  it("an aged key rotates by itself on the next signing request", async () => {
    __resetKeyCache();
    const current = await ensureActiveKey(new Date());
    __resetKeyCache();
    const aged = await ensureActiveKey(new Date(Date.now() + (ROTATE_AFTER_DAYS + 1) * DAY));
    assert.notEqual(aged.kid, current.kid);
    assert.equal(await prisma.agentwebIdentityKey.count({ where: { status: "active" } }), 1);
    assert.equal((await prisma.agentwebIdentityKey.findUnique({ where: { id: current.kid } }))?.status, "retired");
  });

  it("pruneRetiredKeys({immediately}) is the emergency path after a suspected leak", async () => {
    const t = new Date();
    await rotateKey(t);
    assert.ok((await pruneRetiredKeys(new Date(t.getTime() + 200 * DAY), { immediately: true })) >= 1);
    assert.equal(await prisma.agentwebIdentityKey.count({ where: { status: "retired" } }), 0);
  });
});
