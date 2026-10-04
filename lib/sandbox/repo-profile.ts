// ShapesOS — Phase 8 (ship): repository profile.
//
// On the first clone of a repository into a run's sandbox, git_clone detects
// the stack — the package manager from lockfiles, and the install / test /
// lint / build / typecheck commands from package.json scripts, pyproject /
// pytest config, a Makefile, go.mod, Cargo.toml and similar — and stores it
// per repository per workspace (repo_profiles, FORCE RLS). Later runs reuse
// it; the sandbox workstream's run_tests reads it through getRepoProfile().
//
// detectRepoProfile() is PURE (file names + a reader in, profile out) so the
// fixtures in the unit suite cover every rule without a sandbox. Detection
// only reads top-level files; it never runs anything.

import { posix as path } from "node:path";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Sandbox } from "./types";

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "uv"
  | "pipenv"
  | "go"
  | "cargo"
  | "bundler"
  | "maven"
  | "gradle";

export interface RepoCommands {
  install?: string;
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
}

export interface DetectedRepoProfile {
  packageManager: PackageManager | null;
  language: string | null;
  commands: RepoCommands;
  /** Files the detection read or keyed on. */
  detectedFrom: string[];
}

export interface RepoProfile extends DetectedRepoProfile {
  workspaceId: string;
  repoFullName: string;
  updatedAt: Date;
}

/** Files detection may read (all top-level). */
export const PROFILE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "package-lock.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "setup.py",
  "ruff.toml",
  ".flake8",
  "Makefile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gradlew",
] as const;

const NPM_DEFAULT_TEST = /no test specified/;

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Make targets declared at the start of a line ("test:", "lint: deps"). */
export function makeTargets(makefile: string): Set<string> {
  const out = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (m) out.add(m[1]!);
  }
  return out;
}

