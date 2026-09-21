// Marketr — report generation orchestration (milestone 12).
//
// generateReport(): template Tiptap JSON + brand kit + project data
//   → placeholder context → pdfcn React tree → Takumi PDF buffer
//   → .data/reports/<id>.pdf → Report row + audit log.
//
// Storage: REPORT_STORAGE_DIR env, default <repo>/.data/reports
// (durable volume in production — see DEPLOY.md §1a).

import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { renderPdf } from "@/lib/pdf/renderer";
import { brandKitTheme, DEFAULT_BRAND_COLORS, DEFAULT_BRAND_FONTS } from "@/lib/pdf/brand-theme";
import {
  buildReportDocument,
  type PlaceholderContext,
  type RankingRow,
  type TiptapNode,
} from "@/lib/pdf/report-document";

export function reportStorageDir(): string {
  const override = (process.env.REPORT_STORAGE_DIR ?? "").trim();
  if (override) return override;
  return path.join(process.cwd(), ".data", "reports");
}

function periodOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Latest + previous ranking per tracked keyword for the placeholder context. */
async function rankingRows(projectId: string): Promise<RankingRow[]> {
  const keywords = await prisma.keyword.findMany({
    where: { projectId, tracked: true },
    orderBy: { phrase: "asc" },
    include: {
      rankings: { orderBy: { checkedAt: "desc" }, take: 2 },
    },
  });
  return keywords.map((k) => {
    const latest = k.rankings[0] ?? null;
    const prev = k.rankings[1] ?? null;
    const change =
      latest?.position != null && prev?.position != null ? prev.position - latest.position : null;
    return {
      phrase: k.phrase,
      position: latest?.position ?? null,
      change,
      url: latest?.url ?? null,
      aiOverview: latest?.aiOverviewPresent ?? false,
    };
  });
}

function summarize(rows: RankingRow[]): PlaceholderContext["summary"] {
  const ranked = rows.filter((r) => r.position != null);
  const positions = ranked.map((r) => r.position as number);
  return {
    tracked: rows.length,
    ranked: ranked.length,
    avgPosition:
      positions.length === 0 ? null : positions.reduce((a, b) => a + b, 0) / positions.length,
    improved: rows.filter((r) => (r.change ?? 0) > 0).length,
    declined: rows.filter((r) => (r.change ?? 0) < 0).length,
    aiOverviewCount: rows.filter((r) => r.aiOverview).length,
  };
}

async function logoDataUri(logoPath: string | null): Promise<string | undefined> {
  if (!logoPath) return undefined;
  try {
    const abs = path.isAbsolute(logoPath) ? logoPath : path.join(process.cwd(), logoPath);
    const buf = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

export interface GenerateReportInput {
  templateId: string;
  /** "user" for on-demand, "system" for cron. */
  actor: "user" | "system";
  actorId?: string | null;
  clientId?: string | null;
  period?: string;
}

/**
 * Generate a branded PDF report from a template. Creates the Report row in
 * `generating` status first so failures are visible, then renders and flips
 * to `ready` (or `failed` with the error).
 */
export async function generateReport(input: GenerateReportInput) {
  const template = await prisma.reportTemplate.findUnique({
    where: { id: input.templateId },
    include: { brandKit: true, project: true, workspace: true },
  });
  if (!template) throw new Error("Template not found");

  const workspaceId = template.workspaceId;
  const projectId = template.projectId;

  // Brand kit: template's → workspace default → built-in fallback.
  const brandKit =
    template.brandKit ??
    (await prisma.brandKit.findFirst({ where: { workspaceId, isDefault: true } }));
  const theme = brandKitTheme({
    colors: brandKit?.colors ?? DEFAULT_BRAND_COLORS,
    fonts: brandKit?.fonts ?? DEFAULT_BRAND_FONTS,
  });
  const brandName = brandKit?.name ?? template.workspace.name;
  const logoSrc = await logoDataUri(brandKit?.logoPath ?? null);

  const now = new Date();
  const period = input.period ?? periodOf(now);
  const rows = projectId ? await rankingRows(projectId) : [];

  const ctx: PlaceholderContext = {
    projectDomain: template.project?.domain ?? "",
    period,
    generatedAt: now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    brandName,
    rankings: rows,
    summary: summarize(rows),
  };

  const report = await prisma.report.create({
    data: {
      clientId: input.clientId ?? null,
      templateId: template.id,
      brandKitId: brandKit?.id ?? null,
      projectId: projectId ?? null,
      period,
      status: "generating",
    },
  });

  try {
    const element = buildReportDocument({
      template: template.content as unknown as TiptapNode,
      theme,
      title: template.name,
      brandName,
      logoSrc,
      ctx,
    });
    const pdf = await renderPdf(element);

    const dir = reportStorageDir();
    await fs.mkdir(dir, { recursive: true });
    const pdfPath = path.join(dir, `${report.id}.pdf`);
    await fs.writeFile(pdfPath, pdf);

    const updated = await prisma.report.update({
      where: { id: report.id },
      data: {
        status: "ready",
        pdfPath: path.relative(process.cwd(), pdfPath),
      },
    });

    // Milestone 11 audit pattern: workspace-scoped event on file_change_log.
    await prisma.fileChangeLog.create({
      data: {
        workspaceId,
        projectId: projectId ?? null,
        connectionId: null,
        filePath: updated.pdfPath ?? pdfPath,
        actor: input.actor,
        action: "report_generated",
        summary: `Report "${template.name}" generated (${period})`.slice(0, 280),
        approvedBy: input.actorId ?? null,
      },
    });

    await prisma.reportTemplate.update({
      where: { id: template.id },
      data: { lastRunAt: now },
    });

    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.report.update({
      where: { id: report.id },
      data: { status: "failed", error: message.slice(0, 500) },
    });
    throw err;
  }
}
