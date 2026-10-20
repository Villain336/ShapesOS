// ShapesOS — M21 Google Drive adapter.
//
// LIVE WIRING (Phase 4b): with a vault credential this adapter calls the
// Google Drive API v3, read-only (lib/connectors/m21/live/google-drive.ts):
//   GET https://www.googleapis.com/drive/v3/files?q='<folder>' in parents …
//     → list_files() (pageToken pagination)
//   GET https://www.googleapis.com/drive/v3/files?q=name contains … or fullText contains …
//     → search_files()
//   GET https://www.googleapis.com/drive/v3/files/{fileId}/export?mimeType=text/plain|text/csv
//     (Docs/Sheets/Slides) or files/{fileId}?alt=media (text-like files)
//     → get_file_text() (capped at 200k chars; binaries return metadata only)
//   GET https://www.googleapis.com/drive/v3/about?fields=user → health check
// Auth: OAuth2 Bearer (scope drive.readonly only — the adapter never
// writes), refresh-on-401 through the vault; 429/5xx/rate-limit 403 back off.
// Docs: https://developers.google.com/workspace/drive/api/reference/rest/v3
//
// Phase 21B (WS=drive) adds WRITE tools (all mutating, so they ask; they need the
// broader `drive` OAuth scope — UNVERIFIED-LIVE): create_folder, upload_text_file,
// rename_or_move_file, trash_file (recoverable), and delete_folder (permanent —
// its name and description carry "delete", so the platform treats it as Tier 3:
// always asks, never auto — lib/agents/grants.ts maps it to delete_drive_folder).
// The same calls back the Drive FileProvider (lib/drive/providers/google-drive.ts).
//
// MOCK MODE (no credential): deterministic demo file listing + document
// text; every row flagged mock: true, titles carry "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { clampInt, liveFailure, tokenSourceFrom, ConnectorApiError, type LiveDeps } from "../live/http";
import {
  driveCreateFile,
  driveCreateFolder,
  driveDeletePermanently,
  driveGetFileText,
  driveGetMeta,
  driveListFiles,
  drivePing,
  driveUpdateMeta,
  folderQuery,
  normalizeDriveId,
  searchQuery,
} from "../live/google-drive";

