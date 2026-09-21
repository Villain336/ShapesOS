// Marketr — mock site-file provider.
//
// Serves a deterministic demo site tree (a small WordPress-style site) so the
// full IDE flow — connect → browse → edit → AI propose → approve → save —
// works end-to-end without real SFTP credentials. Every entry is flagged
// `mock: true` and the UI labels it honestly. Writes mutate an in-memory map
// (per server process); restarting resets the demo. Never ship as real data.

import type { FileEntry, ReadResult, SiteFileProvider } from "./types";
import { joinPath, parentPath, sanitizePath } from "./paths";

const MAX_READ_BYTES = 200 * 1024;

function demoFiles(): Map<string, string> {
  const files = new Map<string, string>();

  files.set(
    "/public_html/index.php",
    [
      "<?php",
      "/**",
      " * Demo site front page (MOCK — not a real site).",
      " */",
      "get_header(); ?>",
      "",
      "<main>",
      "  <h1>Welcome to Acme Plumbing</h1>",
      "  <p>We fix leaks, install water heaters, and unclog drains across the Triad.</p>",
      "  <a href=\"/contact.php\">Get a free quote</a>",
      "</main>",
      "",
      "<?php get_footer(); ?>",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/contact.php",
    [
      "<?php",
      "// Demo contact page (MOCK).",
      "get_header(); ?>",
      "",
      "<main>",
      "  <h1>Contact Us</h1>",
      "  <form method=\"post\" action=\"/contact.php\">",
      "    <label>Name <input type=\"text\" name=\"name\" required></label>",
      "    <label>Phone <input type=\"tel\" name=\"phone\" required></label>",
      "    <button type=\"submit\">Request callback</button>",
      "  </form>",
      "</main>",
      "",
      "<?php get_footer(); ?>",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/wp-config.php",
    [
      "<?php",
      "// Demo wp-config (MOCK). All values are placeholders.",
      "define( 'DB_NAME', 'demo_db' );",
      "define( 'DB_USER', 'demo_user' );",
      "define( 'DB_PASSWORD', 'not-a-real-password' );",
      "define( 'DB_HOST', 'localhost' );",
      "define( 'WP_DEBUG', false );",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/.htaccess",
    [
      "# Demo .htaccess (MOCK).",
      "<IfModule mod_rewrite.c>",
      "RewriteEngine On",
      "RewriteBase /",
      "RewriteRule ^index\\.php$ - [L]",
      "RewriteCond %{REQUEST_FILENAME} !-f",
      "RewriteCond %{REQUEST_FILENAME} !-d",
      "RewriteRule . /index.php [L]",
      "</IfModule>",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/wp-content/themes/acme/style.css",
    [
      "/*",
      " * Demo theme stylesheet (MOCK).",
      " * Theme Name: Acme",
      " */",
      "",
      "body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; }",
      "header.site-header { background: #0f172a; color: #fff; padding: 1rem 2rem; }",
      "main { max-width: 720px; margin: 2rem auto; padding: 0 1rem; }",
      "footer.site-footer { border-top: 1px solid #e5e5e5; padding: 1rem 2rem; color: #666; }",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/wp-content/themes/acme/header.php",
    [
      "<!DOCTYPE html>",
      "<!-- Demo theme header (MOCK). -->",
      "<html lang=\"en\">",
      "<head>",
      "  <meta charset=\"utf-8\">",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "  <title>Acme Plumbing</title>",
      "  <?php wp_head(); ?>",
      "</head>",
      "<body>",
      "<header class=\"site-header\">",
      "  <strong>Acme Plumbing</strong>",
      "  <nav><a href=\"/\">Home</a> <a href=\"/contact.php\">Contact</a></nav>",
      "</header>",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/wp-content/themes/acme/footer.php",
    [
      "<!-- Demo theme footer (MOCK). -->",
      "<footer class=\"site-footer\">",
      "  <p>&copy; 2026 Acme Plumbing. Demo site.</p>",
      "</footer>",
      "<?php wp_footer(); ?>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );

  files.set(
    "/public_html/wp-content/themes/acme/functions.php",
    [
      "<?php",
      "// Demo theme functions (MOCK).",
      "add_action( 'wp_enqueue_scripts', function () {",
      "    wp_enqueue_style( 'acme-style', get_stylesheet_uri() );",
      "} );",
      "",
    ].join("\n"),
  );

  return files;
}

export class MockSiteFileProvider implements SiteFileProvider {
  readonly name = "mock";
  readonly isLive = false;
  private files: Map<string, string>;

  constructor() {
    this.files = demoFiles();
  }

  private entry(path: string): FileEntry {
    const p = sanitizePath(path);
    if (this.files.has(p)) {
      return {
        name: p.split("/").pop()!,
        path: p,
        type: "file",
        size: Buffer.byteLength(this.files.get(p)!, "utf8"),
        mock: true,
      };
    }
    // Directory if it is root or prefixes any file.
    const isDir =
      p === "/" || [...this.files.keys()].some((f) => f.startsWith(p + "/"));
    if (!isDir) throw new Error(`No such file or directory: ${p}`);
    return {
      name: p === "/" ? "/" : p.split("/").pop()!,
      path: p,
      type: "dir",
      mock: true,
    };
  }

  async listDir(path: string): Promise<FileEntry[]> {
    const dir = sanitizePath(path);
    this.entry(dir); // throws if missing
    const seen = new Map<string, FileEntry>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(dir === "/" ? "/" : dir + "/")) continue;
      const rest = f.slice(dir === "/" ? 1 : dir.length + 1);
      const [head, ...tail] = rest.split("/");
      const childPath = joinPath(dir, head);
      if (tail.length === 0) {
        seen.set(childPath, this.entry(childPath));
      } else if (!seen.has(childPath)) {
        seen.set(childPath, {
          name: head,
          path: childPath,
          type: "dir",
          mock: true,
        });
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
  }

  async readFile(path: string): Promise<ReadResult> {
    const p = sanitizePath(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`No such file: ${p}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_READ_BYTES) {
      return { content: content.slice(0, MAX_READ_BYTES), truncated: true, mock: true };
    }
    return { content, truncated: false, mock: true };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = sanitizePath(path);
    if (typeof content !== "string") throw new Error("Content must be text");
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) {
      throw new Error("File too large (1 MB cap)");
    }
    // Refuse binary content.
    if (content.includes("\u0000")) throw new Error("Binary files are not editable");
    this.files.set(p, content);
  }

  async stat(path: string): Promise<FileEntry> {
    return this.entry(path);
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    const count = this.files.size;
    return {
      ok: true,
      message: `Demo site reachable — ${count} mock files, no real connection.`,
    };
  }

  /** For tests: which mock file paths exist. */
  debugPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  parentOf = parentPath;
}
