// Marketr — Legal/Compliance slice 3: document expiry sweep.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 (document vault).
//
// The sweep computes the escalation tier for the CURRENT version of every
// document in a workspace and emits through the alert hub
// (lib/alerts/evaluate.ts) when a version enters a NEW tier — the same
// 90 → 30 → 7 → overdue ladder semantics as the slice-2 deadline sweep,
// under its own trigger ("legal_document_expiry"), so each tier fires at
// most once per version (recorded on lastAlertedTier).
//
// This module takes its store and emitter as arguments: the cron route wires
// PrismaLegalStore + emitAlert, tests inject fakes. Nothing here invents
// dates — every emitted alert is grounded in a tenant-set or tenant-read
// expiry date, or the explicit "no recorded expiry" state.

import type { TriggerInput } from "@/lib/alerts/evaluate";
import { LEGAL_DISCLAIMER } from "./types";
import {
  TIER_META,
  daysUntilDue,
  tierForDeadline,
  type EscalationTier,
} from "./deadlines";
import {
  documentAlertBody,
  documentAlertTitle,
  type LegalDocumentType,
} from "./documents";

export interface SweepDocumentVersion {
  id: string;
  documentId: string;
  title: string;
  docType: LegalDocumentType;
  versionNumber: number;
  expiryDate: Date | null;
  /** Tier already alerted for, if any — the sweep only fires on change. */
  lastAlertedTier: EscalationTier | null;
}

/** Minimal store surface the sweep needs (PrismaLegalStore implements it). */
export interface DocumentSweepStore {
  listCurrentVersions(workspaceId: string): Promise<SweepDocumentVersion[]>;
  recordDocumentAlertedTier(
    workspaceId: string,
    versionId: string,
    tier: EscalationTier,
    now: Date,
  ): Promise<void>;
}

export type DocumentEmitter = (input: TriggerInput) => Promise<unknown>;

export interface DocumentSweepOptions {
  now?: Date;
  /** Dashboard-relative deep link for the alert. */
  link?: string;
}

export interface DocumentSweepResult {
  workspaceId: string;
  checked: number;
  emitted: number;
  skipped: number;
  /** versionId → tier that was emitted. */
  fired: { versionId: string; documentId: string; title: string; tier: EscalationTier }[];
}

function formatDateUtc(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Run one workspace's document-expiry sweep. Emits at most one alert per
 * current version per tier transition; never emits for a tier already
 * recorded. Only the current version of each document participates — older
 * versions are history and never alert.
 */
export async function sweepLegalDocumentAlerts(
  store: DocumentSweepStore,
  emit: DocumentEmitter,
  workspaceId: string,
  opts: DocumentSweepOptions = {},
): Promise<DocumentSweepResult> {
  const now = opts.now ?? new Date();
  const versions = await store.listCurrentVersions(workspaceId);

  let emitted = 0;
  let skipped = 0;
  const fired: DocumentSweepResult["fired"] = [];

  for (const v of versions) {
    const tier = tierForDeadline(v.expiryDate, now);
    if (tier === null) {
      skipped += 1;
      continue;
    }
    // Same tier already alerted — only fire on escalation (tier change).
    if (v.lastAlertedTier === tier) {
      skipped += 1;
      continue;
    }

    const days = v.expiryDate ? daysUntilDue(v.expiryDate, now) : null;
    const body =
      documentAlertBody({
        title: v.title,
        tier,
        expiryDateText: v.expiryDate ? formatDateUtc(v.expiryDate) : null,
        daysUntil: days,
      }) + `\n\n${LEGAL_DISCLAIMER}`;

    await emit({
      workspaceId,
      trigger: "legal_document_expiry",
      severity: TIER_META[tier].severity,
      title: documentAlertTitle(v.title, tier),
      body,
      link: opts.link ?? "/dashboard/legal",
      dedupKey: `legal_document_expiry:${v.id}:${tier}`,
      scopeKeywordIds: [],
    });
    await store.recordDocumentAlertedTier(workspaceId, v.id, tier, now);
    emitted += 1;
    fired.push({ versionId: v.id, documentId: v.documentId, title: v.title, tier });
  }

  return {
    workspaceId,
    checked: versions.length,
    emitted,
    skipped,
    fired,
  };
}
