// ShapesOS — share_preview code tool (in-product browser "Dev preview" v1):
// copies the run sandbox's workdir into the project's PERSISTENT dev
// sandbox, starts the dev server there, and returns the in-product browser
// tab link (/dashboard/browser opens it). Unlike a run preview, the dev
// sandbox survives this run - the dev server keeps serving after the run
// ends, pauses itself when quiet, and wakes only from the person's explicit
// Resume in the browser panel.
//
// This SPENDS (a second sandbox), so it fails closed unless the dev-preview
// spend gate allows it (owner-approved production spend or a bounded
// authorized test window - the feature flag alone never starts compute).

import type { ToolContext, ToolDef, ToolResult } from "@/lib/chat/tools";
import { sandboxForRun, SandboxUnavailableError } from "./index";
import { isValidPreviewPort } from "./preview";
import { devPreviewPath } from "./dev-preview-proxy";
import { devSandboxSpendAllowed, ensureDevSandbox, touchDevSandboxPorts, getDevSandboxRow } from "./dev-sandbox";
import type { Sandbox } from "./types";

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

type DevFramework = "vite" | "astro" | "next" | "unknown";

/**
 * Detect the dev command AND the framework from package.json in the synced
 * dir. The framework decides how (or whether) the preview base path can be
 * applied - per-framework, never a blind flag on arbitrary commands:
 * vite/astro accept --base on the CLI (forwarded through npm scripts);
 * next only honors basePath from next.config (v1 does not rewrite project
 * config); anything else gets no injection - relative-URL apps still work
 * through the proxy's root fallback, root-absolute apps need their own base.
 */
async function detectDevServer(sb: Sandbox, dir: string): Promise<{ command: string | null; framework: DevFramework }> {
  const r = await sb.exec(`cat "${dir}/package.json"`, { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.exitCode !== 0) return { command: null, framework: "unknown" };
  try {
    const pkg = JSON.parse(r.stdout) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scriptText = Object.values(pkg.scripts ?? {}).join(" ");
    let framework: DevFramework = "unknown";
    if (deps.vite || /\bvite\b/.test(scriptText)) framework = "vite";
    else if (deps.astro || /\bastro\b/.test(scriptText)) framework = "astro";
    else if (deps.next || /\bnext\b/.test(scriptText)) framework = "next";
    const command = pkg.scripts?.dev ? "npm run dev" : pkg.scripts?.start ? "npm start" : null;
    return { command, framework };
  } catch { /* fall through */ }
  return { command: null, framework: "unknown" };
}

/** Apply the preview base to the start command where the framework supports it. */
function withBase(command: string, framework: DevFramework, base: string): { command: string; baseHandling: "cli-flag" | "needs-next-config" | "none" } {
  if (framework === "vite" || framework === "astro") {
    if (command.startsWith("npm run ") || command.startsWith("npm start")) {
      return { command: `${command} -- --base=${base}`, baseHandling: "cli-flag" };
    }
    if (/\b(vite|astro)\b/.test(command)) return { command: `${command} --base=${base}`, baseHandling: "cli-flag" };
  }
  if (framework === "next") return { command, baseHandling: "needs-next-config" };
  return { command, baseHandling: "none" };
}

export const share_preview: ToolDef = {
  name: "share_preview",
  description:
    "Host what you built in the person's in-product browser: copy this sandbox's workdir into the project's persistent dev sandbox, start its dev server there on a port, and return the browser tab link. The server keeps running after this run ends and pauses itself when quiet. Use when the person wants to keep using the app, not just preview it during the run.",
  kind: "spend",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "The port the dev server should listen on (e.g. 3000, 5173)." },
      command: { type: "string", description: "Dev server command (default: the package.json dev/start script)." },
      dir: { type: "string", description: "App directory relative to the workdir (default: the workdir root)." },
    },
    required: ["port"],
  },
  execute: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const port = num(args.port);
    if (!port || !isValidPreviewPort(port)) return { summary: "share_preview needs a valid port.", details: { error: "port" } };

    const spend = devSandboxSpendAllowed();
    if (!spend.allowed || !spend.bounds) {
      return { summary: spend.reason ?? "Dev previews that keep running aren't enabled for this workspace yet.", details: { unavailable: true, reason: "spend-gate" } };
    }

    const ensured = await ensureDevSandbox(ctx.workspaceId, ctx.projectId, { bounds: spend.bounds });
    if (!ensured.ok) return { summary: ensured.reason, details: { unavailable: true, reason: ensured.reason } };
    const dev = ensured.sandbox;

