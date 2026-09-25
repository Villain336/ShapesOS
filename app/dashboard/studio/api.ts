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
  canvaDesignId: string | null;
  canvaExportId: string | null;
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

/** Poll the Canva PDF export until it succeeds/fails. Returns the creative. */
export async function pollPdfExport(
  creativeId: string,
  opts?: { intervalMs?: number; maxAttempts?: number; onTick?: (n: number) => void },
): Promise<Creative> {
  const intervalMs = opts?.intervalMs ?? 2000;
  const maxAttempts = opts?.maxAttempts ?? 45;
  for (let n = 0; n < maxAttempts; n++) {
    opts?.onTick?.(n);
    const r = await api<{ status: string; creative: Creative | null }>(
      `/api/studio/creatives/canva/export-pdf?creativeId=${encodeURIComponent(creativeId)}`,
    );
    if (r.status === "success" && r.creative) return r.creative;
    if (r.status === "failed") throw new Error("The Canva export failed — check the design and try again.");
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error("The Canva export is taking longer than expected — try Validate/refresh in a moment.");
}

export function hashShort(hash: string | null): string {
  return hash ? `${hash.slice(0, 10)}…` : "—";
}
