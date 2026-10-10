// ShapesOS — Phase 21A (WS=agentweb): receipts.
//
// A page changes; an agent's claim about it, or an action it took on it, has to
// be checkable later. Each browser step and each source an answer cites stores
// a CAPTURE: URL, fetch time, a hash of the page, a hash of its text and a short
// excerpt (and a screenshot reference only when the fetch went through a
// browser). The capture is signed (HMAC-SHA256) and an entry naming it is
// appended to the hash-chained audit log (lib/authority/audit.ts).
//
// Honesty: with no signing secret configured the capture says alg "none" and
// never verifies. A receipt is never reported as signed when it is not.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseHtml, visibleText } from "./html";
import { Redactor } from "./redact";

export interface Capture {
  id: string;
  url: string;
  fetchedAt: string;
  /** sha256 of the page source exactly as fetched. */
  domHash: string;
  /** sha256 of the visible text, whitespace-normalised: stable across markup changes. */
  textHash: string;
  excerpt: string;
  screenshotRef?: string;
}

export interface SignedCapture extends Capture {
  alg: "hmac-sha256" | "none";
  signature: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function captureOf(input: { url: string; html: string; fetchedAt: Date; screenshotRef?: string; excerptChars?: number; text?: string }): Capture {
  const text = (input.text ?? visibleText(parseHtml(input.html))).replace(/\s+/g, " ").trim();
  const domHash = sha256(input.html);
  const fetchedAt = input.fetchedAt.toISOString();
  return {
    id: `cap_${sha256(`${input.url}|${fetchedAt}|${domHash}`).slice(0, 20)}`,
    url: input.url,
    fetchedAt,
    domHash,
    textHash: sha256(text),
    excerpt: new Redactor().text(text).slice(0, input.excerptChars ?? 500),
    ...(input.screenshotRef ? { screenshotRef: input.screenshotRef } : {}),
  };
}

const canonical = (c: Capture) => JSON.stringify([c.id, c.url, c.fetchedAt, c.domHash, c.textHash, c.excerpt, c.screenshotRef ?? null]);

export function signCapture(c: Capture, secret: string | null): SignedCapture {
  if (!secret) return { ...c, alg: "none", signature: null };
  return { ...c, alg: "hmac-sha256", signature: createHmac("sha256", secret).update(canonical(c)).digest("hex") };
}

export function verifyCapture(s: SignedCapture, secret: string): boolean {
  if (s.alg !== "hmac-sha256" || !s.signature) return false;
  const expect = createHmac("sha256", secret).update(canonical(s)).digest();
  const got = Buffer.from(s.signature, "hex");
  return got.length === expect.length && timingSafeEqual(got, expect);
}

type Env = Record<string, string | undefined>;

/** The receipt signing key: derived from the app secret for this purpose only; null when none is set. */
export function receiptSecret(env: Env = process.env): string | null {
  const raw = [env.AUTH_SECRET, env.NEXTAUTH_SECRET, env.MARKETR_CREDENTIALS_KEY].map((s) => s?.trim()).find((s) => s && s.length >= 16);
  return raw ? createHmac("sha256", raw).update("shapes:agentweb-receipt:v1").digest("hex") : null;
}

export interface StepRecord {
  action: "navigate" | "click" | "type" | "snapshot" | "read" | "extract" | "answer";
  ref?: string;
  /** Element label (page text: clipped). Typed VALUES are never recorded. */
  name?: string;
  klass: string;
  tier: number;
  decision: string;
}

export interface ReceiptDeps {
  secret: string | null;
  store: (c: SignedCapture) => Promise<void>;
  audit: (e: { workspaceId: string; actor: string; action: string; entityType: string; entityId: string; detail: Record<string, unknown> }) => Promise<unknown>;
}

export async function recordReceipt(
  deps: ReceiptDeps,
  input: { workspaceId: string; actor: string; url: string; html: string; fetchedAt: Date; screenshotRef?: string; step: StepRecord; text?: string },
): Promise<SignedCapture & { auditError?: string }> {
  const signed = signCapture(captureOf({ url: input.url, html: input.html, fetchedAt: input.fetchedAt, screenshotRef: input.screenshotRef, text: input.text }), deps.secret);
  await deps.store(signed);
  try {
    await deps.audit({
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: "agentweb.step",
      entityType: "web_capture",
      entityId: signed.id,
      detail: {
        url: signed.url,
        domHash: signed.domHash,
        textHash: signed.textHash,
        signature: signed.signature,
        alg: signed.alg,
        step: input.step.action,
        ref: input.step.ref ?? null,
        name: input.step.name?.slice(0, 80) ?? null,
        klass: input.step.klass,
        tier: input.step.tier,
        decision: input.step.decision,
      },
    });
    return signed;
  } catch (err) {
    return { ...signed, auditError: err instanceof Error ? err.message : String(err) };
  }
}
