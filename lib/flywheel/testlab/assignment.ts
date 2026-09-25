// Marketr — Test Lab assignment layer (F3).
//
// Four channels, four assignment strategies:
//   web   → GrowthBook-JS-SDK-compatible feature manifest, self-hosted,
//           local evaluation (no per-check HTTP).
//   email → native splitter in nurture sends (Phase 3 infra). Wires to the
//           real nurture send path when it is importable; behind an interface
//           with a fake implementation otherwise.
//   ads   → platform-native experiments. Marketr holds the hypothesis and
//           IMPORTS results — it never re-runs ad delivery.
//   mail  → Phase 4 split drops (deterministic list partitioning).
//
// Fake/test mode is the default. Real senders throw NotConfiguredError.

import type { Experiment, ExperimentVariant } from "./experiment";

export class NotConfiguredError extends Error {
  readonly provider: string;
  constructor(provider: string, hint: string) {
    super(`${provider} is not configured: ${hint}`);
    this.name = "NotConfiguredError";
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Web — self-hosted GrowthBook-compatible manifest
// ---------------------------------------------------------------------------

export interface WebManifestFeature {
  key: string;
  defaultValue: string;
  rules: {
    condition: Record<string, unknown>;
    variations: string[];
    weights: number[];
    coverage: number;
    key: string;
  }[];
}

/**
 * Build a self-hosted feature manifest compatible with the GrowthBook JS SDK
 * evaluation semantics (local evaluation: attributes + deterministic hashing
 * client-side, no per-check HTTP back to Marketr).
 */
export function buildWebManifest(exp: Experiment): { features: Record<string, WebManifestFeature> } {
  const key = `exp_${exp.id}`;
  const variations = exp.variants.map((v) => v.id);
  const weights = exp.variants.map((v) => v.weight);
  return {
    features: {
      [key]: {
        key,
        defaultValue: variations[0] ?? "control",
        rules: [
          {
            condition: { experiment: key },
            variations,
            weights,
            coverage: 1,
            key,
          },
        ],
      },
    },
  };
}

/** Deterministic bucketing (FNV-1a) — mirrors SDK local evaluation semantics. */
export function bucketUnit(unitId: string, experimentKey: string, nVariations: number): number {
  let h = 0x811c9dc5;
  const s = `${experimentKey}:${unitId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % nVariations;
}

/** Assign a unit to a variant id using weights (web). */
export function assignWebVariant(unitId: string, exp: Experiment): string {
  const seed = `${exp.id}:${unitId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const r = (h >>> 0) / 0xffffffff;
  let acc = 0;
  for (const v of exp.variants) {
    acc += v.weight;
    if (r < acc) return v.id;
  }
  return exp.variants[exp.variants.length - 1].id;
}

// ---------------------------------------------------------------------------
// Email — native splitter in nurture sends (Phase 3)
// ---------------------------------------------------------------------------

export interface EmailSplitPlan {
  experimentId: string;
  variantSubjects: Record<string, string>;
  variantBodies: Record<string, string>;
  /** deterministic recipient → variant mapping */
  assign: (recipientId: string) => string;
}

export interface NurtureSendPort {
  /** Send one variant to one recipient through Marketr's send path. */
  sendVariant(args: {
    workspaceId: string;
    experimentId: string; variantId: string; recipientId: string;
    subject: string; body: string;
  }): Promise<{ messageId: string }>;
}

/** Fake nurture port: records sends in memory. Real port throws until wired. */
export function createFakeNurturePort(): NurtureSendPort & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async sendVariant(args) {
      const messageId = `fake_${Date.now()}_${sent.length}`;
      sent.push({ ...args, messageId });
      return { messageId };
    },
  };
}

/**
 * Resolve the nurture send port.
 *
 * REAL (opt-in): built on `queueMessage` (lib/messaging/dispatcher.ts) — the
 * Phase 3 send path, which routes through Marketr's approval queue. Variant
 * content is queued as kind "broadcast" with the experiment/variant recorded
 * in requestedBy, so a human approval gates the send like any other outbound
 * message. Enable with TESTLAB_REAL_SEND=1.
 *
 * FAKE (default): in-memory recorder. The resolved `real` flag is always
 * honest — the port never silently pretends to be real.
 */
export async function resolveNurturePort(): Promise<{ port: NurtureSendPort; real: boolean }> {
  if (process.env.TESTLAB_REAL_SEND === "1") {
    try {
      const { queueMessage } = await import("@/lib/messaging/dispatcher");
      const real: NurtureSendPort = {
        async sendVariant(args) {
          const msg = await queueMessage({
            workspaceId: args.workspaceId,
            leadId: args.recipientId,
            channel: "email",
            kind: "broadcast",
            subject: args.subject,
            body: args.body,
            requestedBy: `testlab:${args.experimentId}:${args.variantId}`,
          });
          return { messageId: msg.id };
        },
      };
      return { port: real, real: true };
    } catch {
      // fall through to fake — never silently pretend
    }
  }
  return { port: createFakeNurturePort(), real: false };
}

export function buildEmailSplitPlan(exp: Experiment, variants: Record<string, { subject: string; body: string }>): EmailSplitPlan {
  return {
    experimentId: exp.id,
    variantSubjects: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.subject])),
    variantBodies: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.body])),
    assign: (recipientId: string) => assignWebVariant(recipientId, exp),
  };
}

// ---------------------------------------------------------------------------
// Ads — platform-native experiment import
// ---------------------------------------------------------------------------

export interface AdsExperimentImport {
  platform: "meta" | "google" | "tiktok" | "other";
  platformExperimentId: string;
  hypothesisRef: string;
  /** Marketr imports results; it never re-runs delivery. */
  status: "imported" | "pending";
}

export function createAdsImport(exp: Experiment, platform: AdsExperimentImport["platform"], platformExperimentId: string): AdsExperimentImport {
  return {
    platform,
    platformExperimentId,
    hypothesisRef: exp.id,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Mail — Phase 4 split drops
// ---------------------------------------------------------------------------

/**
 * Deterministic list partitioning for direct-mail split drops.
 *
 * Builds a balanced INTERLEAVED sequence: each position goes to the variant
 * most behind its fair share (largest-remainder style), so even tiny lists
 * split proportionally instead of landing in one contiguous block.
 */
export function splitMailList(recipientIds: string[], variants: ExperimentVariant[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(variants.map((v) => [v.id, [] as string[]]));
  if (variants.length === 0) return out;
  const GRAN = 1000;
  const assigned = new Array(variants.length).fill(0);
  const cycle: string[] = [];
  for (let j = 0; j < GRAN; j++) {
    // pick the variant furthest behind its target share
    let best = 0, bestGap = -Infinity;
    for (let k = 0; k < variants.length; k++) {
      const target = variants[k].weight * (j + 1);
      const gap = target - assigned[k];
      if (gap > bestGap + 1e-12) { bestGap = gap; best = k; }
    }
    assigned[best] += 1;
    cycle.push(variants[best].id);
  }
  const ordered = [...recipientIds].sort();
  ordered.forEach((id, i) => {
    out[cycle[i % cycle.length]].push(id);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Force-QA evaluation helper (cookie preview)
// ---------------------------------------------------------------------------

export function evaluateForceQa(cookieValue: string | null, exp: Experiment): ExperimentVariant | null {
  if (!cookieValue) return null;
  return exp.variants.find((v) => v.id === cookieValue) ?? null;
}

export type { ExperimentVariant };
