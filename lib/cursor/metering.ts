// ShapesOS — Phase 19A (WS=server): metering the agentic cursor.
//
//   cursor_talk_minute   — each started minute of hold-to-talk speech input,
//                          free within the plan's included minutes
//                          (lib/billing/entitlements.ts
//                          CURSOR_TALK_MINUTES_INCLUDED; Agency's are pooled),
//                          then charged at the STT provider's cost-plus price.
//   cursor_tts_1k_chars  — every started 1,000 characters of spoken answer at
//                          the TTS provider's cost-plus price.
//   The brain's model calls are metered as llm_tokens by the router (1.5×
//   cost; 0 credits on the workspace's own key). Agent mode is charged like
//   any agent run.
//
// The cap check happens BEFORE the provider is called (checkCap + capFits on
// the exact amount); the charge is recorded after with an idempotency key,
// so a retried request never charges twice.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CURSOR_TALK_POOLED_PLANS, cursorTalkMinutesIncluded } from "@/lib/billing/entitlements";
import type { SttProviderName } from "@/lib/voice/stt";
import type { TtsProviderName } from "@/lib/voice/tts";

// ── prices (PURE) ───────────────────────────────────────────────────────────

/**
 * Credits per talk minute past the included minutes, by STT provider: ~4×
 * vendor cost rounded up (checked 2026-10-06). AssemblyAI Universal-Streaming
 * $0.15/h = $0.0025/min → $0.01 → 1. Deepgram Nova-3 streaming $0.0077/min
 * (regular PAYG) → $0.0308 → 4. The labelled mock costs nothing.
 */
export const CURSOR_TALK_MINUTE_CREDITS: Readonly<Record<Exclude<SttProviderName, "none">, number>> = {
  assemblyai: 1,
  deepgram: 4,
  mock: 0,
};

/**
 * Credits per started 1,000 spoken characters, by TTS provider: ~4× vendor
 * cost rounded up (checked 2026-10-06). ElevenLabs Flash/Turbo $0.04/1k →
 * 16; ElevenLabs Multilingual $0.08/1k → 32; OpenAI tts-1 $0.015/1k → 6;
 * VoiceStudio is self-hosted (the operator's box) → 0; mock → 0.
 */
export const CURSOR_TTS_CREDITS_PER_1K = {
  elevenlabs_flash: 16,
  elevenlabs: 32,
  openai: 6,
  voicestudio: 0,
  mock: 0,
} as const;

export function ttsCreditsPer1k(provider: Exclude<TtsProviderName, "none">, model: string | null): number {
  if (provider === "elevenlabs") return model && /flash|turbo/i.test(model) ? CURSOR_TTS_CREDITS_PER_1K.elevenlabs_flash : CURSOR_TTS_CREDITS_PER_1K.elevenlabs;
  return CURSOR_TTS_CREDITS_PER_1K[provider];
}

/** Credits for one spoken answer: every STARTED 1,000 characters. */
export function ttsCredits(provider: Exclude<TtsProviderName, "none">, model: string | null, chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 1000) * ttsCreditsPer1k(provider, model);
}

/** Started minutes of a session of `seconds` (at least one). */
export function startedMinutes(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * The credits for each of `minutes` new talk minutes, given how many were
 * already used this period and how many the plan includes (null = unlimited).
 */
export function talkMinuteCharges(args: { usedBefore: number; minutes: number; included: number | null; perMinute: number }): number[] {
  const out: number[] = [];
  for (let i = 1; i <= Math.max(0, Math.floor(args.minutes)); i++) {
    const n = args.usedBefore + i;
    out.push(args.included === null || n <= args.included ? 0 : args.perMinute);
  }
  return out;
}

// ── talk minutes (DB) ───────────────────────────────────────────────────────

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface TalkAllowance {
  /** Workspace whose pool the minutes count against. */
  poolWorkspaceId: string;
  plan: string;
  /** null = unlimited (self-hosted). */
  included: number | null;
  used: number;
  periodStart: Date;
}

/** Talk minutes used this period and included by the plan (pooled for Agency). */
export async function talkAllowance(workspaceId: string, now: Date = new Date()): Promise<TalkAllowance> {
  const { resolvePoolWorkspaceId } = await import("@/lib/metering/service");
  const poolId = await resolvePoolWorkspaceId(prisma, workspaceId);
  const [owner, bal] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: poolId }, select: { plan: true } }),
    prisma.creditBalance.findUnique({ where: { workspaceId: poolId }, select: { periodStart: true } }),
  ]);
  const plan = owner?.plan ?? "self_hosted";
  const pooled = CURSOR_TALK_POOLED_PLANS.has(plan as never);
  // The credit period when the balance has one, else the calendar month (UTC).
  let periodStart = bal?.periodStart ?? monthStartUtc(now);
  if (now.getTime() - periodStart.getTime() > 31 * 86_400_000) periodStart = monthStartUtc(now);
  const where: Prisma.UsageEventWhereInput = {
    action: "cursor_talk_minute",
    occurredAt: { gte: periodStart },
    ...(pooled ? { OR: [{ chargedToWorkspaceId: poolId }, { workspaceId: poolId, chargedToWorkspaceId: null }] } : { workspaceId }),
  };
  const used = await prisma.usageEvent.count({ where });
  return { poolWorkspaceId: poolId, plan, included: cursorTalkMinutesIncluded(plan), used, periodStart };
}

