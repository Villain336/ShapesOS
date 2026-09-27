// Marketr — Creative Studio client API helpers (Phase 4, T2).
"use client";

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  channelTemplate: string;
  formatTrack: string;
  size: string;
  widthIn: number | null;
  heightIn: number | null;
  pages: number | null;
  issues: ValidationIssue[];
  printNotes: string[];
  attestation: { noGovernmentImpersonation: boolean; attestedBy: string | null; attestedAt: string } | null;
  fileId: string | null;
  validatedAt: string;
}

export interface Creative {
  id: string;
  workspaceId: string;
  name: string;
  channelTemplate: string;
  formatTrack: string;
  size: string;
  source: string;
  pdfUrl: string | null;
  creativeHash: string | null;
  version: number;
  status: "draft" | "ready" | "archived";
  validation: ValidationReport | null;
  createdAt: string;
  updatedAt: string;
}

export interface SizeSpec {
  id: string;
  label: string;
  notes?: string;
}

export interface FormatTrack {
  id: string;
  label: string;
  description: string;
  sizes: SizeSpec[];
  notes?: string;
}

export interface ChannelTemplate {
  id: string;
  label: string;
  status: "live" | "coming_soon";
  tracks: FormatTrack[];
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function hashShort(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…` : "—";
}
