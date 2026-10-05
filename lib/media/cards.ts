// Marketr — Phase 5 S2: virtual-card provider abstraction.
//
// The money-layer backstop (dual enforcement, docs/specs/SPEC-PHASE5.md §2 S2): a
// virtual card per pool, issued on the CLIENT's own Brex/Ramp account with
// limit = pool cap. Card declines survive Marketr software bugs — this is
// the layer that kills the €7,937/day failure class (Apr 2026: no
// account-level ceiling existed, so a compounding automation bug ran to
// €7,937/day in 4 days).
//
// HARD RULES:
// - Marketr stores ONLY the virtual_card_ref in its DB. Never PANs, never
//   in logs, never in event payloads.
// - Cards are issued on the client's own Brex/Ramp account only
//   (providerAccountRef). Marketr never fronts media on the agency's card.
// - FakeCardProvider is the default. Brex/Ramp adapters are test-mode-first:
//   test mode simulates deterministically; live mode requires explicit env
//   keys AND is impossible without a human-approved per-buy approval.

import { createHash, randomBytes } from "node:crypto";
import { SafetyViolationError } from "./safety";
import { fakeOrRefuse } from "@/lib/env/secrets";

export type CardProviderName = "fake" | "brex" | "ramp";
export type VirtualCardStatus = "active" | "suspended" | "closed";

export interface VirtualCard {
  provider: CardProviderName;
  /** The ONLY card identifier Marketr ever persists. Not a PAN. */
  cardRef: string;
  status: VirtualCardStatus;
  limitCents: number;
  currency: string;
  /** UI-safe hint (last 4) — safe for logs. Never the full number. */
  last4Hint?: string;
}

export interface IssueCardInput {
  poolId: string;
  workspaceId: string;
  limitCents: number;
  currency: string;
  /** The CLIENT's Brex/Ramp account ref — never an agency account. */
  providerAccountRef: string;
  memo: string;
}

export interface VirtualCardProvider {
  readonly name: CardProviderName;
  issueCard(input: IssueCardInput): Promise<VirtualCard>;
  getCard(cardRef: string): Promise<VirtualCard | null>;
  setLimit(cardRef: string, limitCents: number): Promise<VirtualCard>;
  suspendCard(cardRef: string, reason: string): Promise<void>;
  closeCard(cardRef: string, reason: string): Promise<void>;
}

export class CardProviderError extends SafetyViolationError {
  constructor(message: string) {
    super(message);
    this.name = "CardProviderError";
  }
}

export class ProviderNotConfiguredError extends CardProviderError {
  constructor(provider: string, missing: string) {
    super(`${provider} card provider is not configured (missing ${missing})`);
    this.name = "ProviderNotConfiguredError";
  }
}

function assertClientAccount(ref: string): void {
  if (!ref || !ref.trim()) {
    throw new CardProviderError(
      "A client-owned Brex/Ramp account ref is required — ShapesOS never issues cards on agency accounts.",
    );
  }
}

// ---------------------------------------------------------------------------
// FakeCardProvider (default). Deterministic, no network, no real money.
// ---------------------------------------------------------------------------

export class FakeCardProvider implements VirtualCardProvider {
  readonly name = "fake" as const;
  private cards = new Map<string, VirtualCard>();
  /** Ref namespace. Adapters (brex/ramp test mode) override so the STORED key
   *  matches the RETURNED ref — previously the adapter rewrote the ref after
   *  storing, so getCard/setLimit on the returned ref missed. */
  protected refPrefix = "vcard_fake_";

  /** Adapter seam: namespace refs without breaking stored-key identity. */
  setRefPrefix(prefix: string): void {
    this.refPrefix = prefix;
  }

  private refFor(input: IssueCardInput): string {
    const seed = `${input.workspaceId}:${input.poolId}:${input.providerAccountRef}`;
    return `${this.refPrefix}${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16)}`;
  }

  async issueCard(input: IssueCardInput): Promise<VirtualCard> {
    assertClientAccount(input.providerAccountRef);
    if (!Number.isInteger(input.limitCents) || input.limitCents <= 0) {
      throw new CardProviderError("Card limit must be a positive integer (limit = pool cap).");
    }
    const cardRef = this.refFor(input);
    const card: VirtualCard = {
      provider: "fake",
      cardRef,
      status: "active",
      limitCents: input.limitCents,
      currency: input.currency.toUpperCase(),
      last4Hint: "••••" + cardRef.slice(-4),
    };
    this.cards.set(cardRef, card);
    return { ...card };
  }

  async getCard(cardRef: string): Promise<VirtualCard | null> {
    const c = this.cards.get(cardRef);
    return c ? { ...c } : null;
  }

