// Marketr — scheduler run-output store (Phase B, W2).
//
// Contract (owned by the sibling track building lib/filesystem/service.ts):
//   writeFile({ workspaceId, logicalPath: "/artifacts/runs/<run-id>/...", kind: "artifact", ... })
//   readFile / getFile
//
// The sibling module may not exist yet. This file therefore:
//
//  1. Defines SchedulerOutputStore — the interface the scheduler engine codes
//     against (mirrors the contract's call shape exactly).
//  2. Ships FallbackOutputStore — a local, workspace-scoped `.data/` writer
//     used until the sibling service is wired. Same logical paths, traversal
//     guarded, never crossing workspaces.
//  3. Ships FilesystemServiceStore — an adapter that takes the real service
//     module (injected, no static import) so wiring it later is a one-line
//     change in getOutputStore() without breaking the build now.

import { mkdir, writeFile as fsWriteFile, readFile as fsReadFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface OutputWrite {
  logicalPath: string;
}

export interface SchedulerOutputStore {
  writeReport(workspaceId: string, runId: string, filename: string, content: string): Promise<OutputWrite>;
  readReport(workspaceId: string, logicalPath: string): Promise<string | null>;
}

/** The logical path every run output lives at. Engine-constructed, never client-supplied. */
export function runOutputPath(runId: string, filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "report.md";
  return `/artifacts/runs/${runId}/${safe}`;
}

/**
 * Adapter over the real filesystem service (lib/filesystem/service.ts).
 *
 * Real service shape (2026-09-22, sibling track):
 *   writeFile({ workspaceId, logicalPath, kind: "artifact", bytes: Buffer,
 *               mimeType, createdBy, skipSafety: true }) -> { id, logicalPath, ... }
 *   readFile({ workspaceId, fileId }) -> { meta, bytes } | null
 *   listDir({ workspaceId, prefix })  -> { files: [{ id, logicalPath, ... }] }
 *
 * Reads are by fileId, so readReport locates the file via listDir on the
 * run's directory prefix and then reads by id. skipSafety is set because
 * reports are generated server-side with no user-controlled content — user
 * uploads always pass the gate (per the service's own contract).
 */
export class FilesystemServiceStore implements SchedulerOutputStore {
  constructor(
    private service: {
      writeFile: (args: {
        workspaceId: string;
        logicalPath: string;
        kind: "artifact";
        bytes: Buffer;
        mimeType: string;
        createdBy: string;
        skipSafety: boolean;
      }) => Promise<{ id: string; logicalPath: string }>;
      readFile: (args: { workspaceId: string; fileId: string }) => Promise<{ bytes: Buffer } | null>;
      listDir: (args: { workspaceId: string; prefix: string }) => Promise<{
        files: { id: string; logicalPath: string }[];
      }>;
    },
  ) {}

  async writeReport(workspaceId: string, runId: string, filename: string, content: string) {
    const logicalPath = runOutputPath(runId, filename);
    await this.service.writeFile({
      workspaceId,
      logicalPath,
      kind: "artifact",
      bytes: Buffer.from(content, "utf8"),
      mimeType: "text/markdown",
      createdBy: "scheduler",
      skipSafety: true,
    });
    return { logicalPath };
  }

  async readReport(workspaceId: string, logicalPath: string): Promise<string | null> {
    const prefix = logicalPath.slice(0, logicalPath.lastIndexOf("/")) || "/";
    const listing = await this.service.listDir({ workspaceId, prefix });
    const file = listing.files.find((f) => f.logicalPath === logicalPath);
    if (!file) return null;
    const row = await this.service.readFile({ workspaceId, fileId: file.id });
    return row ? row.bytes.toString("utf8") : null;
  }
}

/**
 * Local fallback: workspace-scoped writes under .data/scheduler-runs/.
 * Used until lib/filesystem/service.ts is wired. Traversal-guarded.
 */
export class FallbackOutputStore implements SchedulerOutputStore {
  constructor(private baseDir = join(process.cwd(), ".data", "scheduler-runs")) {}

  private resolvePath(workspaceId: string, logicalPath: string): string {
    const cleanWorkspace = String(workspaceId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const cleanLogical = String(logicalPath).replace(/^\/+/, "");
    const full = resolve(join(this.baseDir, cleanWorkspace, cleanLogical));
    const root = resolve(join(this.baseDir, cleanWorkspace)) + sep;
    if (!full.startsWith(root)) throw new Error("output path escapes workspace root");
    return full;
  }

  async writeReport(workspaceId: string, runId: string, filename: string, content: string) {
    const logicalPath = runOutputPath(runId, filename);
    const full = this.resolvePath(workspaceId, logicalPath);
    await mkdir(join(full, ".."), { recursive: true });
    await fsWriteFile(full, content, "utf8");
    return { logicalPath };
  }

  async readReport(workspaceId: string, logicalPath: string): Promise<string | null> {
    try {
      const full = this.resolvePath(workspaceId, logicalPath);
      return await fsReadFile(full, "utf8");
    } catch {
      return null;
    }
  }
}

let singleton: SchedulerOutputStore | null = null;

/**
 * The store the engine uses.
 *
 * Prefers the real filesystem service (lib/filesystem/service.ts, sibling
 * track) via dynamic import so this module never breaks the build before the
 * sibling's file lands — and falls back to the local workspace-scoped
 * .data/ writer if the import fails or the service throws (e.g. its tables
 * aren't migrated yet). The fallback keeps run outputs working standalone.
 *
 * Deliberately fail-closed at write time: if the *selected* store's write
 * throws, the run is marked failed rather than silently rerouted to the
 * other store. A silent fallback would split run outputs across two stores
 * (the filesystem-service UI would report the report missing while it sits
 * in .data/), which is worse than a loud failure that the operator can
 * retry. Reads likewise return null on failure and the run page says so.
 */
export async function getOutputStoreAsync(): Promise<SchedulerOutputStore> {
  if (singleton) return singleton; // test seam (scripts/verify-scheduler.mts)
  try {
    const mod = (await import("@/lib/filesystem/service")) as {
      writeFile?: unknown;
      readFile?: unknown;
      listDir?: unknown;
    };
    if (typeof mod.writeFile === "function" && typeof mod.readFile === "function" && typeof mod.listDir === "function") {
      return new FilesystemServiceStore(
        mod as unknown as ConstructorParameters<typeof FilesystemServiceStore>[0],
      );
    }
  } catch {
    // Sibling service unavailable — use the local fallback below.
  }
  return getFallbackStore();
}

function getFallbackStore(): SchedulerOutputStore {
  if (!singleton) singleton = new FallbackOutputStore();
  return singleton;
}

/** Synchronous accessor: the local fallback (no service import). */
export function getOutputStore(): SchedulerOutputStore {
  return getFallbackStore();
}

/** Test seam: swap the store for the battery. */
export function setOutputStore(store: SchedulerOutputStore | null): void {
  singleton = store;
}
