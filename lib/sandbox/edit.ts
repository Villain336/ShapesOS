// ShapesOS — Phase 8: the pure parts of the code tools (no I/O).
//
//   applyExactEdit   edit_file's rule (like Claude Code's Edit): old_string
//                    must match EXACTLY once unless replace_all; otherwise
//                    fail with a message that says what to do
//   globToRegExp     glob → RegExp (**, *, ?, {a,b}, [abc])
//   numberLines      read_file's `cat -n` view of a line range
//   detectRepoProfile which test / lint command a checkout uses

export type EditOutcome = { ok: true; content: string; replacements: number } | { ok: false; error: string };

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export function applyExactEdit(content: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
  if (oldString === "") return { ok: false, error: "old_string is empty. To create or overwrite a file, use write_file." };
  if (oldString === newString) return { ok: false, error: "old_string and new_string are identical — nothing to change." };
  const n = countOccurrences(content, oldString);
  if (n === 0) {
    return {
      ok: false,
      error: "old_string was not found in the file. It must match exactly, including whitespace and indentation — read the file again and copy the text.",
    };
  }
  if (n > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${n} places. Include more surrounding lines so it matches exactly one, or set replace_all to change every one.`,
    };
  }
  const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
  return { ok: true, content: next, replacements: replaceAll ? n : 1 };
}

/** Convert a glob to an anchored RegExp over POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "");
  if (!g) g = "**";
  let re = "";
  let i = 0;
  let inBrace = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**/" matches zero or more directories; a bare "**" matches anything.
        if (g[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace++;
      re += "(?:";
    } else if (c === "}" && inBrace > 0) {
      inBrace--;
      re += ")";
    } else if (c === "," && inBrace > 0) re += "|";
    else if (c === "[") {
      const end = g.indexOf("]", i + 1);
      if (end === -1) re += "\\[";
      else {
        const body = g.slice(i + 1, end).replace(/\\/g, "\\\\");
        re += `[${body.startsWith("!") ? "^" + body.slice(1) : body}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\/]/g, "\\$&");
    i++;
  }
  // A pattern without a slash matches the basename at any depth (like rg -g).
  const anchored = g.includes("/") ? `^${re}$` : `^(?:.*/)?${re}$`;
  return new RegExp(anchored);
}

/** `cat -n` style view of lines [offset, offset+limit) (1-based offset). */
export function numberLines(text: string, offset = 1, limit = 2000, maxLineChars = 2000): { view: string; totalLines: number; shown: [number, number] } {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, Math.floor(offset));
  const end = Math.min(lines.length, start + Math.max(1, Math.floor(limit)) - 1);
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    let l = lines[n - 1] ?? "";
    if (l.length > maxLineChars) l = `${l.slice(0, maxLineChars)}… [line cut at ${maxLineChars} chars]`;
    out.push(`${String(n).padStart(width, " ")}\t${l}`);
  }
  return { view: out.join("\n"), totalLines: lines.length, shown: [start, end] };
}

export interface RepoProfile {
  testCommand: string | null;
  lintCommand: string | null;
  /** Where the answer came from (shown to the agent). */
  source: string;
}

/**
 * Work out the test command from the files at a checkout's root. A
 * `.shapes/profile.json` ({ "testCommand": …, "lintCommand": … }) wins —
 * that is the repo profile the GitHub work saves; otherwise conventions.
 */
export function detectRepoProfile(input: {
  files: readonly string[];
  profileJson?: string | null;
  packageJson?: string | null;
}): RepoProfile {
  if (input.profileJson) {
    try {
      const p = JSON.parse(input.profileJson) as { testCommand?: unknown; lintCommand?: unknown };
      if (typeof p.testCommand === "string" && p.testCommand.trim()) {
        return {
          testCommand: p.testCommand.trim(),
          lintCommand: typeof p.lintCommand === "string" && p.lintCommand.trim() ? p.lintCommand.trim() : null,
          source: ".shapes/profile.json",
        };
      }
    } catch {
      /* fall through to conventions */
    }
  }
  const has = (f: string) => input.files.includes(f);
  if (input.packageJson) {
    try {
      const pkg = JSON.parse(input.packageJson) as { scripts?: Record<string, string> };
      const s = pkg.scripts ?? {};
      const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
      const test = s.test && !/no test specified/.test(s.test) ? `${pm} test` : null;
      const lint = s.lint ? `${pm} run lint` : null;
      if (test || lint) return { testCommand: test, lintCommand: lint, source: "package.json scripts" };
    } catch {
      /* not JSON */
    }
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini")) {
    return { testCommand: "python3 -m pytest -q", lintCommand: null, source: "Python project files" };
  }
  if (has("go.mod")) return { testCommand: "go test ./...", lintCommand: "go vet ./...", source: "go.mod" };
  if (has("Cargo.toml")) return { testCommand: "cargo test", lintCommand: null, source: "Cargo.toml" };
  if (has("Makefile")) return { testCommand: "make test", lintCommand: null, source: "Makefile" };
  return { testCommand: null, lintCommand: null, source: "nothing recognised" };
}
