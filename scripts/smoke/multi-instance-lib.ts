// ShapesOS — Deploy PR (WS=state): the checks of the two-instance smoke
// (scripts/smoke/multi-instance.mts), kept free of process management so
// their logic is unit-tested against stub servers
// (scripts/smoke/__tests__/multi-instance-lib.test.ts).
//
// An "instance" is a base URL plus a way to send it a signal. The checks:
//   signIn()            Auth.js credentials sign-in → a JWT session cookie
//                       that every replica accepts (same AUTH_SECRET);
//   uploadOnAFetchOnB() a workspace file uploaded through A is downloaded
//                       through B, byte for byte;
//   siteOnAReadOnB()    a site working copy written through A is read through B;
//   sseDrainResume()    a chat stream open on A gets `event: reconnect` when A
//                       is SIGTERMed and resumes on B with Last-Event-ID —
//                       every text delta arrives exactly once, in order.

export interface Instance {
  name: string;
  base: string;
  /** Send a signal to the instance's process (SIGTERM for the drain). */
  signal(sig: NodeJS.Signals): void;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number | null>;
}

/** A tiny cookie jar (cookies are host-scoped, not port-scoped: one jar serves both replicas on localhost). */
export class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of all) {
      const [pair] = c.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(name: RegExp): boolean {
    return [...this.cookies.keys()].some((k) => name.test(k));
  }
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Auth.js credentials sign-in (csrf → callback) → session cookie in the jar. */
export async function signIn(base: string, jar: CookieJar, email: string, password: string): Promise<Check> {
  const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { cookie: jar.header() } });
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string };
  if (!csrfToken) return { name: "sign in", ok: false, detail: "no csrf token" };
  const res = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), origin: base },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${base}/dashboard` }).toString(),
  });
  jar.absorb(res);
  const ok = jar.has(/session-token/);
  return { name: "sign in on A (JWT session cookie)", ok, detail: ok ? undefined : `status ${res.status}` };
}

/** The session minted by A is accepted by B (shared AUTH_SECRET, stateless JWT). */
export async function sessionOn(inst: Instance, jar: CookieJar, email: string): Promise<Check> {
  const res = await fetch(`${inst.base}/api/auth/session`, { headers: { cookie: jar.header() } });
  const body = (await res.json().catch(() => null)) as { user?: { email?: string } } | null;
  const got = body?.user?.email?.toLowerCase() ?? null;
  return { name: `${inst.name} accepts the session cookie`, ok: res.ok && got === email.toLowerCase(), detail: `status ${res.status}, user ${got}` };
}

export async function uploadOnAFetchOnB(a: Instance, b: Instance, jar: CookieJar, workspaceId: string, bytes: Uint8Array): Promise<Check[]> {
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  form.set("path", "/files");
  form.set("file", new File([bytes], `smoke-${Date.now()}.txt`, { type: "text/plain" }));
  const up = await fetch(`${a.base}/api/files`, { method: "POST", body: form, headers: { cookie: jar.header(), origin: a.base } });
  const upBody = (await up.json().catch(() => ({}))) as { file?: { id?: string } };
  const id = upBody.file?.id;
  const checks: Check[] = [{ name: "upload a workspace file through A", ok: up.status === 201 && !!id, detail: `status ${up.status}` }];
  if (!id) return checks;
  const down = await fetch(`${b.base}/api/files/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`, {
    headers: { cookie: jar.header() },
  });
  const got = new Uint8Array(await down.arrayBuffer());
  checks.push({
    name: "download the same file through B (byte for byte)",
    ok: down.ok && got.length === bytes.length && got.every((v, i) => v === bytes[i]),
    detail: `status ${down.status}, ${got.length} bytes`,
  });
  return checks;
}

export async function siteOnAReadOnB(a: Instance, b: Instance, jar: CookieJar, projectId: string): Promise<Check[]> {
  const html = `<h1>multi-instance smoke ${Date.now()}</h1>`;
  const create = await fetch(`${a.base}/api/websites`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jar.header(), origin: a.base },
    body: JSON.stringify({ projectId, name: "Smoke site", sourceType: "file", initialFiles: [{ path: "/index.html", content: html }, { path: "/My Page.html", content: "spaces" }] }),
  });
  const site = ((await create.json().catch(() => ({}))) as { site?: { id?: string } }).site;
  const checks: Check[] = [{ name: "create a site working copy through A", ok: create.status === 201 && !!site?.id, detail: `status ${create.status}` }];
  if (!site?.id) return checks;
  for (const path of ["/index.html", "/My Page.html"]) {
    const read = await fetch(`${b.base}/api/websites/${site.id}/file?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`, {
      headers: { cookie: jar.header() },
    });
    const body = (await read.json().catch(() => ({}))) as { content?: string };
    checks.push({
      name: `read ${path} of that working copy through B`,
      ok: read.ok && body.content === (path === "/index.html" ? html : "spaces"),
      detail: `status ${read.status}`,
    });
  }
  return checks;
}

/** One SSE event block. */
export interface SseBlock {
  event: string | null;
  id: string | null;
  data: string;
}

/** Read SSE blocks from a fetch Response as they arrive. */
export async function* sseBlocks(res: Response): AsyncGenerator<SseBlock> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event: string | null = null;
      let id: string | null = null;
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, id, data: data.join("\n") };
    }
  }
}

function parseFrame(data: string): { type?: string; delta?: string } {
  try {
    return JSON.parse(data) as { type?: string; delta?: string };
  } catch {
    return {};
  }
}

export interface ChatTimeline {
  /** Append one text delta to the run (as the worker would). */
  push(text: string): Promise<void>;
  /** Finish the run (status + final assistant message). */
  finish(finalText: string): Promise<void>;
}

/**
 * The drain + resume check. A chat stream (GET /api/agents/chat/stream for a
 * running run) is opened on A; deltas are appended; A gets SIGTERM; the stream
 * must end with `event: reconnect`; the client resumes on B with the
 * Last-Event-ID it saw; more deltas are appended; the run finishes. Every
 * delta must arrive exactly once, in order, and A must exit within `graceMs`.
 */
export async function sseDrainResume(
  a: Instance,
  b: Instance,
  jar: CookieJar,
  stream: { runId: string; aguiRunId: string },
  timeline: ChatTimeline,
  opts: { graceMs: number; deltasBefore?: number; deltasAfter?: number },
): Promise<Check[]> {
  const before = opts.deltasBefore ?? 3;
  const after = opts.deltasAfter ?? 3;
  const sent: string[] = [];
  const received: string[] = [];
  let lastId: string | null = null;
  let reconnect: { runId?: string; after?: number; aguiRunId?: string } | null = null;
  const url = (inst: Instance) =>
    `${inst.base}/api/agents/chat/stream?runId=${encodeURIComponent(stream.runId)}&aguiRunId=${encodeURIComponent(stream.aguiRunId)}`;
  const checks: Check[] = [];

  const resA = await fetch(url(a), { headers: { cookie: jar.header(), accept: "text/event-stream" } });
  checks.push({ name: "open the chat stream on A", ok: resA.ok && (resA.headers.get("content-type") ?? "").includes("text/event-stream"), detail: `status ${resA.status}` });
  if (!resA.ok) return checks;
  const iterA = sseBlocks(resA);
  for (let i = 0; i < before; i++) {
    const t = `a${i} `;
    sent.push(t);
    await timeline.push(t);
  }
  // Read A until it has delivered the first deltas, then SIGTERM it.
  let killedAt = 0;
  const deadlineA = Date.now() + 30_000;
  try {
    for await (const blk of iterA) {
      if (Date.now() > deadlineA) break;
      if (blk.event === "reconnect") {
        try {
          reconnect = JSON.parse(blk.data);
        } catch {
          reconnect = {};
        }
        break;
      }
      if (blk.id) lastId = blk.id;
      const frame = parseFrame(blk.data);
      if (frame.type === "TEXT_MESSAGE_CONTENT" && frame.delta) received.push(frame.delta);
      if (!killedAt && received.length >= before) {
        killedAt = Date.now();
        a.signal("SIGTERM");
      }
    }
  } catch {
    // A cut the connection — the reconnect check below reports it.
  }
  checks.push({ name: "A sends `event: reconnect` on SIGTERM", ok: !!reconnect, detail: reconnect ? JSON.stringify(reconnect) : "stream ended without it" });
  checks.push({ name: "events carry the run cursor as their id", ok: !!lastId && lastId.startsWith(`${stream.runId}:`), detail: String(lastId) });

  // Resume on B from the cursor (the client sends Last-Event-ID).
  for (let i = 0; i < after; i++) {
    const t = `b${i} `;
    sent.push(t);
    await timeline.push(t);
  }
  const resumeId = reconnect?.runId && typeof reconnect.after === "number" ? `${reconnect.runId}:${reconnect.after}` : lastId;
  const resB = await fetch(url(b), { headers: { cookie: jar.header(), accept: "text/event-stream", ...(resumeId ? { "last-event-id": resumeId } : {}) } });
  checks.push({ name: "resume the stream on B with Last-Event-ID", ok: resB.ok, detail: `status ${resB.status}, Last-Event-ID ${resumeId}` });
  if (!resB.ok) return checks;
  let finished = false;
  let finishing = false;
  const deadlineB = Date.now() + 30_000;
  try {
    for await (const blk of sseBlocks(resB)) {
      if (Date.now() > deadlineB) break;
      if (blk.event) continue;
      const frame = parseFrame(blk.data);
      if (frame.type === "TEXT_MESSAGE_CONTENT" && frame.delta) received.push(frame.delta);
      if (!finishing && received.length >= sent.length) {
        finishing = true;
        await timeline.finish(sent.join(""));
      }
      if (frame.type === "RUN_FINISHED") {
        finished = true;
        break;
      }
    }
  } catch {
    // B cut the connection — the finish check below reports it.
  }
  // The final reconcile may append the delivered text as its own message:
  // compare only the streamed deltas.
  const streamed = received.slice(0, sent.length);
  checks.push({ name: "the turn finishes on B (RUN_FINISHED)", ok: finished });
  checks.push({
    name: "every delta exactly once, in order, across the restart",
    ok: JSON.stringify(streamed) === JSON.stringify(sent),
    detail: `sent ${JSON.stringify(sent)} got ${JSON.stringify(received)}`,
  });
  const code = await Promise.race([a.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), opts.graceMs + 5_000))]);
  checks.push({
    name: `A exits within the grace period after SIGTERM`,
    ok: code !== "timeout",
    detail: code === "timeout" ? "still running" : `exit ${code} after ${Date.now() - killedAt} ms`,
  });
  return checks;
}
