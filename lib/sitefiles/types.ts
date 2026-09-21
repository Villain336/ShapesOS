// Marketr — swappable site-file provider interface (milestone 6).
// The IDE and (later) the fix agent depend ONLY on these types +
// getSiteFileProvider(). Implementations: SFTP via ssh2 (live) and a
// deterministic demo site tree (mock). Callers never touch either directly.

export interface FileEntry {
  /** File or directory name, e.g. "index.php". */
  name: string;
  /** Absolute-style path, e.g. "/public_html/index.php". */
  path: string;
  type: "file" | "dir";
  size?: number;
  modifiedAt?: string;
  /** True when served by the mock provider — the UI labels it honestly. */
  mock?: boolean;
}

export interface ReadResult {
  content: string;
  /** True when the file was truncated at the read cap. */
  truncated: boolean;
  mock?: boolean;
}

export interface SiteFileProvider {
  /** Stable provider key, e.g. "sftp" | "mock". */
  readonly name: string;
  /** True only when backed by a real SFTP connection. */
  readonly isLive: boolean;
  /** List a directory's entries. Path "" or "/" = connection root. */
  listDir(path: string): Promise<FileEntry[]>;
  /** Read a text file (throws on binary / oversize). */
  readFile(path: string): Promise<ReadResult>;
  /** Write a text file, creating parent dirs as needed. */
  writeFile(path: string, content: string): Promise<void>;
  /** Stat a single path. */
  stat(path: string): Promise<FileEntry>;
  /** Connectivity probe used by the "Test connection" button. */
  test(): Promise<{ ok: boolean; message: string }>;
}

/** Connection record as the factory needs it (secret already decrypted). */
export interface SiteConnectionConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** Decrypted secret (password or private key). Server-only, never to the client. */
  secret: string;
  demo: boolean;
}