function jsRun(pm: PackageManager, script: string): string {
  if (pm === "npm") return script === "test" ? "npm test" : `npm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `pnpm ${script === "test" ? "test" : `run ${script}`}`;
}

/**
 * Detect a repository's stack from its top-level files. PURE.
 * `files` = top-level entry names; `read(name)` returns a file's text or null.
 */
export function detectRepoProfile(files: readonly string[], read: (name: string) => string | null): DetectedRepoProfile {
  const has = new Set(files);
  const used = new Set<string>();
  const get = (name: string): string | null => {
    if (!has.has(name)) return null;
    const t = read(name);
    if (t !== null) used.add(name);
    return t;
  };
  const mark = (name: string) => {
    if (has.has(name)) used.add(name);
    return has.has(name);
  };
  const commands: RepoCommands = {};
  let packageManager: PackageManager | null = null;
  let language: string | null = null;

  // ---- JavaScript / TypeScript ----
  const pkg = parseJson(get("package.json"));
  if (pkg) {
    const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
    if (declared === "pnpm" || declared === "yarn" || declared === "npm" || declared === "bun") packageManager = declared;
    else if (mark("pnpm-lock.yaml")) packageManager = "pnpm";
    else if (mark("yarn.lock")) packageManager = "yarn";
    else if (mark("bun.lockb") || mark("bun.lock")) packageManager = "bun";
    else packageManager = "npm";
    const hasNpmLock = mark("package-lock.json");
    language = mark("tsconfig.json") ? "typescript" : "javascript";
    commands.install =
      packageManager === "npm"
        ? hasNpmLock
          ? "npm ci"
          : "npm install"
        : packageManager === "pnpm"
          ? "pnpm install --frozen-lockfile"
          : packageManager === "yarn"
            ? "yarn install --frozen-lockfile"
            : "bun install";
    const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
    const script = (name: string) => typeof scripts[name] === "string" && (scripts[name] as string).trim() !== "";
    if (script("test") && !NPM_DEFAULT_TEST.test(String(scripts.test))) commands.test = jsRun(packageManager, "test");
    if (script("lint")) commands.lint = jsRun(packageManager, "lint");
    if (script("build")) commands.build = jsRun(packageManager, "build");
    for (const name of ["typecheck", "type-check", "check-types", "tsc"]) {
      if (script(name)) {
        commands.typecheck = jsRun(packageManager, name);
        break;
      }
    }
  }

  // ---- Python ----
  const pyproject = get("pyproject.toml");
  const isPython = pyproject !== null || has.has("requirements.txt") || has.has("setup.py") || has.has("Pipfile");
  if (isPython && !pkg) {
    language = "python";
    let prefix = "";
    if (mark("uv.lock")) {
      packageManager = "uv";
      prefix = "uv run ";
      commands.install = "uv sync";
    } else if (mark("poetry.lock") || /\[tool\.poetry\]/.test(pyproject ?? "")) {
      packageManager = "poetry";
      prefix = "poetry run ";
      commands.install = "poetry install";
    } else if (mark("Pipfile")) {
      packageManager = "pipenv";
      prefix = "pipenv run ";
      commands.install = "pipenv install --dev";
    } else {
      packageManager = "pip";
      prefix = "python -m ";
      commands.install = mark("requirements.txt")
        ? `pip install -r requirements.txt${mark("requirements-dev.txt") ? " -r requirements-dev.txt" : ""}`
        : "pip install -e .";
    }
    const pytestCfg =
      /\[tool\.pytest/.test(pyproject ?? "") ||
      /\bpytest\b/.test(pyproject ?? "") ||
      mark("pytest.ini") ||
      /\[pytest\]|\[tool:pytest\]/.test(get("tox.ini") ?? "") ||
      /\[tool:pytest\]/.test(get("setup.cfg") ?? "") ||
      /\bpytest\b/.test(get("requirements-dev.txt") ?? "") ||
      /\bpytest\b/.test(get("requirements.txt") ?? "");
    if (pytestCfg) commands.test = `${prefix}pytest`;
    if (/\[tool\.ruff/.test(pyproject ?? "") || mark("ruff.toml")) commands.lint = `${prefix}ruff check .`;
    else if (mark(".flake8")) commands.lint = `${prefix}flake8`;
    if (/\[tool\.mypy/.test(pyproject ?? "")) commands.typecheck = `${prefix}mypy .`;
  }

  // ---- Go / Rust / Ruby / JVM ----
  if (!packageManager && mark("go.mod")) {
    packageManager = "go";
    language = "go";
    commands.install = "go mod download";
    commands.test = "go test ./...";
    commands.build = "go build ./...";
    commands.lint = "go vet ./...";
  }
  if (!packageManager && mark("Cargo.toml")) {
    packageManager = "cargo";
    language = "rust";
    commands.install = "cargo fetch";
    commands.test = "cargo test";
    commands.build = "cargo build";
    commands.lint = "cargo clippy -- -D warnings";
  }
  if (!packageManager && mark("Gemfile")) {
    packageManager = "bundler";
    language = "ruby";
    commands.install = "bundle install";
    commands.test = files.includes("spec") ? "bundle exec rspec" : "bundle exec rake test";
  }
  if (!packageManager && mark("pom.xml")) {
    packageManager = "maven";
    language = "java";
    commands.test = "mvn -B test";
    commands.build = "mvn -B package -DskipTests";
  }
  if (!packageManager && (mark("build.gradle") || mark("build.gradle.kts"))) {
    packageManager = "gradle";
    language = "java";
    const g = mark("gradlew") ? "./gradlew" : "gradle";
    commands.test = `${g} test`;
    commands.build = `${g} build -x test`;
  }

  // ---- Makefile fills the gaps (never overrides a script) ----
  const makefile = get("Makefile");
  if (makefile) {
    const targets = makeTargets(makefile);
    for (const t of ["test", "lint", "build", "typecheck", "install"] as const) {
      if (!commands[t] && targets.has(t)) commands[t] = `make ${t}`;
    }
  }

  return { packageManager, language, commands, detectedFrom: [...used].sort() };
}

const MAX_PROFILE_FILE_BYTES = 256 * 1024;

/** Detect inside a sandbox: list the repo root, read only the files that matter. */
export async function detectRepoProfileInSandbox(sandbox: Sandbox, repoDir: string): Promise<DetectedRepoProfile> {
  const entries = await sandbox.listFiles(repoDir, { recursive: false, maxEntries: 500 });
  const names = entries.map((e) => e.path.replace(/\/$/, ""));
  const wanted = new Set<string>(PROFILE_FILES);
  const texts = new Map<string, string>();
  for (const e of entries) {
    const name = e.path.replace(/\/$/, "");
    if (e.type !== "file" || !wanted.has(name) || name === "bun.lockb" || name === "gradlew") continue;
    if ((e.size ?? 0) > MAX_PROFILE_FILE_BYTES) continue;
    try {
      const buf = await sandbox.readFile(path.join(repoDir, name));
      texts.set(name, buf.subarray(0, MAX_PROFILE_FILE_BYTES).toString("utf8"));
    } catch {
      // Unreadable: treated as absent content (the name still counts).
    }
  }
  // Lockfiles / wrappers count by presence only (mark()), so they are never read.
  return detectRepoProfile(names, (n) => texts.get(n) ?? null);
}

export function normalizeRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

function toProfile(row: {
  workspaceId: string;
  repoFullName: string;
  packageManager: string | null;
  language: string | null;
  commands: Prisma.JsonValue;
  detectedFrom: string[];
  updatedAt: Date;
}): RepoProfile {
  const raw = (row.commands && typeof row.commands === "object" && !Array.isArray(row.commands) ? row.commands : {}) as Record<string, unknown>;
  const commands: RepoCommands = {};
  for (const k of ["install", "test", "lint", "build", "typecheck"] as const) {
    if (typeof raw[k] === "string" && (raw[k] as string).trim()) commands[k] = raw[k] as string;
  }
  return {
    workspaceId: row.workspaceId,
    repoFullName: row.repoFullName,
    packageManager: (row.packageManager as PackageManager | null) ?? null,
    language: row.language,
    commands,
    detectedFrom: row.detectedFrom,
    updatedAt: row.updatedAt,
  };
}

/** The stored profile of a repository in a workspace (null until first clone). */
export async function getRepoProfile(workspaceId: string, repoFullName: string): Promise<RepoProfile | null> {
  const key = normalizeRepoFullName(repoFullName);
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.repoProfile.findFirst({ where: { workspaceId, repoFullName: key } }),
  );
  return row ? toProfile(row) : null;
}

/** Store (or refresh) a repository's profile. */
export async function saveRepoProfile(
  workspaceId: string,
  repoFullName: string,
  profile: DetectedRepoProfile,
): Promise<RepoProfile> {
  const key = normalizeRepoFullName(repoFullName);
  const data = {
    packageManager: profile.packageManager,
    language: profile.language,
    commands: profile.commands as Prisma.InputJsonValue,
    detectedFrom: profile.detectedFrom,
  };
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.repoProfile.upsert({
      where: { workspaceId_repoFullName: { workspaceId, repoFullName: key } },
      create: { workspaceId, repoFullName: key, ...data },
      update: data,
    }),
  );
  return toProfile(row);
}