export class CursorCapError extends Error {
  readonly status = 402;
  readonly code = "cap_reached";
  constructor(message: string) {
    super(message);
    this.name = "CursorCapError";
  }
}

/**
 * Check, BEFORE the provider is called, that `minutes` more talk minutes fit
 * the workspace's credits; returns the per-minute charges to record.
 */
export async function preflightTalkMinutes(workspaceId: string, minutes: number, provider: Exclude<SttProviderName, "none">): Promise<number[]> {
  const allowance = await talkAllowance(workspaceId);
  const charges = talkMinuteCharges({ usedBefore: allowance.used, minutes, included: allowance.included, perMinute: CURSOR_TALK_MINUTE_CREDITS[provider] });
  const total = charges.reduce((n, c) => n + c, 0);
  if (total > 0) {
    const { checkCap, capFits } = await import("@/lib/metering/service");
    const cap = await checkCap(workspaceId);
    if (!capFits(cap, total)) throw new CursorCapError("This workspace used its included talk minutes and has no credits left for more. Add credits or raise the cap in Settings → Usage.");
  }
  return charges;
}

/**
 * Record talk minutes `fromMinute`… of one session (idempotent per session +
 * minute index: a retried request never charges twice).
 */
export async function recordTalkMinutes(args: {
  workspaceId: string;
  actorId: string;
  sessionKey: string;
  /** 1-based index of the first minute recorded by this call. */
  fromMinute: number;
  charges: number[];
  provider: string;
}): Promise<{ charged: number }> {
  const { meter } = await import("@/lib/metering/service");
  let charged = 0;
  for (const [i, credits] of args.charges.entries()) {
    const n = args.fromMinute + i;
    const r = await meter({
      workspaceId: args.workspaceId,
      actorId: args.actorId,
      action: "cursor_talk_minute",
      credits,
      idempotencyKey: `cursor-talk:${args.sessionKey}:${n}`,
      evidenceRef: `cursor talk minute ${n} (${args.provider})`,
      // The pre-call check was the gate; the minute was spoken.
      afterTheFact: true,
    });
    if (r.ok) charged += r.charged;
  }
  return { charged };
}

/** Check BEFORE speaking that the answer's credits fit. */
export async function preflightTts(workspaceId: string, credits: number): Promise<void> {
  if (credits <= 0) return;
  const { checkCap, capFits } = await import("@/lib/metering/service");
  const cap = await checkCap(workspaceId);
  if (!capFits(cap, credits)) throw new CursorCapError("This workspace has no credits left for spoken answers. Add credits or raise the cap in Settings → Usage.");
}

export async function recordTts(args: { workspaceId: string; actorId: string; idempotencyKey: string; credits: number; provider: string; chars: number }): Promise<void> {
  const { meter } = await import("@/lib/metering/service");
  await meter({
    workspaceId: args.workspaceId,
    actorId: args.actorId,
    action: "cursor_tts_1k_chars",
    credits: args.credits,
    idempotencyKey: args.idempotencyKey,
    evidenceRef: `cursor speech ${args.chars} chars (${args.provider})`,
    afterTheFact: true,
  });
}
