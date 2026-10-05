// ShapesOS — workspace data export (Phase 4a, GDPR Art. 20 portability).
//
// Everything the workspace owns, as one streamed JSON document:
//
//   { "format": "shapesos.workspace-export", "version": 1, "exportedAt": …,
//     "workspace": { …the workspace row… },
//     "tables": { "<table>": [ {row}, … ], … },
//     "manifest": { "tables": { "<table>": { "rows": n, "omittedColumns": […] } },
//                   "omittedTables": […], "notes": […] } }
//
// Which tables: every table with a workspace_id, plus tables that reach one
// through foreign keys (lib/gdpr/catalog.ts), read from the live catalog so
// new tables are included without touching this file. Every read runs with
// the workspace's RLS scope and a workspace predicate, so another tenant's
// rows can't leak in even through a bad join.
//
// Left out: credential ciphertext, token hashes, passwords, signing secrets
// and hints (isSecretColumn), tables of live credentials (SECRET_TABLES),
// and binary/embedding columns. The manifest lists each omission.

import {
  SECRET_TABLES,
  exportableColumns,
  loadCatalog,
  workspaceScopePredicate,
  type Catalog,
} from "./catalog";
import { scopedRows } from "./stream";

export const WORKSPACE_EXPORT_FORMAT = "shapesos.workspace-export";

export interface ExportPlanEntry {
  table: string;
  predicate: string;
  omittedColumns: string[];
  columns: ReturnType<typeof exportableColumns>["include"];
}

/** Which tables, with which predicate and columns (pure given a catalog). */
export function planWorkspaceExport(catalog: Catalog): { entries: ExportPlanEntry[]; omittedTables: string[] } {
  const entries: ExportPlanEntry[] = [];
  const omittedTables: string[] = [];
  for (const name of [...catalog.keys()].sort()) {
    if (name === "workspaces") continue; // emitted as the top-level "workspace"
    const predicate = workspaceScopePredicate(catalog, name);
    if (!predicate) continue; // not workspace-owned (global catalogs, rate limits, …)
    if (SECRET_TABLES.includes(name)) {
      omittedTables.push(name);
      continue;
    }
    const t = catalog.get(name)!;
    const { include, omitted } = exportableColumns(t);
    entries.push({ table: name, predicate, columns: include, omittedColumns: omitted });
  }
  return { entries, omittedTables };
}

export async function* workspaceExport(workspaceId: string, now = new Date()): AsyncGenerator<string> {
  const catalog = await loadCatalog();
  const { entries, omittedTables } = planWorkspaceExport(catalog);
  const wsTable = catalog.get("workspaces")!;
  const wsCols = exportableColumns(wsTable);

  yield `{"format":${JSON.stringify(WORKSPACE_EXPORT_FORMAT)},"version":1,"exportedAt":${JSON.stringify(now.toISOString())},"workspace":`;
  let wsRow = "null";
  for await (const row of scopedRows({
    table: wsTable,
    columns: wsCols.include,
    predicate: `t."id" = $1`,
    params: [workspaceId],
    gucWorkspaceId: workspaceId,
  })) {
    wsRow = row;
  }
  yield wsRow;
  yield `,"tables":{`;

  const manifest: Record<string, { rows: number; omittedColumns: string[] }> = {};
  let firstTable = true;
  for (const e of entries) {
    let n = 0;
    for await (const row of scopedRows({
      table: catalog.get(e.table)!,
      columns: e.columns,
      predicate: e.predicate,
      params: [workspaceId],
      gucWorkspaceId: workspaceId,
    })) {
      if (n === 0) {
        yield `${firstTable ? "" : ","}${JSON.stringify(e.table)}:[`;
        firstTable = false;
      }
      yield `${n === 0 ? "" : ","}${row}`;
      n++;
    }
    if (n > 0) yield "]";
    if (n > 0 || e.omittedColumns.length) manifest[e.table] = { rows: n, omittedColumns: e.omittedColumns };
  }
  yield "}";
  yield `,"manifest":${JSON.stringify({
    tables: manifest,
    workspaceOmittedColumns: wsCols.omitted,
    omittedTables,
    notes: [
      "Credential ciphertext, token hashes, passwords, signing secrets and hints are never exported.",
      "Binary and embedding columns are omitted; files in workspace storage are not included.",
      "Tables with no rows for this workspace are left out of \"tables\".",
    ],
  })}}`;
}

export function exportFilename(prefix: string, name: string, now = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "export";
  return `shapesos-${prefix}-${slug}-${now.toISOString().slice(0, 10)}.json`;
}
