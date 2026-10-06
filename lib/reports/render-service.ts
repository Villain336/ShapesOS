// Marketr — Phase 16 slice 9: branded report engine — WeasyPrint render service.
//
// Server-side HTML+CSS → PDF via WeasyPrint (Python). Proven 2026-09-29 on
// this CPU box: ~2s A4 render, zero new infra (proof:
// ~/workspace/biz-os/report-engine-proof, WeasyPrint 70.0 in its venv).
//
// Hard gates, in order:
//   1. Template CSS lint (double-position color stops fail the template).
//   2. Figure grounding (Tico's iron guardrail: a figure with no source
//      pointer flags the report for review and NEVER renders —
//      UngroundedFiguresError, no PDF, no WeasyPrint process).
//
// Sandboxing: the Python driver pins base_url to the template directory and
// installs a url_fetcher that allows ONLY file:// URLs inside the template
// dir (plus data: URIs) — no network, no filesystem escape.
//
// Storage (deploy PR): WeasyPrint writes into a per-render scratch directory
// under os.tmpdir() (class b, removed in `finally`); the PDF is then stored in
// the shared blob store (namespace "report-engine", <workspaceId>/report-<stamp>.pdf)
// and `pdfPath` is that blob ref, readable from every replica.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { blobPut, workspaceBlobPath } from "@/lib/filesystem/storage";
import { assertFiguresGrounded, type ReportFigure } from "./figures";
import { buildBrandOverrideCss, type ReportBrandKitInput } from "./brand-css";
import { resolveTemplate } from "./templates/registry";

const execFileAsync = promisify(execFile);

/** Override with env when the venv moves. */
const WEASYPRINT_PYTHON =
  process.env.MARKETR_WEASYPRINT_PYTHON ??
  path.join(os.homedir(), "workspace", "biz-os", "report-engine-proof", ".venv", "bin", "python");

/**
 * True when the WeasyPrint interpreter is present and executable. Lets tests
 * (and health checks) skip real PDF rendering on hosts without the venv
 * instead of failing with ENOENT.
 */
export function weasyprintAvailable(): boolean {
  try {
    accessSync(WEASYPRINT_PYTHON, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface RenderReportInput {
  templateName: string;
  /** Exact pinned semver — reports always pin; "latest" is for previews only. */
  templateVersion: string;
  /** Tenant brand kit override (null = default violet). */
  brandKit: ReportBrandKitInput | null;
  /** Plain-text meta fields for {{tokens}} in the template. */
  meta: Record<string, string>;
  /** KPI figures — every one must carry a source pointer. */
  figures: ReportFigure[];
  /** Render a DRAFT badge (pre-approval previews). Final reports omit it. */
  draft?: boolean;
  /** Owning workspace (blob key prefix); previews without one go under "previews". */
  workspaceId?: string;
}

export interface RenderReportResult {
  /** Absolute path of the rendered PDF. */
  pdfPath: string;
  templateName: string;
  templateVersion: string;
  pageCount: number;
  /** Bytes of the PDF file. */
  sizeBytes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function figureBlockHtml(fig: ReportFigure): string {
  const value = typeof fig.value === "string" ? fig.value : String(fig.value);
  const src = fig.source!;
  const captured = src.capturedAt ? ` · measured ${escapeHtml(src.capturedAt)}` : "";
  return [
    `<div class="kpi">`,
    `  <div class="kpi-label">${escapeHtml(fig.label)}</div>`,
    `  <div class="kpi-value">${escapeHtml(value)}</div>`,
    fig.delta ? `  <div class="kpi-delta">${escapeHtml(fig.delta)}</div>` : "",
    `  <div class="kpi-source"><strong>Source:</strong> ${escapeHtml(src.provider)} · ${escapeHtml(src.ref)}${captured}</div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Python driver: sandboxed WeasyPrint render, prints page count on stdout.
 *  Reads the job JSON from argv[1] (a temp file — the sandbox's execFile
 *  hangs when piping large stdin, so the job travels by file, not pipe). */
const DRIVER = `
import sys, json
from weasyprint import HTML

with open(sys.argv[1], encoding="utf-8") as f:
    job = json.load(f)

def safe_fetcher(url):
    # Allow only file:// inside the template dir, plus data: URIs.
    from urllib.request import url2pathname
    from urllib.parse import urlparse, unquote
    import os
    if url.startswith('data:'):
        from weasyprint import default_url_fetcher
        return default_url_fetcher(url)
    parts = urlparse(url)
    if parts.scheme not in ('', 'file'):
        raise ValueError(f"blocked url scheme: {parts.scheme}")
    p = url2pathname(unquote(parts.path))
    if not os.path.isabs(p):
        p = os.path.join(job["base_dir"], p)
    p = os.path.realpath(p)
    base = os.path.realpath(job["base_dir"])
    if os.path.commonpath([p, base]) != base:
        raise ValueError("blocked path outside template dir")
    from weasyprint import default_url_fetcher
    return default_url_fetcher("file://" + p)

doc = HTML(string=job["html"], base_url=job["base_dir"], url_fetcher=safe_fetcher).render()
doc.write_pdf(job["out_path"])
print(len(doc.pages))
`;

/**
 * Render a branded report to PDF. Throws on unlinted templates or ungrounded
 * figures — the guardrails run BEFORE any PDF bytes are produced.
 */
export async function renderReportPdf(input: RenderReportInput): Promise<RenderReportResult> {
  // Gate 1 + 2: figure grounding first (never render invented numbers),
  // then template resolution (which lints the CSS).
  assertFiguresGrounded(input.figures);
  const template = await resolveTemplate(input.templateName, input.templateVersion);

  const figureBlock = input.figures.map(figureBlockHtml).join("\n");
  const draftBadge = input.draft
    ? `<div class="draft-badge">DRAFT — PENDING APPROVAL</div>`
    : "";

  let html = template.html;
  for (const [key, raw] of Object.entries(input.meta ?? {})) {
    html = html.split(`{{${key}}}`).join(escapeHtml(String(raw)));
  }
  html = html.split("<!--FIGURE_BLOCK-->").join(figureBlock);
  html = html.split("<!--DRAFT_BADGE-->").join(draftBadge);
  // Brand override AFTER the template stylesheet so the kit wins every token.
  html = html.replace(
    "</head>",
    `<style>\n${template.css}\n${buildBrandOverrideCss(input.brandKit)}\n</style>\n</head>`,
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marketr-report-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(dir, `report-${stamp}.pdf`);
  const jobPath = path.join(dir, `job-${stamp}.json`);

  const job = JSON.stringify({
    html,
    out_path: outPath,
    base_dir: path.join(__dirname, "templates", input.templateName, input.templateVersion),
  });
  await fs.writeFile(jobPath, job, "utf8");

  let stdout: string;
  let bytes: Buffer;
  try {
    try {
      ({ stdout } = await execFileAsync(WEASYPRINT_PYTHON, ["-c", DRIVER, jobPath], {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      }));
    } catch (err) {
      throw new Error(
        `WeasyPrint render failed (python: ${WEASYPRINT_PYTHON}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    bytes = await fs.readFile(outPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  const pageCount = Number.parseInt(stdout.trim(), 10);
  const pdfPath = await blobPut(
    "report-engine",
    workspaceBlobPath(input.workspaceId ?? "previews", `report-${stamp}.pdf`),
    bytes,
    "application/pdf",
  );
  return {
    pdfPath,
    templateName: template.name,
    templateVersion: template.version,
    pageCount: Number.isFinite(pageCount) ? pageCount : 0,
    sizeBytes: bytes.length,
  };
}
