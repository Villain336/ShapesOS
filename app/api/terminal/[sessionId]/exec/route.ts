// ShapesOS — Phase 18.2 (WS=content): run one command in the person's terminal.
// POST /api/terminal/[sessionId]/exec { command, cwd? } → application/x-ndjson
//   {"type":"out","stream":"stdout"|"stderr","data":"…"}   as it arrives
//   {"type":"exit","exitCode":0,"timedOut":false,"truncated":false,"durationMs":12,"cwd":"/…"}
//   {"type":"error","error":"…"}                           the command could not run
// editor+ (requireWorkspaceRole) and only the person's OWN session (no one
// else — no admin, no agent — can type into it). A person's command is not
// an agent action, so there is no tier prompt; every command is recorded
// (terminal_commands: command, exit code, duration — never the output). The
// sandbox's limits apply (CPU / memory / pids / egress; 2 min per command,
// 256 KB of output). Closing the request stops the command.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { ConflictError, ForbiddenError, NotFoundError, errorResponse } from "@/lib/api/errors";
import { checkCommand, getTerminalSession, runTerminalCommand } from "@/lib/terminal/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

const Body = z.object({ command: z.string(), cwd: z.string().max(1024).optional() });

export async function POST(req: Request, ctx: Ctx) {
  let actor: { workspaceId: string; userId: string; role: Parameters<typeof runTerminalCommand>[0]["role"] };
  let body: z.infer<typeof Body>;
  let sessionId: string;
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    sessionId = (await ctx.params).sessionId;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    actor = { workspaceId: workspace.id, userId: user.id, role: m.role };
    body = Body.parse(await req.json().catch(() => null));
    checkCommand(body.command);
    // Refuse with the right status before streaming (runTerminalCommand re-checks).
    const s = await getTerminalSession(workspace.id, sessionId);
    if (!s) throw new NotFoundError("Terminal session not found.");
    if (s.userId !== user.id) throw new ForbiddenError("This terminal belongs to someone else.");
    if (s.status !== "active") throw new ConflictError("This terminal session has ended. Open a new one.");
  } catch (err) {
    return errorResponse(err, "POST /api/terminal/[sessionId]/exec");
  }
  const enc = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          // the client went away
        }
      };
      try {
        const res = await runTerminalCommand(actor, sessionId, body, (c) => send({ type: "out", stream: c.stream, data: c.data }), abort.signal);
        send({ type: "exit", ...res });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
