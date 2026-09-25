// Marketr — Phase 7 F1: circuit breakers.
//
// Five one-way ratchets (performance, spend-velocity, measurement,
// error-rate, attribution-regime). Evaluated every optimizer run plus a
// 15-minute watchdog.
//
// ONE-WAY BY CONSTRUCTION: breakers can only pause/freeze — never authorize
// spend. This module exports evaluation + acknowledgment only; there is no
// allow/authorize/approve path anywhere in it. After any breaker fires, the
// affected scope needs human acknowledgment PLUS a mandatory ≥72h cool-down
// before the optimizer may propose again.

import type { BreakerEvent, BreakerType } from "./types";

export interface BreakerSignals {
  channel: string;
  // performance
  cpa: number | null; // measured CPA (same currency units as target)
  targetCpa: number | null;
  spendCents: number;
  inLearning: boolean;
  // velocity
  dailySpendCents: number;
  dailyBudgetCents: number;
  hourOfDay: number; // 0-23 local
  // measurement
  eventVolume: number;
  expectedEventMean: number;
  expectedEventStd: number;
  // error-rate
  consecutiveDenials: number;
  consecutiveFailures: number;
  // attribution regime
  attributionModelChanged: boolean;
  attributionChangedAt?: string; // ISO
}

export interface BreakerTrip {
  breakerType: BreakerType;
  scope: string; // channel ref or "global"
  reason: string;
}

export const BREAKER_THRESHOLDS = {
  performanceCpaMultiple: 1.5,
  performanceMinSpendCents: 10_000, // $100
  velocitySpendPctBeforeNoon: 0.8, // 80% of budget before noon
  measurementSigma: 2,
  errorRateDenialLimit: 5,
  errorRateFailureLimit: 3,
  regimeStabilizationHours: 24 * 7, // one full stabilization window
  ackCooldownHours: 72,
} as const;

let breakerSeq = 0;
const breakerId = () => `brk_${Date.now().toString(36)}_${(breakerSeq++).toString(36)}`;

/**
 * Evaluate all five breakers against one channel's signals. Returns trips —
 * the caller freezes scope for each trip. Deterministic.
 */
export function evaluateBreakers(signals: BreakerSignals, now: Date = new Date()): BreakerTrip[] {
  const trips: BreakerTrip[] = [];
  const t = BREAKER_THRESHOLDS;

  // 1. Performance: CPA > 1.5× target AND spend > $100 AND not in learning.
  if (
    signals.cpa !== null &&
    signals.targetCpa !== null &&
    signals.targetCpa > 0 &&
    signals.cpa > t.performanceCpaMultiple * signals.targetCpa &&
    signals.spendCents > t.performanceMinSpendCents &&
    !signals.inLearning
  ) {
    trips.push({
      breakerType: "performance",
      scope: signals.channel,
      reason: `CPA ${signals.cpa.toFixed(2)} > ${t.performanceCpaMultiple}× target ${signals.targetCpa.toFixed(2)} with $${(signals.spendCents / 100).toFixed(2)} spend, not in learning`,
    });
  }

  // 2. Spend-velocity: >80% of daily budget before noon.
  if (
    signals.hourOfDay < 12 &&
    signals.dailyBudgetCents > 0 &&
    signals.dailySpendCents > t.velocitySpendPctBeforeNoon * signals.dailyBudgetCents
  ) {
    trips.push({
      breakerType: "velocity",
      scope: signals.channel,
      reason: `daily spend $${(signals.dailySpendCents / 100).toFixed(2)} > ${t.velocitySpendPctBeforeNoon * 100}% of $${(signals.dailyBudgetCents / 100).toFixed(2)} budget before noon`,
    });
  }

  // 3. Measurement: event volume outside ±2σ → GLOBAL freeze of mode (b).
  //    An outage masquerading as underperformance must not trigger shifts.
  {
    const lo = signals.expectedEventMean - t.measurementSigma * signals.expectedEventStd;
    const hi = signals.expectedEventMean + t.measurementSigma * signals.expectedEventStd;
    if (signals.eventVolume < lo || signals.eventVolume > hi) {
      trips.push({
        breakerType: "measurement",
        scope: "global",
        reason: `event volume ${signals.eventVolume} outside ±${t.measurementSigma}σ band [${lo.toFixed(0)}, ${hi.toFixed(0)}] on ${signals.channel} — never reallocate on broken measurement`,
      });
    }
  }

  // 4. Error-rate: consecutive policy denials or execution failures > N → pause the agent.
  if (signals.consecutiveDenials > t.errorRateDenialLimit) {
    trips.push({
      breakerType: "error_rate",
      scope: "global",
      reason: `${signals.consecutiveDenials} consecutive policy denials > ${t.errorRateDenialLimit} — agent paused; convert incident to regression test`,
    });
  }
  if (signals.consecutiveFailures > t.errorRateFailureLimit) {
    trips.push({
      breakerType: "error_rate",
      scope: "global",
      reason: `${signals.consecutiveFailures} consecutive execution failures > ${t.errorRateFailureLimit} — agent paused`,
    });
  }

  // 5. Attribution-regime: detected model/lookback change → freeze one full
  //    stabilization window; notify the human with before/after comparison.
  if (signals.attributionModelChanged) {
    const changedAt = signals.attributionChangedAt ? +new Date(signals.attributionChangedAt) : +now;
    const elapsedHrs = (+now - changedAt) / 3_600_000;
    if (elapsedHrs < t.regimeStabilizationHours) {
      trips.push({
        breakerType: "attribution_regime",
        scope: "global",
        reason: `attribution model/lookback changed ${elapsedHrs.toFixed(1)}h ago — frozen for one ${t.regimeStabilizationHours / 24}d stabilization window`,
      });
    }
  }

  return trips;
}

export function tripToEvent(
  trip: BreakerTrip,
  workspaceId: string,
  now: Date = new Date(),
): BreakerEvent {
  return {
    id: breakerId(),
    workspaceId,
    breakerType: trip.breakerType,
    scope: trip.scope,
    reason: trip.reason,
    firedAt: now.toISOString(),
    acknowledgedBy: null,
    acknowledgedAt: null,
    cooldownUntil: new Date(+now + BREAKER_THRESHOLDS.ackCooldownHours * 3_600_000).toISOString(),
  };
}

/** Human acknowledgment starts (not ends) the mandatory cool-down. */
export function acknowledgeBreaker(event: BreakerEvent, actor: string, now: Date = new Date()): BreakerEvent {
  if (event.acknowledgedBy) return event; // idempotent
  return {
    ...event,
    acknowledgedBy: actor,
    acknowledgedAt: now.toISOString(),
    cooldownUntil: new Date(+now + BREAKER_THRESHOLDS.ackCooldownHours * 3_600_000).toISOString(),
  };
}

/**
 * Is a scope frozen right now? A fired breaker freezes its scope until a
 * human acknowledges AND the mandatory cool-down elapses. Global trips
 * freeze every channel.
 */
export function isScopeFrozen(events: BreakerEvent[], scope: string, now: Date = new Date()): boolean {
  return events.some(
    (e) =>
      (e.scope === scope || e.scope === "global") &&
      (!e.acknowledgedBy || +new Date(e.cooldownUntil) > +now),
  );
}

/** Scopes currently frozen (for the run summary / UI). */
export function frozenScopes(events: BreakerEvent[], now: Date = new Date()): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (!e.acknowledgedBy || +new Date(e.cooldownUntil) > +now) out.add(e.scope);
  }
  return [...out];
}