  async setLimit(cardRef: string, limitCents: number): Promise<VirtualCard> {
    const c = this.cards.get(cardRef);
    if (!c) throw new CardProviderError(`Virtual card not found: ${cardRef}`);
    const next = { ...c, limitCents };
    this.cards.set(cardRef, next);
    return { ...next };
  }

  async suspendCard(cardRef: string, reason: string): Promise<void> {
    const c = this.cards.get(cardRef);
    if (!c) throw new CardProviderError(`Virtual card not found: ${cardRef}`);
    this.cards.set(cardRef, { ...c, status: "suspended" });
    void reason;
  }

  async closeCard(cardRef: string, reason: string): Promise<void> {
    const c = this.cards.get(cardRef);
    if (!c) throw new CardProviderError(`Virtual card not found: ${cardRef}`);
    this.cards.set(cardRef, { ...c, status: "closed" });
    void reason;
  }
}

// ---------------------------------------------------------------------------
// Brex / Ramp adapters — test-mode-first.
// ---------------------------------------------------------------------------

export type CardAdapterMode = "test" | "live";

export interface CardAdapterOptions {
  mode: CardAdapterMode;
  apiKey?: string;
}

abstract class TestModeCardAdapter implements VirtualCardProvider {
  abstract readonly name: CardProviderName;
  protected fake: FakeCardProvider;
  protected mode: CardAdapterMode;
  protected envPrefix: string;

  constructor(opts: CardAdapterOptions, envPrefix: string, refPrefix: string) {
    this.mode = opts.mode;
    this.envPrefix = envPrefix;
    // Namespace the fake's refs so stored key === returned ref.
    this.fake = new FakeCardProvider();
    this.fake.setRefPrefix(refPrefix);
  }

  protected requireLiveKey(): string {
    if (this.mode !== "live") {
      throw new CardProviderError(
        `${this.name} adapter is in test mode — live issuance requires mode=live and provider keys.`,
      );
    }
    const key = process.env[`${this.envPrefix}_API_KEY`];
    if (!key) throw new ProviderNotConfiguredError(this.name, `${this.envPrefix}_API_KEY`);
    return key;
  }

  async issueCard(input: IssueCardInput): Promise<VirtualCard> {
    assertClientAccount(input.providerAccountRef);
    if (this.mode === "test") {
      // Deterministic simulation. The fake's ref prefix is already namespaced
      // to this adapter, so the stored key === the returned ref (no rewrite).
      const card = await this.fake.issueCard(input);
      return { ...card, provider: this.name };
    }
    // LIVE: wire the provider SDK here. v1 ships test-mode-first; this path
    // is unreachable without explicit env keys (requireLiveKey throws).
    this.requireLiveKey();
    throw new CardProviderError(
      `${this.name} live issuance is not wired in v1 — test mode only. ` +
        `Wire the ${this.name} virtual-cards SDK here before enabling live.`,
    );
  }

  async getCard(cardRef: string): Promise<VirtualCard | null> {
    return this.fake.getCard(cardRef);
  }
  async setLimit(cardRef: string, limitCents: number): Promise<VirtualCard> {
    return this.fake.setLimit(cardRef, limitCents);
  }
  async suspendCard(cardRef: string, reason: string): Promise<void> {
    return this.fake.suspendCard(cardRef, reason);
  }
  async closeCard(cardRef: string, reason: string): Promise<void> {
    return this.fake.closeCard(cardRef, reason);
  }
}

export class BrexCardAdapter extends TestModeCardAdapter {
  readonly name = "brex" as const;
  constructor(opts: CardAdapterOptions = { mode: "test" }) {
    super(opts, "BREX", "vcard_brex_test_");
  }
}

export class RampCardAdapter extends TestModeCardAdapter {
  readonly name = "ramp" as const;
  constructor(opts: CardAdapterOptions = { mode: "test" }) {
    super(opts, "RAMP", "vcard_ramp_test_");
  }
}

export function cardAdapterMode(env: NodeJS.ProcessEnv = process.env): CardAdapterMode {
  return env.MEDIA_CARD_MODE === "live" ? "live" : "test";
}

/**
 * Fake default (safe). Brex/Ramp adapters are test-mode-first; live mode
 * requires MEDIA_CARD_MODE=live AND provider API keys, and is unreachable
 * from any execution path that lacks a human-approved per-buy approval.
 */
export function cardProviderFor(name: CardProviderName, env: NodeJS.ProcessEnv = process.env): VirtualCardProvider {
  const mode = cardAdapterMode(env);
  switch (name) {
    case "brex":
      return new BrexCardAdapter({ mode });
    case "ramp":
      return new RampCardAdapter({ mode });
    case "fake":
    default:
      // Phase 11 (conncore): fake virtual cards are refused in production.
      return fakeOrRefuse("virtual card", () => new FakeCardProvider(), env);
  }
}

export function randomRef(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}
