// ShapesOS Phase 11 (seotools): analyze_data — data analysis code run in the
// agent run's Phase 8 sandbox, never on the host.
//
//   analyze_data  spend  run_sandbox_command (same tier as bash: asks)  group "code"
//
// The agent passes Python (default) or JavaScript plus the WorkspaceFiles to
// analyse (CSV, XLSX, JSON, TXT). Inputs are copied into a fresh
// analysis/<id>/input folder; every XLSX sheet is also written as CSV there
// (so the standard library can read it without pandas). The code runs with
// INPUT_DIR / OUTPUT_DIR set (MPLBACKEND=Agg for charts), output streams to
// the run timeline, and whatever it writes to OUTPUT_DIR (charts, tables,
// reports) is saved back as WorkspaceFiles through the filesystem service
// (upload-safety sniff + quota) under /files/analysis/<project>/<month>/.
// Optional packages are pip / npm installed first (names validated; the
// sandbox egress allows only the package registries).
//
// No sandbox provider → the tool says why and does nothing (it is also
// dropped from the turn's grant: the "code" group is off without one).

import { randomUUID } from "node:crypto";
import { registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { readFile as readWorkspaceFile, writeFile as writeWorkspaceFile, FsError } from "@/lib/filesystem/service";
import { workspaceFileUrl } from "@/lib/images/files";
import { readXlsx } from "@/lib/documents/xlsx";
import type { Sandbox } from "./types";
import { sandboxForRun, SandboxUnavailableError } from "./index";
import { OutputStreamer, flushCheckpoint } from "./tools";
import { shq } from "./paths";

export const ANALYSIS_FILES_ROOT = "/files/analysis";
const INPUT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_INPUTS = 10;
const OUTPUT_MAX_FILES = 10;
const OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MODEL_OUTPUT_CHARS = 20_000;

const INPUT_EXT = /\.(csv|tsv|xlsx|json|txt|md)$/i;
const OUTPUT_EXT = /\.(png|jpe?g|webp|svg|csv|xlsx|txt|md|pdf)$/i;
const OUTPUT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
};

/** pip / npm package specs we accept: name, optional extras and a version pin. */
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9_,-]+\])?((==|>=|<=|~=|@)[A-Za-z0-9.*_-]{1,40})?$/;

export function parsePackages(raw: unknown): string[] {
  const list = (typeof raw === "string" ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw.map(String) : []).map((p) => p.trim()).filter(Boolean);
  if (list.length > 20) throw new Error("At most 20 packages.");
  for (const p of list) if (!PACKAGE_RE.test(p)) throw new Error(`"${p}" is not a valid package name.`);
  return list;
}

