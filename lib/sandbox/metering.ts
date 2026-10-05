// ShapesOS — Phase 15.2: sandbox minutes are metered.
//
// A hosted code sandbox (E2B / Daytona) is platform-paid compute, charged
// `sandbox_minute` credits per STARTED minute from creation to the end of
// its use: the earlier of when it was destroyed and when its idle timeout
// would have ended it after the last use (a sandbox that idled out is
// noticed late — the gap is not charged). A local Docker sandbox runs on the
// operator's own box and is not charged. The charge is idempotent per
// sandbox lifetime (row id + creation time), so a destroy that races or
// repeats never charges twice; it is recorded after the fact (the minutes
// were used), and a capped workspace is refused BEFORE a new paid sandbox
// starts (lib/sandbox/index.ts).

import { creditsFor } from "@/lib/metering/credits";

/** Providers whose minutes cost the platform money. */
export const PAID_SANDBOX_PROVIDERS: ReadonlySet<string> = new Set(["e2b", "daytona"]);

export function isPaidSandboxProvider(provider: string | null | undefined): boolean {
  return PAID_SANDBOX_PROVIDERS.has((provider ?? "").toLowerCase());
}

/** Pure: started minutes billed for one sandbox lifetime (≥ 1). */
export function sandboxBillableMinutes(args: {
  createdAt: Date;
  lastUsedAt: Date;
  endedAt: Date;
  idleSeconds: number;
}): number {
  const start = args.createdAt.getTime();
  const idleEnd = Math.max(args.lastUsedAt.getTime(), start) + Math.max(0, args.idleSeconds) * 1000;
  const end = Math.max(start, Math.min(args.endedAt.getTime(), idleEnd));
  return Math.max(1, Math.ceil((end - start) / 60_000));
}

/** Meter one ended sandbox (best-effort: metering never breaks the teardown). */
export async function meterSandboxLifetime(row: {
  id: string;
  workspaceId: string;
  runId: string;
  provider: string;
  createdAt: Date;
  lastUsedAt: Date;
  endedAt: Date;
  idleSeconds: number;
}): Promise<{ charged: number } | null> {
  if (!isPaidSandboxProvider(row.provider)) return null;
  const minutes = sandboxBillableMinutes(row);
  try {
    const { meter } = await import("@/lib/metering/service");
    const r = await meter({
      workspaceId: row.workspaceId,
      action: "sandbox_minute",
      credits: minutes * creditsFor("sandbox_minute"),
      keySource: "platform",
      afterTheFact: true,
      idempotencyKey: `sandbox:${row.id}:${row.createdAt.getTime()}`,
      evidenceRef: `agent_run:${row.runId}:${minutes}min`,
    });
    return r.ok ? { charged: r.charged } : null;
  } catch (err) {
    console.warn(`[sandbox] could not meter sandbox ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