/** Single-quote a path for the sandbox shell (no expansion possible). */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    // 1. Sync the workdir: tarball out of the run sandbox, into the dev one.
    let runSb: Sandbox;
    try {
      runSb = await sandboxForRun(ctx as Parameters<typeof sandboxForRun>[0]);
    } catch (err) {
      if (err instanceof SandboxUnavailableError) return { summary: err.message, details: { unavailable: true, reason: err.reason } };
      throw err;
    }
    const src = str(args.dir) ?? ".";
    const srcDir = src === "." ? runSb.workdir : `${runSb.workdir}/${src}`;
    const pack = await runSb.exec(`tar czf /tmp/share-preview.tgz -C ${shq(srcDir)} .`, { timeoutMs: 120_000 });
    if (pack.exitCode !== 0) return { summary: `share_preview: couldn't package the workdir: ${pack.stderr.slice(0, 300)}`, details: { error: "pack" } };
    const tarball = await runSb.readFile("/tmp/share-preview.tgz");
    const dest = `${dev.workdir}/app`;
    await dev.exec(`mkdir -p ${shq(dest)}`, { timeoutMs: 10_000 });
    await dev.writeFile("/tmp/share-preview.tgz", tarball);
    const unpack = await dev.exec(`tar xzf /tmp/share-preview.tgz -C ${shq(dest)} && rm /tmp/share-preview.tgz`, { timeoutMs: 120_000 });
    if (unpack.exitCode !== 0) return { summary: `share_preview: couldn't unpack into the dev sandbox: ${unpack.stderr.slice(0, 300)}`, details: { error: "unpack" } };

    // 2. Install + start the dev server, detached, with the preview base path.
    const detected = await detectDevServer(dev, dest);
    const explicit = str(args.command);
    const framework: DevFramework = explicit
      ? /\bvite\b/.test(explicit) ? "vite" : /\bastro\b/.test(explicit) ? "astro" : "unknown"
      : detected.framework;
    const rawCommand = explicit ?? detected.command;
    if (!rawCommand) return { summary: `share_preview: no package.json dev/start script found; pass the command explicitly.`, details: { error: "command" } };
    const base = devPreviewPath(ctx.projectId, port);
    const { command, baseHandling } = withBase(rawCommand, framework, base);
    const install = await dev.exec("test -d node_modules || npm install --no-audit --no-fund", { timeoutMs: 300_000 });
    if (install.exitCode !== 0) return { summary: `share_preview: install failed: ${install.stderr.slice(-300)}`, details: { error: "install" } };
    await dev.exec(
      `cd "${dest}" && (fuser -k ${port}/tcp 2>/dev/null || true) && nohup env PORT=${port} HOSTNAME=0.0.0.0 BASE_PATH=${base} sh -lc 'exec ${command}' > /tmp/share-preview-${port}.log 2>&1 &`,
      { timeoutMs: 10_000 },
    );
    // 3. Confirm it answered; surface the log tail when it didn't.
    let up = false;
    for (let i = 0; i < 10 && !up; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const probe = await dev.exec(`curl -sf -o /dev/null http://127.0.0.1:${port}/ || curl -sf -o /dev/null http://127.0.0.1:${port}${base}`, { timeoutMs: 10_000 }).catch(() => null);
      up = !!probe && probe.exitCode === 0;
    }
    if (!up) {
      const log = await dev.exec(`tail -c 800 /tmp/share-preview-${port}.log`, { timeoutMs: 10_000 }).catch(() => null);
      return { summary: `share_preview: the dev server didn't come up on port ${port}.${log?.stdout ? `\nlog: ${log.stdout}` : ""}`, details: { error: "start" } };
    }

    // 4. Expose + record the port, and hand back the browser tab link.
    await dev.exposePort(port);
    const row = await getDevSandboxRow(ctx.workspaceId, ctx.projectId);
    await touchDevSandboxPorts(ctx.workspaceId, ctx.projectId, [...new Set([...(row?.exposedPorts ?? []), port])]);
    const baseNote =
      baseHandling === "cli-flag"
        ? ""
        : baseHandling === "needs-next-config"
          ? "\nHeads-up: this is a Next.js app - set basePath to " + base + " in next.config or its assets won't load through the preview (v1 doesn't rewrite project config)."
          : "\nHeads-up: the dev server wasn't given the preview base path; apps with root-absolute asset URLs won't load assets through the preview (relative URLs work).";
    return {
      summary: `Hosted in the browser: open Browser (dashboard) → the tab for port ${port}, or ${base}\nIt keeps running after this run; it pauses itself when quiet and wakes from Resume in the panel.${baseNote}`,
      details: { url: base, port, projectId: ctx.projectId, framework, baseHandling },
    };
  },
};
