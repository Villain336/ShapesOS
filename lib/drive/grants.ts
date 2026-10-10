// ShapesOS — Phase 21B (WS=drive): what an agent run may do to files (PURE).
//
// A run gets its own workspace (/agents/<runId>) plus the folders the person
// attached to it. Every file operation the run asks for is checked here:
//   - the path (after the path rules: NFC, no ".." etc.) must be inside one of
//     those roots. Containment compares whole path segments (so /shared/Reports2
//     is NOT inside /shared/Reports) and the case-insensitive, NFC identity of
//     the names (two spellings of one folder are one folder);
//   - the TIER comes from the effect, never from the tool:
//       read                          Tier 0
//       create a new file             Tier 1   (auto-approvable like any write)
//       overwrite an existing file    Tier 2, always asks, never auto
//       move a file / trash one       Tier 2, always asks, never auto
//       trash many files at once      Tier 3   (BULK_TRASH_MIN or more; never auto)
//   - a move must stay inside the grant at both ends.
// Every accepted change creates a file version (lib/filesystem/versions.ts), so
// "Undo this agent run" can put the bytes back (lib/timemachine/undo.ts).
// The `action` strings are the kinds fed to evaluateTier (lib/orchestrator/
// authority.ts); the word "delete" appears only in the Tier-3 one on purpose.

import { collisionKey, normalizeFolderPath, normalizeLogicalPath } from "../filesystem/paths";

export const BULK_TRASH_MIN = 5;

export interface AgentGrant {
  runId: string;
  /** Folders the person attached to the run (canonical stored paths). */
  folders: string[];
}

export function grantRoots(g: AgentGrant): string[] {
  return [`/agents/${g.runId}`, ...g.folders];
}

export type AgentFileOp =
  | { kind: "read"; path: string }
  | { kind: "create"; path: string }
  | { kind: "overwrite"; path: string }
  | { kind: "write"; path: string; exists: boolean }
  | { kind: "move"; path: string; to: string }
  | { kind: "trash"; path: string; count: number };

export type AgentFileVerdict =
  | { allowed: true; tier: 0 | 1 | 2 | 3; action: string; alwaysAsk: boolean }
  | { allowed: false; reason: string };

function canonical(path: string): string | null {
  const f = normalizeLogicalPath(path);
  if (f.ok) return f.path;
  const d = normalizeFolderPath(path);
  return d.ok ? d.path : null;
}

function inside(root: string, path: string): boolean {
  const r = collisionKey(root);
  const p = collisionKey(path);
  return p === r || p.startsWith(`${r}/`);
}

function granted(g: AgentGrant, path: string): boolean {
  const c = canonical(path);
  if (!c) return false;
  return grantRoots(g).some((root) => inside(canonical(root) ?? root, c));
}

export function checkAgentFileOp(g: AgentGrant, op: AgentFileOp): AgentFileVerdict {
  if (!granted(g, op.path)) {
    return { allowed: false, reason: "That path is outside the folders this run was given. Ask the person to attach the folder." };
  }
  switch (op.kind) {
    case "read":
      return { allowed: true, tier: 0, action: "read agent file", alwaysAsk: false };
    case "create":
      return { allowed: true, tier: 1, action: "save agent file", alwaysAsk: false };
    case "write":
      return op.exists ? checkAgentFileOp(g, { kind: "overwrite", path: op.path }) : checkAgentFileOp(g, { kind: "create", path: op.path });
    case "overwrite":
      return { allowed: true, tier: 2, action: "replace agent file", alwaysAsk: true };
    case "move":
      if (!granted(g, op.to)) return { allowed: false, reason: "The destination is outside the folders this run was given." };
      return { allowed: true, tier: 2, action: "move agent file", alwaysAsk: true };
    case "trash":
      return op.count >= BULK_TRASH_MIN
        ? { allowed: true, tier: 3, action: "delete many agent files", alwaysAsk: true }
        : { allowed: true, tier: 2, action: "trash agent file", alwaysAsk: true };
  }
}