const MOCK_FILES = [
  { id: "mock-doc-1", name: "Q3 Content Brief (MOCK)", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-18T09:00:00Z" },
  { id: "mock-doc-2", name: "Brand Voice Guide (MOCK)", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-08-30T14:00:00Z" },
  { id: "mock-sheet-1", name: "Keyword Tracker (MOCK)", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-21T11:30:00Z" },
  { id: "mock-slide-1", name: "Client Pitch Deck (MOCK)", mimeType: "application/vnd.google-apps.presentation", modifiedTime: "2026-09-10T16:45:00Z" },
  { id: "mock-pdf-1", name: "SEO Audit Report (MOCK).pdf", mimeType: "application/pdf", sizeBytes: 184320, modifiedTime: "2026-09-05T10:15:00Z" },
];

const MOCK_TEXT: Record<string, string> = {
  "mock-doc-1": "# Q3 Content Brief (MOCK)\n\nPillars: implant guides, whitening explainers, patient stories. Tone: warm, plain-English. CTA: book a consult.",
  "mock-doc-2": "# Brand Voice Guide (MOCK)\n\nVoice: gentle expert. Avoid: jargon, fear. Sign-off: “Smile brighter.”",
};

function nameArg(v: unknown, provider: string): string {
  const s = String(v ?? "").trim();
  if (!s || s.length > 255 || /[\\/\0]/.test(s)) throw new ConnectorApiError(provider, "bad_request", `${provider}: name must be 1–255 characters without slashes.`);
  return s;
}

function shape(f: { id?: string; name?: string; mimeType?: string; size?: string; modifiedTime?: string }) {
  return { id: f.id ?? "", name: f.name ?? "", mimeType: f.mimeType ?? "", ...(f.size ? { sizeBytes: Number(f.size) } : {}), modifiedTime: f.modifiedTime ?? null };
}

export class GoogleDriveAdapter implements ConnectorAdapter {
  readonly key = "google-drive";
  readonly displayName = "Google Drive";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      folderId: {
        type: "string",
        description: "Default Drive folder to browse. Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_files",
        description: "List files in a Drive folder (defaults to Drive root).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            folderId: strProp("Drive folder id (optional)."),
            limit: strProp("Max files (default 25)."),
          },
        },
      },
      {
        name: "search_files",
        description: "Search Drive files by name/content keyword.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            query: strProp("Search text, e.g. \"content brief\"."),
            limit: strProp("Max files (default 25)."),
          },
          required: ["query"],
        },
      },
      {
        name: "get_file_text",
        description: "Read a Drive file as text (Google Docs exported to plain text; CSV/PDF downloaded). Attach briefs to a chat session with this.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { fileId: strProp("Drive file id.") },
          required: ["fileId"],
        },
      },
      {
        name: "create_folder",
        description: "Create a folder in Google Drive (inside a parent folder, default Drive root).",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { name: strProp("Folder name."), parentId: strProp("Parent folder id (optional, default root).") },
          required: ["name"],
        },
      },
      {
        name: "upload_text_file",
        description: "Save a text file in Google Drive (up to 5 MB). Creates it in the folder; refuses if one with that name exists there.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            name: strProp("File name, e.g. brief.md."),
            content: strProp("The text to save."),
            parentId: strProp("Parent folder id (optional, default root)."),
            mimeType: strProp("MIME type (default text/plain)."),
          },
          required: ["name", "content"],
        },
      },
      {
        name: "rename_or_move_file",
        description: "Rename a Drive file or folder, and/or move it into another folder.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { fileId: strProp("Drive file or folder id."), name: strProp("New name (optional)."), parentId: strProp("Folder id to move it into (optional).") },
          required: ["fileId"],
        },
      },
      {
        name: "trash_file",
        description: "Move a Drive file or folder to the Drive trash (recoverable there for 30 days).",
        mutating: true,
        argsSchema: { type: "object", properties: { fileId: strProp("Drive file or folder id.") }, required: ["fileId"] },
      },
      {
        name: "delete_folder",
        description: "Delete a Drive folder and everything in it permanently. This cannot be undone.",
        mutating: true,
        argsSchema: { type: "object", properties: { folderId: strProp("Drive folder id.") }, required: ["folderId"] },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mockInvoke(tool, args);
    try {
      switch (tool) {
        case "list_files": {
          const folderRaw = args.folderId ?? ctx.projectConfig?.folderId;
          const folderId = folderRaw ? normalizeDriveId(folderRaw, "folderId") : undefined;
          return liveOk(await driveListFiles(auth, folderQuery(folderId), clampInt(args.limit, 25, 1, 200), this.deps));
        }
        case "search_files": {
          const text = String(args.query ?? "").trim();
          if (!text || text.length > 200) {
            throw new ConnectorApiError(this.displayName, "bad_request", `${this.displayName}: query must be 1–200 characters.`);
          }
          return liveOk(await driveListFiles(auth, searchQuery(text), clampInt(args.limit, 25, 1, 100), this.deps));
        }
        case "get_file_text":
          return liveOk(await driveGetFileText(auth, normalizeDriveId(args.fileId, "fileId"), this.deps));
        case "create_folder": {
          const name = nameArg(args.name, this.displayName);
          const parent = args.parentId ? normalizeDriveId(args.parentId, "parentId") : "root";
          return liveOk(shape(await driveCreateFolder(auth, parent, name, this.deps)));
        }
        case "upload_text_file": {
          const name = nameArg(args.name, this.displayName);
          const parent = args.parentId ? normalizeDriveId(args.parentId, "parentId") : "root";
          const content = typeof args.content === "string" ? args.content : "";
          return liveOk(shape(await driveCreateFile(auth, parent, name, String(args.mimeType ?? "text/plain"), Buffer.from(content, "utf8"), this.deps)));
        }
        case "rename_or_move_file": {
          const id = normalizeDriveId(args.fileId, "fileId");
          const name = args.name ? nameArg(args.name, this.displayName) : undefined;
          let addParent: string | undefined;
          let removeParent: string | undefined;
          if (args.parentId) {
            addParent = normalizeDriveId(args.parentId, "parentId");
            removeParent = (await driveGetMeta(auth, id, this.deps)).parents?.[0];
          }
          if (!name && !addParent) throw new ConnectorApiError(this.displayName, "bad_request", `${this.displayName}: give a new name and/or a folder to move it into.`);
          return liveOk(shape(await driveUpdateMeta(auth, id, { name, addParent, removeParent: removeParent !== addParent ? removeParent : undefined }, this.deps)));
        }
        case "trash_file":
          return liveOk(shape(await driveUpdateMeta(auth, normalizeDriveId(args.fileId, "fileId"), { trashed: true }, this.deps)));
        case "delete_folder": {
          const id = normalizeDriveId(args.folderId, "folderId");
          const meta = await driveGetMeta(auth, id, this.deps);
          if (meta.mimeType !== "application/vnd.google-apps.folder") throw new ConnectorApiError(this.displayName, "bad_request", `${this.displayName}: that id is not a folder.`);
          await driveDeletePermanently(auth, id, this.deps);
          return liveOk({ deleted: true, id });
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, error: "No access token stored.", errorCode: "not_connected" };
    try {
      return liveOk(await drivePing(auth, this.deps));
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mockInvoke(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "create_folder":
      case "upload_text_file":
      case "rename_or_move_file":
      case "trash_file":
      case "delete_folder":
        // Nothing is written in mock mode (no credential): say so, never pretend.
        return mockOk({ mock: true, note: "No Google Drive account is connected, so nothing was changed (MOCK)." });
      case "list_files": {
        const limit = Math.min(Number(args.limit) || 25, 100);
        return mockOk(
          MOCK_FILES.slice(0, limit).map((f) => ({ ...f, mock: true })),
        );
      }
      case "search_files": {
        const q = String(args.query).toLowerCase();
        return mockOk(
          MOCK_FILES.filter((f) => f.name.toLowerCase().includes(q)).map((f) => ({ ...f, mock: true })),
        );
      }
      case "get_file_text": {
        const id = String(args.fileId);
        const file = MOCK_FILES.find((f) => f.id === id);
        if (!file) return fail(`No file with id "${id}" (mock)`);
        return mockOk({
          fileId: id,
          name: file.name,
          text: `${MOCK_TEXT[id] ?? `Binary content of ${file.name} — not shown in mock mode.`} (MOCK)`,
          mock: true,
        });
      }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
