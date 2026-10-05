// ShapesOS — Phase 8 (ship): parse a stored `git diff` patch for the review
// UI (files → hunks → numbered lines). PURE; jsdiff's parser does the work.

import { parsePatch } from "diff";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "note";
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  /** Set when the file was renamed. */
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

function stripPrefix(name: string | undefined): string | null {
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "");
}

/** Parse a `git diff` patch into files → hunks → lines (jsdiff's parser). PURE. */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  if (!patch.trim()) return [];
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return [];
  }
  const files: DiffFile[] = [];
  for (const p of parsed) {
    const oldName = stripPrefix(p.oldFileName);
    const newName = stripPrefix(p.newFileName);
    const path = newName ?? oldName;
    if (!path) continue;
    const binary = (p as { isBinary?: boolean }).isBinary === true;
    const hunks: DiffHunk[] = p.hunks.map((h) => {
      let o = h.oldStart;
      let n = h.newStart;
      const lines: DiffLine[] = [];
      for (const raw of h.lines) {
        const mark = raw[0];
        const text = raw.slice(1);
        if (mark === "+") lines.push({ kind: "add", text, newNo: n++ });
        else if (mark === "-") lines.push({ kind: "del", text, oldNo: o++ });
        else if (mark === "\\") lines.push({ kind: "note", text: raw.slice(2) });
        else lines.push({ kind: "ctx", text, oldNo: o++, newNo: n++ });
      }
      return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines };
    });
    const additions = hunks.reduce((s, h) => s + h.lines.filter((l) => l.kind === "add").length, 0);
    const deletions = hunks.reduce((s, h) => s + h.lines.filter((l) => l.kind === "del").length, 0);
    const status: DiffFile["status"] = binary
      ? "binary"
      : !oldName
        ? "added"
        : !newName
          ? "deleted"
          : oldName !== newName
            ? "renamed"
            : "modified";
    files.push({ path, oldPath: status === "renamed" ? oldName : null, status, additions, deletions, hunks });
  }
  return files;
}

