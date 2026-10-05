// ShapesOS — Phase 8 (ship): git inside a run's sandbox (PURE helpers).
//
// Everything here builds argument arrays or checks values; nothing runs.
// The tools in ./tools.ts execute them through the Sandbox interface.
//
// Credentials: a repository token is NEVER put in a command line, a remote
// URL, a file, a log line or a run event. Clone and push run with
//   -c credential.helper=            (drop any helper the repo configured)
//   -c credential.helper=!<inline>   (answers only for https://github.com,
//                                     reading the token from an env var)
//   -c core.hooksPath=/dev/null      (no repo hook sees that env var)
// and the token lives only in that one process's environment
// (SHAPES_GIT_TOKEN). Output is scrubbed of the token before it is returned.
//
// Push safety: the branch is always shapes/<runId> (from the run's ship
// state, never from the model), pushed as HEAD:refs/heads/<branch> to the
// repository's own URL, never --force, never the default branch.

export const GIT_TOKEN_ENV = "SHAPES_GIT_TOKEN";
export const SHIP_BRANCH_PREFIX = "shapes/";
export const GIT_AUTHOR = { name: "ShapesOS agent", email: "agent@shapesos.invalid" } as const;
/** Patches kept on a run event are capped (the review page shows a note). */
export const MAX_PATCH_BYTES = 200 * 1024;

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** "owner/name" → parts (".git" suffix and a github.com URL are accepted). */
export function parseRepoFullName(raw: unknown): { owner: string; repo: string; fullName: string } {
  if (typeof raw !== "string") throw new Error('Name the repository as "owner/name".');
  let s = raw.trim().replace(/\.git$/, "");
  const url = s.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/);
  if (url) s = url[1]!;
  const m = s.match(REPO_RE);
  if (!m || m[2] === "." || m[2] === "..") throw new Error(`"${String(raw).slice(0, 80)}" is not a GitHub repository ("owner/name").`);
  return { owner: m[1]!, repo: m[2]!, fullName: `${m[1]}/${m[2]}` };
}

/** The only branch a run may push: shapes/<runId>. */
export function shipBranchName(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw new Error("A run id is needed to name the branch.");
  return `${SHIP_BRANCH_PREFIX}${runId}`;
}

export function isShipBranch(name: string): boolean {
  return /^shapes\/[A-Za-z0-9_-]{1,64}$/.test(name);
}

/** The public https remote of a GitHub repository (no credentials, ever). */
export function repoRemoteUrl(fullName: string): string {
  const { fullName: clean } = parseRepoFullName(fullName);
  return `https://github.com/${clean}.git`;
}

/**
 * Inline credential helper: answers only a `get` for https://github.com and
 * reads the token from the environment, so it never appears in argv.
 */
export const CREDENTIAL_HELPER =
  `!f() { test "$1" = get || exit 0; h=; p=; ` +
  `while IFS= read -r l; do case "$l" in host=github.com) h=1;; protocol=https) p=1;; esac; done; ` +
  `if [ -n "$h" ] && [ -n "$p" ]; then echo username=x-access-token; echo "password=$${GIT_TOKEN_ENV}"; fi; }; f`;

/** -c options every authenticated git command runs with. */
export function authGitConfigArgs(): string[] {
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${CREDENTIAL_HELPER}`,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
  ];
}

/** Env for an authenticated git command (the only place the token goes). */
export function authGitEnv(token: string): Record<string, string> {
  return { [GIT_TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GCM_INTERACTIVE: "never" };
}

export function cloneArgs(fullName: string, baseBranch: string, dir: string): string[] {
  return ["git", ...authGitConfigArgs(), "clone", "--no-tags", "--branch", baseBranch, "--", repoRemoteUrl(fullName), dir];
}

export interface PushRequest {
  /** The branch from the run's ship state. */
  branch: string;
  defaultBranch: string;
  baseBranch: string;
  /** What the model passed (refused unless it only names the run's branch). */
  args: Record<string, unknown>;
}

/**
 * Refuse anything but a plain push of HEAD to shapes/<runId>.
 * Throws with a message the agent can act on.
 */
export function assertPushAllowed(req: PushRequest): void {
  const a = req.args ?? {};
  const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1" || v === "yes";
  if (truthy(a.force) || truthy(a.force_with_lease) || truthy(a.forceWithLease) || truthy(a.f)) {
    throw new Error("Force-pushing is never allowed. Push your commits as they are.");
  }
  for (const key of ["ref", "branch", "refspec", "target", "to", "remote_branch"]) {
    const v = a[key];
    if (v === undefined || v === null || v === "") continue;
    const s = String(v).replace(/^refs\/heads\//, "");
    if (s !== req.branch) {
      throw new Error(`This run can only push to ${req.branch}; it never pushes to ${s.slice(0, 80)}.`);
    }
  }
  if (a.remote !== undefined && a.remote !== null && a.remote !== "" && a.remote !== "origin") {
    throw new Error("This run only pushes to the repository it cloned.");
  }
  if (!isShipBranch(req.branch)) throw new Error(`Refusing to push to ${req.branch}: runs only push shapes/<run id> branches.`);
  if (req.branch === req.defaultBranch || req.branch === req.baseBranch) {
    throw new Error("Refusing to push to the default branch.");
  }
}

export function pushArgs(fullName: string, branch: string): string[] {
  if (!isShipBranch(branch)) throw new Error(`Refusing to push to ${branch}.`);
  // No --force, no "+" on the refspec: a rejected non-fast-forward stays rejected.
  return ["git", ...authGitConfigArgs(), "push", "--porcelain", "--", repoRemoteUrl(fullName), `HEAD:refs/heads/${branch}`];
}

const GH_TOKEN_RE = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g;

/** Remove known secrets (exact values) and anything shaped like a GitHub token. */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out.replace(GH_TOKEN_RE, "[redacted]");
}

export interface NumstatEntry {
  path: string;
  additions: number | null;
  deletions: number | null;
}

/** Parse `git diff --numstat` ("-" counts = binary). */
export function parseNumstat(out: string): NumstatEntry[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...rest] = l.split("\t");
      return {
        path: rest.join("\t"),
        additions: a === "-" ? null : Number(a),
        deletions: d === "-" ? null : Number(d),
      };
    })
    .filter((e) => e.path);
}

export interface PorcelainStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  files: { path: string; index: string; worktree: string }[];
}

/** Parse `git status --porcelain=v1 -b`. */
export function parsePorcelainStatus(out: string): PorcelainStatus {
  const res: PorcelainStatus = { branch: null, ahead: 0, behind: 0, files: [] };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const head = line.slice(3);
      const m = head.match(/^(.+?)(?:\.\.\.\S+)?(?: \[(.+)\])?$/);
      res.branch = m?.[1] && !m[1].startsWith("No commits yet") ? m[1] : (head.match(/on (\S+)$/)?.[1] ?? null);
      const ahead = head.match(/ahead (\d+)/);
      const behind = head.match(/behind (\d+)/);
      res.ahead = ahead ? Number(ahead[1]) : 0;
      res.behind = behind ? Number(behind[1]) : 0;
      continue;
    }
    res.files.push({ index: line[0] ?? " ", worktree: line[1] ?? " ", path: line.slice(3) });
  }
  return res;
}

/** Cap a patch for storage on a run event (UTF-8 safe at a line boundary). */
export function capPatch(patch: string, max = MAX_PATCH_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= max) return { patch, truncated: false };
  let cut = Buffer.from(patch, "utf8").subarray(0, max).toString("utf8");
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { patch: cut, truncated: true };
}
