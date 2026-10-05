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
  driveGetFileText,
  driveListFiles,
  drivePing,
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
