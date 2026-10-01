// Marketr — Wave 2 WFH mode slice 7: learning-signal recorder.
// Persists 13B learning-loop signals. Emission is best-effort by design: a
// signal write must never break the user's primary action, so callers wrap
// this in try/catch (or use recordLearningSignalSafe).

import { prisma } from "@/lib/prisma";
import type { LearningSignal } from "./dayview";

export async function recordLearningSignal(
  workspaceId: string,
  userId: string,
  signal: LearningSignal,
): Promise<void> {
  await prisma.wfhLearningSignal.create({
    data: {
      workspaceId,
      userId,
      signalType: signal.type,
      source: signal.source,
      payload: signal.payload as Record<string, string | number | boolean | null>,
      occurredAt: signal.occurredAt,
    },
  });
}

export async function recordLearningSignalSafe(
  workspaceId: string,
  userId: string,
  signal: LearningSignal,
): Promise<void> {
  try {
    await recordLearningSignal(workspaceId, userId, signal);
  } catch {
    // Best-effort: the 13B loop learns from what arrives; a missed signal is
    // a gap in the data, never a user-facing error.
  }
}