/** A filename safe inside the sandbox input / workspace output folders. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100) || "file";
}

function tail(s: string, n = MODEL_OUTPUT_CHARS): string {
  return s.length <= n ? s : `…[${s.length - n} earlier characters cut]\n${s.slice(-n)}`;
}

/** RFC 4180 quoting only: analysis inputs keep the data exactly (no formula prefixing). */
function rawCsvCell(c: unknown): string {
  if (c === null || c === undefined) return "";
  const s = c instanceof Date ? c.toISOString() : String(c);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** XLSX → one CSV per sheet, for code that only has the standard library. */
export async function xlsxToCsvFiles(bytes: Buffer, stem: string): Promise<{ name: string; csv: string }[]> {
  const sheets = await readXlsx(bytes, 200_000);
  return sheets.map((s) => ({
    name: `${stem}.${safeFileName(s.name)}.csv`,
    csv: s.rows.map((r) => r.map(rawCsvCell).join(",")).join("\r\n") + "\r\n",
  }));
}

let sandboxOverride: ((ctx: ToolContext) => Promise<Sandbox>) | null = null;

/** Tests: hand the tool a sandbox without the database (null restores). */
export function setAnalyzeSandboxForTests(fn: ((ctx: ToolContext) => Promise<Sandbox>) | null): void {
  sandboxOverride = fn;
}

async function runNote(ctx: ToolContext, summary: string, payload: Record<string, unknown>): Promise<void> {
  if (!ctx.runId || sandboxOverride) return;
  try {
    const { appendAgentRunEvent } = await import("@/lib/agents/runs/service");
    await appendAgentRunEvent(ctx.workspaceId, ctx.runId, { type: "note", summary: summary.slice(0, 280), payload });
  } catch {
    // best effort
  }
}

export const analyze_data: ToolDef = {
  name: "analyze_data",
  description:
    "Analyse workspace files (CSV, XLSX, JSON, TXT) by running Python (default) or JavaScript in the isolated code sandbox. Inputs are in $INPUT_DIR (each XLSX sheet also as <file>.<sheet>.csv); write charts and tables to $OUTPUT_DIR (matplotlib uses the Agg backend) and they are saved to the workspace files. Print the findings to stdout. Pass packages (e.g. \"pandas matplotlib\") to install them first.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The program. Python: read files from os.environ['INPUT_DIR'], write to os.environ['OUTPUT_DIR']." },
      language: { type: "string", description: '"python" (default) or "javascript" (Node ESM).' },
      fileIds: { type: "string", description: "Comma-separated WorkspaceFile ids to analyse (optional)." },
      packages: { type: "string", description: 'Packages to install first, e.g. "pandas matplotlib" (pip) or "d3-dsv" (npm). Optional.' },
      timeout_ms: { type: "number", description: "Time limit in ms (default 120000, max 600000)." },
    },
    required: ["code"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    if (!roleAtLeast(ctx.role, "editor")) throw new Error("editor role required");
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) return { summary: "analyze_data needs code.", details: { error: "code" } };
    const language = String(args.language ?? "python").toLowerCase() === "javascript" || String(args.language).toLowerCase() === "js" ? "javascript" : "python";
    let packages: string[];
    try {
      packages = parsePackages(args.packages);
    } catch (err) {
      return { summary: err instanceof Error ? err.message : "Bad packages.", details: { error: "packages" } };
    }
    const fileIds = (typeof args.fileIds === "string" ? args.fileIds.split(",") : Array.isArray(args.fileIds) ? args.fileIds.map(String) : [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_INPUTS);
    const n = typeof args.timeout_ms === "number" ? args.timeout_ms : Number(args.timeout_ms);
    const timeoutMs = Math.min(Math.max(Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TIMEOUT_MS, 5_000), MAX_TIMEOUT_MS);

    // Inputs first (workspace-scoped reads) — a bad id fails before any sandbox work.
    const inputs: { name: string; bytes: Buffer }[] = [];
    for (const id of fileIds) {
      const f = await readWorkspaceFile({ workspaceId: ctx.workspaceId, fileId: id });
      if (!f) return { summary: `File ${id} was not found in this workspace.`, details: { error: "file_not_found", fileId: id } };
      if (!INPUT_EXT.test(f.meta.filename)) return { summary: `${f.meta.filename}: only CSV, TSV, XLSX, JSON, TXT and MD files can be analysed.`, details: { error: "file_type" } };
      if (f.bytes.length > INPUT_MAX_BYTES) return { summary: `${f.meta.filename} is over the ${INPUT_MAX_BYTES / 1024 / 1024} MB analysis limit.`, details: { error: "too_large" } };
      inputs.push({ name: safeFileName(f.meta.filename), bytes: f.bytes });
    }

    let sb: Sandbox;
    try {
      sb = sandboxOverride ? await sandboxOverride(ctx) : await sandboxForRun(ctx);
    } catch (err) {
      if (err instanceof SandboxUnavailableError) return { summary: err.message, details: { unavailable: true, reason: err.reason } };
      throw err;
    }

    const id = randomUUID().slice(0, 8);
    const dir = `${sb.workdir.replace(/\/+$/, "")}/analysis/${id}`;
    const inDir = `${dir}/input`;
    const outDir = `${dir}/output`;
    await sb.exec(["mkdir", "-p", inDir, outDir], { timeoutMs: 15_000 });
    const written: string[] = [];
    for (const f of inputs) {
      await sb.writeFile(`${inDir}/${f.name}`, f.bytes);
      written.push(f.name);
      if (/\.xlsx$/i.test(f.name)) {
        try {
          for (const c of await xlsxToCsvFiles(f.bytes, f.name.replace(/\.xlsx$/i, ""))) {
            await sb.writeFile(`${inDir}/${c.name}`, c.csv);
            written.push(c.name);
          }
        } catch {
          // unreadable workbook: the original stays for the code to try
        }
      }
    }
    const main = language === "python" ? "main.py" : "main.mjs";
    await sb.writeFile(`${dir}/${main}`, code);
    await flushCheckpoint(ctx, sb).catch(() => null);

    const env = { INPUT_DIR: inDir, OUTPUT_DIR: outDir, MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    const install = packages.length
      ? language === "python"
        ? `python3 -m pip install --quiet --user ${packages.map(shq).join(" ")} 2>&1 || python3 -m pip install --quiet --break-system-packages --user ${packages.map(shq).join(" ")} 2>&1; `
        : `npm install --silent --no-audit --no-fund --prefix ${shq(dir)} ${packages.map(shq).join(" ")} 2>&1; `
      : "";
    const run = language === "python" ? `python3 ${main}` : `node ${main}`;
    const streamer = new OutputStreamer((stream, data) => runNote(ctx, `analyze_data ${stream}`, { kind: "sandbox.output", tool: "analyze_data", stream, data }));
    let r;
    try {
      r = await sb.exec(`${install}${run}`, {
        cwd: dir,
        env,
        timeoutMs,
        signal: ctx.signal,
        onOutput: (c) => streamer.push(c),
        maxOutputBytes: 2 * 1024 * 1024,
      });
    } finally {
      await streamer.flush();
    }

    // Collect what the program wrote to OUTPUT_DIR.
    const saved: { fileId: string; name: string; logicalPath: string; url: string }[] = [];
    const skipped: string[] = [];
    const month = new Date().toISOString().slice(0, 7);
    const entries = (await sb.listFiles(outDir, { recursive: true, maxEntries: 200 }).catch(() => [])).filter((e) => e.type === "file");
    for (const e of entries) {
      const name = safeFileName(e.path);
      if (saved.length >= OUTPUT_MAX_FILES) {
        skipped.push(`${e.path} (more than ${OUTPUT_MAX_FILES} files)`);
        continue;
      }
      if (!OUTPUT_EXT.test(name)) {
        skipped.push(`${e.path} (type not saved)`);
        continue;
      }
      if ((e.size ?? 0) > OUTPUT_MAX_BYTES) {
        skipped.push(`${e.path} (over ${OUTPUT_MAX_BYTES / 1024 / 1024} MB)`);
        continue;
      }
      try {
        const bytes = await sb.readFile(`${outDir}/${e.path}`);
        if (!bytes.length) {
          skipped.push(`${e.path} (empty)`);
          continue;
        }
        const ext = name.split(".").pop()!.toLowerCase();
        const file = await writeWorkspaceFile({
          workspaceId: ctx.workspaceId,
          logicalPath: `${ANALYSIS_FILES_ROOT}/${safeFileName(ctx.projectId)}/${month}/${id}-${name}`,
          kind: "file",
          bytes,
          mimeType: OUTPUT_MIME[ext] ?? "application/octet-stream",
          createdBy: ctx.userId,
        });
        saved.push({ fileId: file.id, name, logicalPath: file.logicalPath, url: workspaceFileUrl(ctx.workspaceId, file.id) });
      } catch (err) {
        skipped.push(`${e.path} (${err instanceof FsError ? err.message : "could not be saved"})`);
      }
    }

    const status = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${r.exitCode}`;
    const parts = [`analyze_data (${language}${inputs.length ? `, ${inputs.length} input file${inputs.length === 1 ? "" : "s"}` : ""}) → ${status} (${Math.round(r.durationMs / 100) / 10} s)`];
    if (r.stdout) parts.push(`stdout:\n${tail(r.stdout)}`);
    if (r.stderr) parts.push(`stderr:\n${tail(r.stderr)}`);
    if (saved.length) parts.push(`Saved: ${saved.map((s) => s.logicalPath).join(", ")}`);
    if (skipped.length) parts.push(`Not saved: ${skipped.join("; ")}`);
    return {
      summary: parts.join("\n"),
      details: { exitCode: r.exitCode, timedOut: r.timedOut, truncated: r.truncated, durationMs: r.durationMs, language, inputs: written, files: saved, skipped },
    };
  },
};

let registered = false;
export function registerAnalyzeTool(): void {
  if (registered) return;
  registered = true;
  registerExtraTool(analyze_data);
}

registerAnalyzeTool();
