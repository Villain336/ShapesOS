// ShapesOS — Phase 15.2: Twilio voice minutes, number rental and
// transcription are metered (platform key, charged in credits).
//
//   call_minute                per started minute of a finished live call
//   call_transcription_minute  per started minute transcribed (live)
//   phone_number_month         per active live tracking number per month
//                              (at purchase, then on the monthly metering run)
//
// Only the LIVE Twilio provider is charged — the fake provider costs nothing.
// Every charge is recorded after the fact (the minutes / the rental already
// happened), idempotent per call / per number-month, and best-effort: a
// metering failure never breaks call finalisation. A capped workspace is
// refused BEFORE a new number is bought (assertCanBuyNumber). Inbound calls
// cannot be refused (the caller is already ringing), so they are recorded.
// lib/calls/meter.ts (minutes as a reporting dimension) is unchanged.

import { prisma } from "@/lib/prisma";
import { creditsFor } from "@/lib/metering/credits";

export function isLiveTelephony(provider: string | null | undefined): boolean {
  return (provider ?? "").toLowerCase() === "twilio";
}

/** Started minutes (Twilio bills per started minute). */
export function startedMinutes(durationSec: number): number {
  return Math.max(0, Math.ceil(Math.max(0, durationSec) / 60));
}

async function charge(args: {
  workspaceId: string;
  action: "call_minute" | "call_transcription_minute" | "phone_number_month";
  units: number;
  idempotencyKey: string;
  evidenceRef: string;
}): Promise<number> {
  if (args.units <= 0) return 0;
  try {
    const { meter } = await import("@/lib/metering/service");
    const r = await meter({
      workspaceId: args.workspaceId,
      action: args.action,
      credits: args.units * creditsFor(args.action),
      keySource: "platform",
      afterTheFact: true,
      idempotencyKey: args.idempotencyKey,
      evidenceRef: args.evidenceRef,
    });
    return r.ok ? r.charged : 0;
  } catch (err) {
    console.warn(`[calls] could not meter ${args.action}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Meter a finished call's voice minutes (and transcription, when it ran live). */
export async function meterCallUsage(call: {
  id: string;
  workspaceId: string;
  provider: string;
  durationSec: number;
  transcribed: boolean;
}): Promise<{ voice: number; transcription: number }> {
  if (!isLiveTelephony(call.provider)) return { voice: 0, transcription: 0 };
  const minutes = startedMinutes(call.durationSec);
  const voice = await charge({
    workspaceId: call.workspaceId,
    action: "call_minute",
    units: minutes,
    idempotencyKey: `call-minutes:${call.id}`,
    evidenceRef: `call:${call.id}:${minutes}min`,
  });
  const transcription = call.transcribed ? await meterCallTranscription(call) : 0;
  return { voice, transcription };
}

/** Meter a call's transcription once (status callback or transcription webhook — whichever comes first). */
export async function meterCallTranscription(call: { id: string; workspaceId: string; provider: string; durationSec: number }): Promise<number> {
  if (!isLiveTelephony(call.provider)) return 0;
  const minutes = Math.max(1, startedMinutes(call.durationSec));
  return charge({
    workspaceId: call.workspaceId,
    action: "call_transcription_minute",
    units: minutes,
    idempotencyKey: `call-transcription:${call.id}`,
    evidenceRef: `call:${call.id}:transcription`,
  });
}

/** Month key YYYY-MM (UTC). */
export function monthKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Meter one live number for one month (idempotent per number-month). */
export async function meterNumberMonth(args: { workspaceId: string; numberId: string; provider: string; month?: string }): Promise<number> {
  if (!isLiveTelephony(args.provider)) return 0;
  const month = args.month ?? monthKey();
  return charge({
    workspaceId: args.workspaceId,
    action: "phone_number_month",
    units: 1,
    idempotencyKey: `phone-number:${args.numberId}:${month}`,
    evidenceRef: `call-number:${args.numberId}:${month}`,
  });
}

/** Monthly run: every active live number of the workspace, once per month. */
export async function meterNumberRentals(workspaceId: string, month: string = monthKey()): Promise<{ numbers: number; charged: number }> {
  const numbers = await prisma.callNumber.findMany({
    where: { workspaceId, status: "active", provider: "twilio" },
    select: { id: true, provider: true },
  });
  let charged = 0;
  for (const n of numbers) charged += await meterNumberMonth({ workspaceId, numberId: n.id, provider: n.provider, month });
  return { numbers: numbers.length, charged };
}

/** Refuse buying a live number for a capped workspace. Null = allowed, else the message. */
export async function numberPurchaseDenial(workspaceId: string, provider: string): Promise<string | null> {
  if (!isLiveTelephony(provider)) return null;
  const { checkCap } = await import("@/lib/metering/service");
  const cap = await checkCap(workspaceId);
  if (cap.allowed) return null;
  return `Credit cap reached (${cap.used.toLocaleString()} of ${cap.capCredits.toLocaleString()} credits used). A tracking number costs ${creditsFor("phone_number_month")} credits a month — raise the cap or add credits in Settings → Usage.`;
}
