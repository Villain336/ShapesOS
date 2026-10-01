// Marketr — Dataset Builder slice 1: Google Drive via Nango Cloud.
// Spec §0: Nango managed Cloud is the integration runtime (managed OAuth,
// token refresh, request proxying). This file defines the adapter interface
// the ingest pipeline talks to, a fixture-backed mock (tests, no creds),
// and the live Cloud adapter, which fails closed with NANGO_NOT_CONFIGURED
// when credentials are absent — never a silent skip, never a live call in
// tests.

import { DatasetBuilderError } from "./types";

export interface DriveFileRef {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string | null;
}

export interface DriveFileContent {
  ref: DriveFileRef;
  /** Raw file bytes (native format for Google Docs types is exported). */
  bytes: Uint8Array;
  /** Filename used for extraction, e.g. "brief.pdf" or "plan.docx". */
  filename: string;
}

/** The Drive surface the ingest pipeline needs from Nango Cloud. */
export interface NangoDriveAdapter {
  /** List exportable/text files in the connected Google Drive. */
  listFiles(opts?: { query?: string; limit?: number }): Promise<DriveFileRef[]>;
  /** Download one file's content (Google Docs/Sheets exported to OOXML/CSV). */
  downloadFile(fileId: string): Promise<DriveFileContent>;
}

/** Config for the live Nango Cloud adapter. */
export interface NangoCloudConfig {
  secretKey: string;
  /** Nango connection id for the tenant's Google Drive. */
  connectionId: string;
}

export function nangoCloudConfigFromEnv(
  connectionId: string,
): NangoCloudConfig | null {
  const secretKey = process.env.NANGO_SECRET_KEY;
  if (!secretKey || !connectionId) return null;
  return { secretKey, connectionId };
}

// ------------------------------------------------------- live adapter ---

/**
 * Live adapter over the Nango Cloud REST API (proxy + Drive file export).
 * Constructing it without a full config throws NANGO_NOT_CONFIGURED at
 * call time, not at import time, so module load never touches the network.
 */
export class NangoCloudDriveAdapter implements NangoDriveAdapter {
  private readonly config: NangoCloudConfig;

  constructor(config: NangoCloudConfig | null) {
    if (!config) {
      throw new DatasetBuilderError(
        "NANGO_NOT_CONFIGURED",
        "Google Drive is not connected: set NANGO_SECRET_KEY and pass a Nango connection id",
      );
    }
    this.config = config;
  }

  private async proxy(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(
      `https://api.nango.dev/proxy${path}?connection_id=${encodeURIComponent(this.config.connectionId)}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.secretKey}`,
          ...(init?.headers ?? {}),
        },
      },
    );
    if (!res.ok) {
      throw new DatasetBuilderError(
        "FETCH_FAILED",
        `Nango proxy request failed (${res.status}): ${path}`,
      );
    }
    return res;
  }

  async listFiles(opts: { query?: string; limit?: number } = {}): Promise<DriveFileRef[]> {
    const q =
      opts.query ??
      "mimeType != 'application/vnd.google-apps.folder' and trashed = false";
    const params = new URLSearchParams({
      q,
      pageSize: String(opts.limit ?? 50),
      fields: "files(id,name,mimeType,size,modifiedTime)",
    });
    const res = await this.proxy(`/drive/v3/files?${params.toString()}`);
    const json = (await res.json()) as {
      files?: {
        id: string;
        name: string;
        mimeType: string;
        size?: string;
        modifiedTime?: string;
      }[];
    };
    return (json.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.size ? Number(f.size) : null,
      modifiedTime: f.modifiedTime ?? null,
    }));
  }

  async downloadFile(fileId: string): Promise<DriveFileContent> {
    const metaRes = await this.proxy(
      `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`,
    );
    const meta = (await metaRes.json()) as {
      id: string;
      name: string;
      mimeType: string;
      size?: string;
      modifiedTime?: string;
    };
    const ref: DriveFileRef = {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      sizeBytes: meta.size ? Number(meta.size) : null,
      modifiedTime: meta.modifiedTime ?? null,
    };

    // Google-native formats export to an ingestable form.
    const exportMime = exportMimeFor(meta.mimeType);
    let bytes: Uint8Array;
    let filename = meta.name;
    if (exportMime) {
      const res = await this.proxy(
        `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime.mime)}`,
      );
      bytes = new Uint8Array(await res.arrayBuffer());
      filename = withExtension(meta.name, exportMime.ext);
    } else {
      const res = await this.proxy(
        `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      );
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    return { ref, bytes, filename };
  }
}

function exportMimeFor(mimeType: string): { mime: string; ext: string } | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ext: "docx",
      };
    case "application/vnd.google-apps.spreadsheet":
      return { mime: "text/csv", ext: "csv" };
    case "application/vnd.google-apps.presentation":
      return { mime: "text/plain", ext: "md" };
    default:
      return null;
  }
}

function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

// --------------------------------------------------------- mock adapter ---

/** Fixture-backed mock: the entire Drive surface with zero credentials. */
export class MockNangoDriveAdapter implements NangoDriveAdapter {
  private readonly files: Map<string, DriveFileContent>;

  constructor(fixtures: DriveFileContent[] = []) {
    this.files = new Map(fixtures.map((f) => [f.ref.id, f]));
  }

  addFile(content: DriveFileContent): void {
    this.files.set(content.ref.id, content);
  }

  async listFiles(opts: { query?: string; limit?: number } = {}): Promise<DriveFileRef[]> {
    const all = [...this.files.values()].map((f) => f.ref);
    return all.slice(0, opts.limit ?? all.length);
  }

  async downloadFile(fileId: string): Promise<DriveFileContent> {
    const file = this.files.get(fileId);
    if (!file) {
      throw new DatasetBuilderError(
        "FETCH_FAILED",
        `mock Drive has no file with id "${fileId}"`,
      );
    }
    return file;
  }
}
