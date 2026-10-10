// ShapesOS — Phase 21B (WS=drive): "restore this folder as of <time>" (PURE planner).
//
// Built from version history (workspace_file_versions) and the change journal
// (moves and trashing after the time). It never deletes anything:
//   - a file that did not exist yet is left alone;
//   - a file that was already in the trash then is left alone;
//   - a file whose bytes differ gets the old bytes written as a NEW version
//     (the current bytes stay in history);
//   - a file that was live then and is in the trash now is brought back;
//   - a file moved away since then keeps its place and gets the old bytes there
//     (reported with `movedFrom`);
//   - history the retention setting already purged is reported as unavailable.
// The caller (lib/drive/restore.ts) gathers the facts, shows this plan as a
// dry run first, and applies it only when asked.

export interface RestoreFileFacts {
  id: string;
  currentPath: string;
  createdAt: Date;
  currentVersion: number;
  trashedNow: boolean;
  /** Was it in the trash at the chosen time? (from the journal) */
  trashedAsOf: boolean;
  /** Moves after the chosen time, oldest first: where the file was before each. */
  movedAfter: Array<{ at: Date; fromPath: string }>;
  /** A different live file now sits at this file's path (an untrash would collide). */
  livePathTaken: boolean;
  /** Every version still held, the current one last (until: null). */
  versions: Array<{ version: number; from: Date; until: Date | null }>;
}

export type RestoreAction = "restore_version" | "untrash" | "unchanged" | "skip_created_after" | "skip_trashed_then" | "unavailable" | "conflict";

export interface RestoreItem {
  fileId: string;
  path: string;
  action: RestoreAction;
  toVersion: number | null;
  untrash: boolean;
  movedFrom: string | null;
  reason: string | null;
}

export interface RestorePlan {
  folder: string;
  asOf: Date;
  dryRun: true;
  items: RestoreItem[];
  summary: { restoreVersion: number; untrash: number; unchanged: number; skipped: number; unavailable: number; conflicts: number };
  /** Always 0: a restore only adds versions and brings files back. */
  willDelete: 0;
}

function within(folder: string, path: string): boolean {
  return path.startsWith(`${folder}/`);
}

export function planRestoreAsOf(input: { folder: string; asOf: Date; files: RestoreFileFacts[] }): RestorePlan {
  const items: RestoreItem[] = [];
  const t = input.asOf.getTime();
  for (const f of input.files) {
    const earliestMove = [...f.movedAfter].sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    const pathAsOf = earliestMove ? earliestMove.fromPath : f.currentPath;
    if (!within(input.folder, pathAsOf)) continue;
    const movedFrom = earliestMove && earliestMove.fromPath !== f.currentPath ? earliestMove.fromPath : null;
    const item = (action: RestoreAction, extra: Partial<RestoreItem> = {}): void => {
      items.push({ fileId: f.id, path: f.currentPath, action, toVersion: null, untrash: false, movedFrom, reason: null, ...extra });
    };
    if (f.createdAt.getTime() > t) {
      item("skip_created_after", { reason: "It did not exist yet; it is left as it is." });
      continue;
    }
    if (f.trashedAsOf) {
      item("skip_trashed_then", { reason: "It was already in the trash then; it is left as it is." });
      continue;
    }
    const v = f.versions.find((x) => x.from.getTime() <= t && (x.until === null || t < x.until.getTime()));
    if (!v) {
      item("unavailable", { reason: "The version history for that moment was already cleared by the retention setting." });
      continue;
    }
    if (f.trashedNow && f.livePathTaken) {
      item("conflict", { reason: "Another file already sits at this path; rename or move it first." });
      continue;
    }
    if (v.version === f.currentVersion) {
      if (f.trashedNow) item("untrash", { untrash: true });
      else item("unchanged");
      continue;
    }
    item("restore_version", { toVersion: v.version, untrash: f.trashedNow });
  }
  const count = (a: RestoreAction) => items.filter((i) => i.action === a).length;
  return {
    folder: input.folder,
    asOf: input.asOf,
    dryRun: true,
    items,
    summary: {
      restoreVersion: count("restore_version"),
      untrash: count("untrash"),
      unchanged: count("unchanged"),
      skipped: count("skip_created_after") + count("skip_trashed_then"),
      unavailable: count("unavailable"),
      conflicts: count("conflict"),
    },
    willDelete: 0,
  };
}
