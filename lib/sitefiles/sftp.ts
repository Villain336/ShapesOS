// Marketr — live SFTP site-file provider (ssh2).
//
// One connection per operation (connect → run → close): simple and safe for
// the supervised IDE rung, where operations are user-initiated. A later
// milestone (fix-agent autopilot) can add pooling.
//
// Security: secrets arrive here already decrypted server-side (see index.ts)
// and are never logged or sent to the client. Paths are sanitized before use.

import { Client, type SFTPWrapper } from "ssh2";
import type {
  FileEntry,
  ReadResult,
  SiteConnectionConfig,
  SiteFileProvider,
} from "./types";
import { sanitizePath } from "./paths";

const MAX_READ_BYTES = 200 * 1024;

function isBinary(buf: Buffer): boolean {
  // NUL bytes are a reliable binary signal for code/config files.
  return buf.includes(0);
}

export class SftpSiteFileProvider implements SiteFileProvider {
  readonly name = "sftp";
  readonly isLive = true;

  constructor(private readonly conn: SiteConnectionConfig) {}

  private connect(): Promise<{ client: Client; sftp: SFTPWrapper }> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const onError = (err: Error) => {
        client.end();
        reject(new Error(`SFTP connection failed: ${err.message}`));
      };
      client.once("error", onError);
      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            reject(new Error(`SFTP subsystem failed: ${err.message}`));
            return;
          }
          resolve({ client, sftp });
        });
      });
      const base = {
        host: this.conn.host,
        port: this.conn.port,
        username: this.conn.username,
        readyTimeout: 15000,
      };
      if (this.conn.authType === "key") {
        client.connect({ ...base, privateKey: this.conn.secret });
      } else {
        client.connect({ ...base, password: this.conn.secret });
      }
      // Safety net: never hang forever.
      setTimeout(() => {
        reject(new Error("SFTP connection timed out"));
        try {
          client.end();
        } catch {
          /* already closed */
        }
      }, 20000).unref?.();
    });
  }

  private async withSftp<T>(
    fn: (sftp: SFTPWrapper) => Promise<T>,
  ): Promise<T> {
    const { client, sftp } = await this.connect();
    try {
      return await fn(sftp);
    } finally {
      client.end();
    }
  }

  private toEntry(path: string, attrs: { size: number; mtime: number }, isDir: boolean): FileEntry {
    return {
      name: path === "/" ? "/" : path.split("/").pop()!,
      path,
      type: isDir ? "dir" : "file",
      size: attrs.size,
      modifiedAt: new Date(attrs.mtime * 1000).toISOString(),
    };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    return this.withSftp(
      (sftp) =>
        new Promise<FileEntry[]>((resolve, reject) => {
          sftp.readdir(dir, (err, list) => {
            if (err) {
              reject(new Error(`Cannot list ${dir}: ${err.message}`));
              return;
            }
            const entries = list
              .filter((e) => e.filename !== "." && e.filename !== "..")
              .map((e) =>
                this.toEntry(
                  dir === "/" ? `/${e.filename}` : `${dir}/${e.filename}`,
                  { size: e.attrs.size, mtime: e.attrs.mtime },
                  e.attrs.isDirectory(),
                ),
              )
              .sort((a, b) =>
                a.type === b.type
                  ? a.name.localeCompare(b.name)
                  : a.type === "dir"
                    ? -1
                    : 1,
              );
            resolve(entries);
          });
        }),
    );
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    return this.withSftp(
      (sftp) =>
        new Promise<ReadResult>((resolve, reject) => {
          // Read the first chunk to detect binary before pulling the file.
          const chunks: Buffer[] = [];
          let total = 0;
          let truncated = false;
          const stream = sftp.createReadStream(p, {
            start: 0,
            end: MAX_READ_BYTES - 1,
          });
          stream.on("data", (c: Buffer) => {
            chunks.push(c);
            total += c.length;
          });
          stream.on("end", () => {
            const buf = Buffer.concat(chunks);
            if (isBinary(buf)) {
              reject(new Error("Binary files are not editable"));
              return;
            }
            // If we hit the cap exactly, the file may be longer.
            sftp.stat(p, (err, stats) => {
              if (!err && stats.size > MAX_READ_BYTES) truncated = true;
              resolve({
                content: buf.toString("utf8"),
                truncated,
              });
            });
          });
          stream.on("error", (err: Error) =>
            reject(new Error(`Cannot read ${p}: ${err.message}`)),
          );
          void total;
        }),
    );
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    if (typeof content !== "string") throw new Error("Content must be text");
    if (content.includes("\u0000")) throw new Error("Binary files are not editable");
    const buf = Buffer.from(content, "utf8");
    if (buf.length > 1024 * 1024) throw new Error("File too large (1 MB cap)");
    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          // Ensure parent dirs exist (mkdir -p style).
          const parts = p.split("/").filter(Boolean);
          parts.pop(); // filename
          let built = "";
          const ensure = (i: number): void => {
            if (i >= parts.length) {
              sftp.writeFile(p, buf, (err) => {
                if (err) reject(new Error(`Cannot write ${p}: ${err.message}`));
                else resolve();
              });
              return;
            }
            built += "/" + parts[i];
            sftp.mkdir(built, (err) => {
              // EEXIST (code 4) is fine — the dir is already there.
              if (err && (err as { code?: number }).code !== 4) {
                reject(new Error(`Cannot create ${built}: ${err.message}`));
                return;
              }
              ensure(i + 1);
            });
          };
          ensure(0);
        }),
    );
  }

  async stat(path: string): Promise<FileEntry> {
    const p = sanitizePath(path);
    return this.withSftp(
      (sftp) =>
        new Promise<FileEntry>((resolve, reject) => {
          sftp.stat(p, (err, stats) => {
            if (err) {
              reject(new Error(`No such file or directory: ${p}`));
              return;
            }
            resolve(
              this.toEntry(
                p,
                { size: stats.size, mtime: stats.mtime },
                stats.isDirectory(),
              ),
            );
          });
        }),
    );
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.readdir("/", (err) => {
              if (err) reject(err);
              else resolve();
            });
          }),
      );
      return {
        ok: true,
        message: `Connected to ${this.conn.host}:${this.conn.port} as ${this.conn.username}.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Connection failed",
      };
    }
  }
}
