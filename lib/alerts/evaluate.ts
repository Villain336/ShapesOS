// Marketr — alert rules engine (milestone 13).
//
// Event sources call emitAlert(). For each enabled rule on the trigger:
// conditions filter → dedup/cooldown suppression → quiet-hours hold or
// digest queue → immediate delivery. Rule evaluation never throws into the
// caller — a rule engine failure must not break rank checks, fix runs, or
// report generation, so emitAlert swallows per-rule errors and returns
// per-rule outcomes.

import { prisma } from "@/lib/prisma";
import type { AlertRule } from "@prisma/client";
import { triggerDef } from "./triggers";
import { deliverEvent, inQuietHours } from "./dispatch";
import type { AlertLink } from "./adapters";

export interface RuleConditions {
  projectIds?: string[];
  keywordIds?: string[];
  thresholdPositions?: number;
  severities?: string[];
  thresholdPoints?: number;
}

export interface TriggerInput {
  workspaceId: string;
  projectId?: string | null;
  trigger: string;
  severity?: "info" | "warn" | "critical";
  title: string;
  body: string;
  /** Deep link into the dashboard (dashboard base URL comes from env). */
  link?: string;
  /** Extra links appended to the message. */
  links?: AlertLink[];
  /** Dedup key, e.g. "rank_drop:<keywordId>:<yyyy-mm-dd>". */
  dedupKey?: string;
  /** Positions moved (positive number) for rank_drop / rank_gain thresholds. */
  movement?: number;
  /** Score points moved (signed) for visibility_delta thresholds. */
  delta?: number;
  scopeKeywordIds?: string[];
}

export interface EmitOutcome {
  ruleId: string;
  ruleName: string;
  eventId: string | null;
  status: "sent" | "failed" | "queued" | "suppressed" | "skipped" | "error";
  error?: string;
}

const DEFAULT_DROP_THRESHOLD = 10; // spec M13 done criterion: "drop a keyword 10 spots"
const DEFAULT_GAIN_THRESHOLD = 5;

function conditionsOf(rule: AlertRule): RuleConditions {
  return (rule.conditions as RuleConditions | null) ?? {};
}

/** Merge a dashboard base URL with a relative link when one is configured. */
export function absoluteLink(link: string): string {
  if (/^https?:\/\//.test(link)) return link;
  const base = (process.env.MARKETR_BASE_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}${link.startsWith("/") ? link : `/${link}`}` : link;
}

function matchesConditions(rule: AlertRule, input: TriggerInput): boolean {
  const c = conditionsOf(rule);
  if (c.projectIds?.length && input.projectId && !c.projectIds.includes(input.projectId)) return false;
  if (c.keywordIds?.length && !input.scopeKeywordIds?.some((k: string) => c.keywordIds!.includes(k))) return false;
  if (input.trigger === "rank_drop" || input.trigger === "rank_gain") {
    const threshold = c.thresholdPositions ?? (input.trigger === "rank_drop" ? DEFAULT_DROP_THRESHOLD : DEFAULT_GAIN_THRESHOLD);
    if ((input.movement ?? 0) < threshold) return false;
  }
  if (input.trigger === "fix_run" || input.trigger === "content_decay" || input.trigger === "negative_review" || input.trigger === "legal_deadline" || input.trigger === "legal_document_expiry" || input.trigger === "funding_followup") {
    if (c.severities?.length && input.severity && !c.severities.includes(input.severity)) return false;
  }
  if (input.trigger === "visibility_delta" || input.trigger === "geo_grid_change") {
    const threshold = c.thresholdPoints ?? 5;
    if (Math.abs(input.delta ?? 0) < threshold) return false;
  }
  return true;
}

async function evaluateRule(rule: AlertRule, input: TriggerInput): Promise<EmitOutcome> {
  const outcome = (status: EmitOutcome["status"], eventId: string | null = null, error?: string): EmitOutcome => ({
    ruleId: rule.id,
    ruleName: rule.name,
    eventId,
    status,
    ...(error ? { error } : {}),
  });

  if (!matchesConditions(rule, input)) return outcome("skipped");

  const now = new Date();
  const cooldownMs = Math.max(0, rule.cooldownSec) * 1000;

  // Dedup / cooldown: suppress re-fire for the same dedup key inside the window.
  if (input.dedupKey && cooldownMs > 0) {
    const recent = await prisma.alertEvent.findFirst({
      where: {
        dedupKey: input.dedupKey,
        status: { in: ["queued", "sent"] },
        createdAt: { gte: new Date(now.getTime() - cooldownMs) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (recent) {
      const suppressed = await prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          workspaceId: rule.workspaceId,
          trigger: input.trigger,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          dedupKey: input.dedupKey,
          status: "suppressed",
          results: [{ suppressedBy: recent.id }] as unknown as object,
        },
      });
      return outcome("suppressed", suppressed.id);
    }
  } else if (!input.dedupKey && cooldownMs > 0 && rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < cooldownMs) {
    const suppressed = await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        workspaceId: rule.workspaceId,
        trigger: input.trigger,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        status: "suppressed",
        results: [{ suppressedBy: "rule cooldown" }] as unknown as object,
      },
    });
    return outcome("suppressed", suppressed.id);
  }

  const links = [...(input.links ?? [])];
  const link = input.link ? absoluteLink(input.link) : undefined;
  if (link && !links.some((l) => l.url === link)) links.unshift({ label: "Open in Marketr", url: link });

  const qh = (rule.quietHours as { start?: string; end?: string } | null) ?? null;
  const inQuiet = qh?.start && qh?.end ? inQuietHours(qh, now) : false;
  const queueReason = rule.digest === "daily_digest" ? "digest" : inQuiet ? "quiet" : null;

  const event = await prisma.alertEvent.create({
    data: {
      ruleId: rule.id,
      workspaceId: rule.workspaceId,
      trigger: input.trigger,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 4000),
      link: link ?? null,
      dedupKey: input.dedupKey ?? null,
      status: "queued", // deliverEvent() sets the final status for immediate rules
      queueReason,
    },
  });

  if (queueReason) return outcome("queued", event.id);

  const delivered = await deliverEvent(event.id);
  return outcome(delivered.status === "sent" ? "sent" : "failed", delivered.id);
}

/**
 * Fan a trigger out to every enabled matching rule. Never rejects —
 * per-rule failures are captured in the outcome rows.
 */
export async function emitAlert(input: TriggerInput): Promise<EmitOutcome[]> {
  const def = triggerDef(input.trigger);
  if (!def) throw new Error(`unknown alert trigger: ${input.trigger}`);

  const rules = await prisma.alertRule.findMany({
    where: { workspaceId: input.workspaceId, enabled: true, trigger: input.trigger },
  });

  const outcomes: EmitOutcome[] = [];
  for (const rule of rules) {
    try {
      outcomes.push(await evaluateRule(rule, input));
    } catch (err) {
      outcomes.push({
        ruleId: rule.id,
        ruleName: rule.name,
        eventId: null,
        status: "error",
        error: err instanceof Error ? err.message.slice(0, 200) : "rule evaluation failed",
      });
    }
  }
  return outcomes;
}
