// Marketr — Legal/Compliance slice 5: Digital-properties module (Hullcheck synergy).
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 ("Hullcheck synergy" paragraph).
// Hullcheck's "don't get sued" engine — legal, compliance, and security
// scanning for apps and websites — becomes the DIGITAL side of the Legal
// surface. The physical/regulatory side is slices 1–4 (obligation map,
// deadlines, document vault, change radar).
//
// Critical context: Hullcheck is a SPEC, not an implementation — there is no
// scan engine to wire to. So "integrate, don't reimplement" means: implement
// Hullcheck's layer taxonomy and result model INSIDE Legal, structured so the
// future engine plugs in. v1 = digital-property registry + findings model +
// self-assessment checklist, with a DigitalScan ingestion shape ready for the
// real scanner. NO scanner is built in this slice.
//
// Hard guardrails (never bend):
// 1. Information, NEVER legal advice — LEGAL_DISCLAIMER ships on every
//    output (page, API response). Findings are informational; items that
//    need a professional carry confirmWithProfessional.
// 2. Never invent scan results — v1 findings come from the tenant's own
//    self-assessment or manual import. The UI must label the assessment
//    source. No fake "scanned" claims: source "hullcheck_engine" is REJECTED
//    until the real engine is connected (see importDigitalScan).
// 3. Insurance invariant: "Licensed partner — they hold the licenses, we
//    provide the software." No binding path.

import { LegalError } from "./types";

/**
 * Hullcheck's eight layers (SPEC.md §2, SPEC-V2.md), narrowed to the six
 * that form the legal/compliance/security surface this module covers:
 * detect, fix, prove, harden, document, comply. Operate (monitoring/CI
 * wiring) and Certify (human-verified badge) are future layers — they
 * arrive with the engine and the audit flow, not in v1.
 */
export type HullcheckLayer =
  | "detect"
  | "fix"
  | "prove"
  | "harden"
  | "document"
  | "comply";

export const HULLCHECK_LAYERS: {
  value: HullcheckLayer;
  label: string;
  /** Plain-English coverage line shown in the UI. */
  whatItCovers: string;
}[] = [
  {
    value: "detect",
    label: "Detect",
    whatItCovers:
      "Find the problems — exposed secrets, open databases, unprotected pages, known-vulnerable components.",
  },
  {
    value: "fix",
    label: "Fix",
    whatItCovers:
      "A written, tracked path to close each issue — who owns it, by when. Detection without fixing is theater.",
  },
  {
    value: "prove",
    label: "Prove",
    whatItCovers:
      "Tests that confirm the site still behaves correctly after each change.",
  },
  {
    value: "harden",
    label: "Harden",
    whatItCovers:
      "The edge cases attackers probe — server-side checks, rate limits, error handling, login sessions.",
  },
  {
    value: "document",
    label: "Document",
    whatItCovers:
      "Written runbooks and docs so the site does not depend on one person's memory.",
  },
  {
    value: "comply",
    label: "Comply",
    whatItCovers:
      "The paperwork and consent flows the lawsuits target — privacy policy, terms, consent, accessibility, data rights.",
  },
];

export function isValidHullcheckLayer(value: unknown): value is HullcheckLayer {
  return (
    typeof value === "string" &&
    (HULLCHECK_LAYERS.map((l) => l.value) as string[]).includes(value)
  );
}

export type DigitalPropertyKind = "website" | "app";

export const DIGITAL_PROPERTY_KINDS: { value: DigitalPropertyKind; label: string }[] = [
  { value: "website", label: "Website" },
  { value: "app", label: "App" },
];

export function isValidDigitalPropertyKind(
  value: unknown,
): value is DigitalPropertyKind {
  return value === "website" || value === "app";
}

export type DigitalFindingSeverity = "critical" | "high" | "medium" | "low";

