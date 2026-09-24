// Marketr — nurture UI shared types.
"use client";

export interface NurtureStep {
  channel: "sms" | "email" | "voice";
  delayMinutes: number;
  template: string;
  subject?: string;
}

export interface SequenceStats {
  enrolledActive: number;
  sent: number;
  suppressed: number;
}

export interface NurtureSequence {
  id: string;
  name: string;
  description: string | null;
  steps: NurtureStep[];
  status: "draft" | "active" | "paused" | "archived";
  approvalPolicy: string;
  dailyCap: number | null;
  createdAt: string;
  updatedAt: string;
  stats?: SequenceStats;
}

export interface Enrollment {
  id: string;
  status: "active" | "paused" | "completed" | "unenrolled" | "bounced";
  currentStep: number;
  nextRunAt: string | null;
  completedAt: string | null;
  createdAt: string;
  sequence: { id: string; name: string; status: string };
  lead: { id: string; name: string; email: string | null; phone: string | null; company: string | null };
}

export interface OutboundMessageRow {
  id: string;
  channel: string;
  kind: string;
  subject: string | null;
  body: string;
  status: "queued" | "sent" | "delivered" | "failed" | "suppressed";
  suppressionReason: string | null;
  provider: string;
  scheduledFor: string | null;
  sentAt: string | null;
  error: string | null;
  costCents: number;
  createdAt: string;
  lead: { id: string; name: string; email: string | null; phone: string | null; company: string | null } | null;
}

export interface ApprovalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy: string | null;
  note: string | null;
  createdAt: string;
  lead: { id: string; name: string; company: string | null } | null;
}

export interface ConsentRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  consent: Record<"sms" | "email" | "voice", string>;
}

export interface LeadOption {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
}
