// Marketr — billing meter helper (spec §6 ApiUsage, §7 item 10).
// Meters: tracked_keywords / ai_words / serp_calls. Best-effort: callers
// swallow failures so metering never breaks a user flow.

import type { ApiMeter } from "@prisma/client";
import { prisma } from "./prisma";

export async function recordUsage(
  workspaceId: string,
  meter: ApiMeter,
  quantity: number,
): Promise<void> {
  const period = new Date().toISOString().slice(0, 7); // "2026-09"
  await prisma.apiUsage.upsert({
    where: { workspaceId_meter_period: { workspaceId, meter, period } },
    update: { quantity: { increment: quantity } },
    create: { workspaceId, meter, period, quantity },
  });
}