export const DIGITAL_FINDING_SEVERITIES: {
  value: DigitalFindingSeverity;
  label: string;
}[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function isValidFindingSeverity(
  value: unknown,
): value is DigitalFindingSeverity {
  return (
    typeof value === "string" &&
    (DIGITAL_FINDING_SEVERITIES.map((s) => s.value) as string[]).includes(value)
  );
}

/** One step below — used when the tenant answers "not sure". */
export function lowerSeverity(
  severity: DigitalFindingSeverity,
): DigitalFindingSeverity {
  const order: DigitalFindingSeverity[] = ["critical", "high", "medium", "low"];
  const idx = order.indexOf(severity);
  return order[Math.min(idx + 1, order.length - 1)];
}

export type DigitalFindingStatus = "open" | "fixed" | "dismissed";

export const DIGITAL_FINDING_STATUSES: {
  value: DigitalFindingStatus;
  label: string;
}[] = [
  { value: "open", label: "Open" },
  { value: "fixed", label: "Fixed" },
  { value: "dismissed", label: "Dismissed" },
];

export function isValidFindingStatus(
  value: unknown,
): value is DigitalFindingStatus {
  return value === "open" || value === "fixed" || value === "dismissed";
}

/**
 * Allowed status transitions. Reopening (fixed/dismissed → open) is allowed
 * because a "fixed" gap can regress; only closed states can move.
 */
const FINDING_STATUS_TRANSITIONS: Record<DigitalFindingStatus, DigitalFindingStatus[]> = {
  open: ["open", "fixed", "dismissed"],
  fixed: ["fixed", "open"],
  dismissed: ["dismissed", "open"],
};

export function isValidFindingStatusTransition(
  from: DigitalFindingStatus,
  to: DigitalFindingStatus,
): boolean {
  return FINDING_STATUS_TRANSITIONS[from].includes(to);
}

export type DigitalFindingSource =
  | "self_assessment"
  | "manual_import"
  | "hullcheck_engine";

export const DIGITAL_FINDING_SOURCES: {
  value: DigitalFindingSource;
  /** Label shown in the UI — the source must always be visible (guardrail 2). */
  label: string;
  hint: string;
}[] = [
  {
    value: "self_assessment",
    label: "Self-assessment",
    hint: "From your own answers — not an automated scan.",
  },
  {
    value: "manual_import",
    label: "Added manually",
    hint: "Entered by hand — e.g. from a report you read elsewhere.",
  },
  {
    value: "hullcheck_engine",
    label: "Hullcheck scan",
    hint: "From the automated Hullcheck scan engine.",
  },
];

export function isValidFindingSource(
  value: unknown,
): value is DigitalFindingSource {
  return (
    typeof value === "string" &&
    (DIGITAL_FINDING_SOURCES.map((s) => s.value) as string[]).includes(value)
  );
}

export function findingSourceLabel(source: DigitalFindingSource): string {
  return DIGITAL_FINDING_SOURCES.find((s) => s.value === source)!.label;
}

// ------------------------------------------------------------------
// Self-assessment checklist (the v1 "scanner": the tenant's own answers).
// ------------------------------------------------------------------

export type SelfAssessmentAnswer = "yes" | "no" | "unsure";

export const SELF_ASSESSMENT_ANSWERS: {
  value: SelfAssessmentAnswer;
  label: string;
}[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unsure", label: "Not sure" },
];

export function isValidSelfAssessmentAnswer(
  value: unknown,
): value is SelfAssessmentAnswer {
  return value === "yes" || value === "no" || value === "unsure";
}

export interface SelfAssessmentItem {
  /** Stable key; doubles as DigitalFinding.itemKey for dedupe. */
  key: string;
  layer: HullcheckLayer;
  /** Which property kinds this question applies to. */
  kinds: DigitalPropertyKind[];
  /** The plain-English yes/no question the tenant answers. */
  question: string;
  /** Finding generated when the answer reveals a gap ("no"). */
  gapTitle: string;
  /** "What this means for your business" (Hullcheck SPEC §3) — plain English. */
  gapSummary: string;
  gapSeverity: DigitalFindingSeverity;
  /** Optional link into slice 1's obligation templates (validated by key). */
  obligationKey: string | null;
  /** True when the tenant should have an attorney confirm the fix. */
  confirmWithProfessional: boolean;
}

/**
 * The v1 checklist, seeded from Hullcheck's layer taxonomy. "No" means the
 * gap exists; "Not sure" means it is flagged at one severity lower so the
 * tenant can check with their developer. "Yes" means no finding.
 */
export const SELF_ASSESSMENT_CHECKLIST: SelfAssessmentItem[] = [
  // ---- detect ----
  {
    key: "secrets-in-bundle",
    layer: "detect",
    kinds: ["website", "app"],
    question:
      "Are API keys, passwords, and other secrets kept out of the code that runs in a visitor's browser?",
    gapTitle: "Secret keys may be exposed in your site's code",
    gapSummary:
      "If an API key or database password ships in your website's public code, anyone can copy it and use it as you. This is how customer data gets stolen and surprise cloud bills appear.",
    gapSeverity: "high",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "rls-misconfigured",
    layer: "detect",
    kinds: ["app"],
    question:
      "If your app stores data in a hosted database, is it locked so each user can only see their own records?",
    gapTitle: "Database may be readable by anyone",
    gapSummary:
      "Vibe-coded apps routinely ship with databases the whole internet can read — names, emails, orders. Attackers and plaintiff firms scan for exactly this.",
    gapSeverity: "critical",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "unauth-endpoint",
    layer: "detect",
    kinds: ["website", "app"],
    question:
      "Are pages and APIs that show private or account data protected by a login?",
    gapTitle: "Private pages or data may be reachable without logging in",
    gapSummary:
      "Unprotected endpoints are one of the first things attackers probe. Exposed customer data is lawsuit fuel.",
    gapSeverity: "high",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "vulnerable-deps",
    layer: "detect",
    kinds: ["website", "app"],
    question:
      "Do you install security updates for the plugins, packages, or templates your site is built with?",
    gapTitle: "Outdated components may carry known security flaws",
    gapSummary:
      "Known flaws in old packages are public knowledge — attackers run automated probes for them.",
    gapSeverity: "medium",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "debug-in-prod",
    layer: "detect",
    kinds: ["website", "app"],
    question: "Is debug or test mode turned off on your live site?",
    gapTitle: "Debug mode may be on in production",
    gapSummary:
      "Debug pages leak stack traces, file paths, and sometimes credentials — a map of your app handed to an attacker.",
    gapSeverity: "medium",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  // ---- fix ----
  {
    key: "fix-process",
    layer: "fix",
    kinds: ["website", "app"],
    question:
      "When a security or legal issue is found, is there a written plan for who fixes it and by when?",
    gapTitle: "No tracked process for fixing security or legal issues",
    gapSummary:
      "Finding problems is the cheap part — Hullcheck's whole thesis is that fixing is the moat. Without an owner and a deadline, issues rot until a plaintiff firm finds them first.",
    gapSeverity: "medium",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  // ---- prove ----
  {
    key: "tests-present",
    layer: "prove",
    kinds: ["app"],
    question:
      "Do you have automated tests that check your app still works correctly after each change?",
    gapTitle: "No automated tests guarding the app's behavior",
    gapSummary:
      "Without tests, every update risks silently breaking payments, logins, or data handling — the kind of break that loses customers before you notice.",
    gapSeverity: "medium",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  // ---- harden ----
  {
    key: "server-side-validation",
    layer: "harden",
    kinds: ["app"],
    question:
      "Is important input (forms, prices, permissions) checked on the server — not just in the browser?",
    gapTitle: "Validation may rely on the browser alone",
    gapSummary:
      "Browser checks fall to a single crafted request. The server must re-check everything that matters: prices, roles, and who can touch whose data.",
    gapSeverity: "high",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "rate-limiting",
    layer: "harden",
    kinds: ["website", "app"],
    question:
      "Does your site slow down or block someone hammering a login form or contact form?",
    gapTitle: "No rate limiting on forms or logins",
    gapSummary:
      "Without throttling, login pages get brute-forced and forms get spammed at machine speed.",
    gapSeverity: "medium",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  {
    key: "error-handling",
    layer: "harden",
    kinds: ["website", "app"],
    question:
      "Does your site show a friendly error page instead of a technical crash dump?",
    gapTitle: "Crashes may expose technical details",
    gapSummary:
      "Raw error pages leak internals to attackers, and visitors read a crash as 'this business is broken.'",
    gapSeverity: "low",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  // ---- document ----
  {
    key: "runbook",
    layer: "document",
    kinds: ["website", "app"],
    question:
      "Is there a written runbook — how the site is hosted, deployed, and recovered if it goes down?",
    gapTitle: "No written runbook for the property",
    gapSummary:
      "If the person who built it is unreachable, nobody can fix or recover the site. Write it down while it is fresh.",
    gapSeverity: "low",
    obligationKey: null,
    confirmWithProfessional: false,
  },
  // ---- comply ----
  {
    key: "privacy-policy-missing",
    layer: "comply",
    kinds: ["website", "app"],
    question:
      "Do you publish a privacy policy that matches what your site actually collects?",
    gapTitle: "No privacy policy (or one that does not match reality)",
    gapSummary:
      "Regulators and plaintiff attorneys check this first. A policy that does not match your actual data flows is not protection — it is evidence.",
    gapSeverity: "high",
    obligationKey: "saas-terms-and-privacy",
    confirmWithProfessional: true,
  },
  {
    key: "terms-missing",
    layer: "comply",
    kinds: ["website", "app"],
    question: "Do you publish terms of service for your site or app?",
    gapTitle: "No published terms of service",
    gapSummary:
      "Without terms, every dispute — refunds, chargebacks, misuse — gets fought on the customer's home turf instead of yours.",
    gapSeverity: "medium",
    obligationKey: "saas-terms-and-privacy",
    confirmWithProfessional: true,
  },
  {
    key: "cookie-consent-missing",
    layer: "comply",
    kinds: ["website"],
    question:
      "If your site uses tracking or analytics cookies, do visitors get a real choice before they are set?",
    gapTitle: "No cookie consent for tracking",
    gapSummary:
      "Setting trackers before consent is exactly the pattern privacy regulators fine for.",
    gapSeverity: "medium",
    obligationKey: "data-privacy-review",
    confirmWithProfessional: true,
  },
  {
    key: "accessibility-gaps",
    layer: "comply",
    kinds: ["website", "app"],
    question:
      "Can a visitor using only a keyboard, or a screen reader, complete your site's key flows?",
    gapTitle: "Accessibility gaps (lawsuit risk)",
    gapSummary:
      "ADA website lawsuits keep hitting records, and 96% of errors come from six auto-detectable failures — missing alt text, unlabeled fields, low contrast, empty links and buttons, missing page language. Courts reject overlay widgets as a defense; only fixing the code counts.",
    gapSeverity: "high",
    obligationKey: null,
    confirmWithProfessional: true,
  },
  {
    key: "data-export-deletion-missing",
    layer: "comply",
    kinds: ["app"],
    question: "Can a customer download their data, or ask you to delete it?",
    gapTitle: "No data export or deletion flow",
    gapSummary:
      "State privacy laws give users deletion rights. 'Email us and hope' does not survive a complaint.",
    gapSeverity: "medium",
    obligationKey: "data-privacy-review",
    confirmWithProfessional: true,
  },
];

/** Checklist applicable to one property kind (app-only items drop for websites). */
export function assessmentChecklistForKind(
  kind: DigitalPropertyKind,
): SelfAssessmentItem[] {
  return SELF_ASSESSMENT_CHECKLIST.filter((item) => item.kinds.includes(kind));
}

export interface DigitalFindingInput {
  itemKey: string | null;
  hullcheckLayer: HullcheckLayer;
  title: string;
  plainEnglishSummary: string;
  severity: DigitalFindingSeverity;
  obligationKey: string | null;
  source: DigitalFindingSource;
}

/**
 * Turn the tenant's answers into finding inputs. "yes" = no finding.
 * "no" = the gap exists at full severity. "not sure" = flagged one notch
 * lower so it can be checked with a developer — never silently dropped.
 * Unknown item keys are rejected: the checklist is the contract.
 */
export function answersToFindings(
  kind: DigitalPropertyKind,
  answers: Record<string, SelfAssessmentAnswer>,
): DigitalFindingInput[] {
  const checklist = assessmentChecklistForKind(kind);
  const byKey = new Map(checklist.map((item) => [item.key, item]));
  const known = new Set(byKey.keys());

  for (const key of Object.keys(answers)) {
    if (!known.has(key)) {
      throw new LegalError(
        "UNKNOWN_CHECKLIST_ITEM",
        `No self-assessment item: ${key}. Answer only the items in this checklist.`,
      );
    }
    if (!isValidSelfAssessmentAnswer(answers[key])) {
      throw new LegalError(
        "INVALID_ANSWER",
        `Answer for ${key} must be yes, no, or unsure.`,
      );
    }
  }

  const findings: DigitalFindingInput[] = [];
  for (const item of checklist) {
    const answer = answers[item.key];
    // Unanswered = not yet walked; the tenant can come back to it.
    if (answer === undefined || answer === "yes") continue;
    if (answer === "no") {
      findings.push({
        itemKey: item.key,
        hullcheckLayer: item.layer,
        title: item.gapTitle,
        plainEnglishSummary: item.gapSummary,
        severity: item.gapSeverity,
        obligationKey: item.obligationKey,
        source: "self_assessment",
      });
    } else {
      // "unsure": flagged at a lower severity with an explicit unverified
      // marker — never presented as a confirmed gap.
      findings.push({
        itemKey: item.key,
        hullcheckLayer: item.layer,
        title: `Unverified: ${item.gapTitle.charAt(0).toLowerCase()}${item.gapTitle.slice(1)}`,
        plainEnglishSummary:
          `You answered "not sure" to: "${item.question}" Check this with your developer — ` +
          item.gapSummary,
        severity: lowerSeverity(item.gapSeverity),
        obligationKey: item.obligationKey,
        source: "self_assessment",
      });
    }
  }
  return findings;
}

// ------------------------------------------------------------------
// DigitalScan: the ingestion shape the future Hullcheck engine plugs into.
// ------------------------------------------------------------------

/**
 * A scan result ready for import. source "hullcheck_engine" is reserved for
 * the real engine (requires engineVersion); until it exists, import rejects
 * it — v1 scans only ever come from self_assessment or manual_import.
 */
export interface DigitalScan {
  source: DigitalFindingSource;
  scannedAt: string;
  propertyId: string;
  /** Required when source is hullcheck_engine (provenance for the future). */
  engineVersion?: string | null;
  findings: DigitalFindingInput[];
}

export function validateDigitalScan(scan: unknown): asserts scan is DigitalScan {
  if (typeof scan !== "object" || scan === null) {
    throw new LegalError("INVALID_SCAN", "A scan must be an object.");
  }
  const s = scan as Record<string, unknown>;
  if (!isValidFindingSource(s.source)) {
    throw new LegalError(
      "INVALID_SCAN_SOURCE",
      "Scan source must be self_assessment, manual_import, or hullcheck_engine.",
    );
  }
  if (typeof s.propertyId !== "string" || s.propertyId.trim() === "") {
    throw new LegalError("INVALID_SCAN", "Scan propertyId is required.");
  }
  if (typeof s.scannedAt !== "string" || Number.isNaN(new Date(s.scannedAt).getTime())) {
    throw new LegalError("INVALID_SCAN", "Scan scannedAt must be a valid date.");
  }
  if (s.source === "hullcheck_engine" && !s.engineVersion) {
    throw new LegalError(
      "INVALID_SCAN",
      "A hullcheck_engine scan must carry engineVersion.",
    );
  }
  if (!Array.isArray(s.findings)) {
    throw new LegalError("INVALID_SCAN", "Scan findings must be an array.");
  }
  s.findings.forEach((f, i) => {
    if (typeof f !== "object" || f === null) {
      throw new LegalError("INVALID_SCAN", `Finding ${i} must be an object.`);
    }
    const finding = f as Record<string, unknown>;
    if (!isValidHullcheckLayer(finding.hullcheckLayer)) {
      throw new LegalError(
        "INVALID_SCAN",
        `Finding ${i}: hullcheckLayer must be one of detect, fix, prove, harden, document, comply.`,
      );
    }
    if (!isValidFindingSeverity(finding.severity)) {
      throw new LegalError(
        "INVALID_SCAN",
        `Finding ${i}: severity must be one of critical, high, medium, low.`,
      );
    }
    if (typeof finding.title !== "string" || finding.title.trim() === "") {
      throw new LegalError("INVALID_SCAN", `Finding ${i}: title is required.`);
    }
    if (
      typeof finding.plainEnglishSummary !== "string" ||
      finding.plainEnglishSummary.trim() === ""
    ) {
      throw new LegalError(
        "INVALID_SCAN",
        `Finding ${i}: plainEnglishSummary is required.`,
      );
    }
    if (
      finding.itemKey !== undefined &&
      finding.itemKey !== null &&
      typeof finding.itemKey !== "string"
    ) {
      throw new LegalError("INVALID_SCAN", `Finding ${i}: itemKey must be a string.`);
    }
    if (
      finding.obligationKey !== undefined &&
      finding.obligationKey !== null &&
      typeof finding.obligationKey !== "string"
    ) {
      throw new LegalError(
        "INVALID_SCAN",
        `Finding ${i}: obligationKey must be a string.`,
      );
    }
  });
}

/** Validate the checklist seed itself (duplicate keys, unknown layers). */
export function validateChecklistSeed(): void {
  const keys = SELF_ASSESSMENT_CHECKLIST.map((i) => i.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) {
    throw new LegalError(
      "DUPLICATE_CHECKLIST_ITEM",
      `Duplicate checklist keys: ${[...new Set(dupes)].join(", ")}`,
    );
  }
  for (const item of SELF_ASSESSMENT_CHECKLIST) {
    if (!isValidHullcheckLayer(item.layer)) {
      throw new LegalError("INVALID_LAYER", `Checklist item ${item.key}: unknown layer.`);
    }
    for (const kind of item.kinds) {
      if (!isValidDigitalPropertyKind(kind)) {
        throw new LegalError("INVALID_KIND", `Checklist item ${item.key}: unknown kind.`);
      }
    }
    if (!isValidFindingSeverity(item.gapSeverity)) {
      throw new LegalError(
        "INVALID_SEVERITY",
        `Checklist item ${item.key}: unknown severity.`,
      );
    }
    if (!item.question.trim() || !item.gapTitle.trim() || !item.gapSummary.trim()) {
      throw new LegalError(
        "INVALID_CHECKLIST_ITEM",
        `Checklist item ${item.key}: question, title, and summary are required.`,
      );
    }
  }
}

/** Validate a tenant-supplied property URL (optional field). */
export function validatePropertyUrl(url: unknown): string | null {
  if (url === undefined || url === null || url === "") return null;
  if (typeof url !== "string") {
    throw new LegalError("INVALID_URL", "URL must be a string.");
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new LegalError("INVALID_URL", "URL must start with http:// or https://.");
    }
    return parsed.toString();
  } catch (e) {
    if (e instanceof LegalError) throw e;
    throw new LegalError("INVALID_URL", "URL is not a valid web address.");
  }
}
