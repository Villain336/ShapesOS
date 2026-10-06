// ShapesOS — test helper (NOT a test file): a scripted FAKE of the Anthropic
// Messages API (POST /v1/messages, JSON or SSE; POST /v1/messages/batches +
// retrieve + results). MOCK — no model is called; every reply comes from the
// test's script. Phase 17 (WS=model).
//
// Pointing the router at it: ANTHROPIC_API_KEY=test + ANTHROPIC_BASE_URL (the
// SDK's documented env override, client.d.ts "Defaults to
// process.env['ANTHROPIC_BASE_URL']"), with every OpenAI key removed so no
// failover is armed. The REAL adapter (lib/llm/anthropic.ts), loop, gates,
// run service and chat turn run unchanged against it — which is what the
// prompt-cache probe (scripts/verify/prompt-cache.mts), the eval harness
// dry-run (scripts/eval) and the batch tests need.
//
// Every request body is recorded with its `anthropic-beta` header, so a test
// can assert the exact bytes the chat loop sends.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface AnthropicBody {
  model?: string;
  system?: string | Array<Record<string, unknown>>;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<Record<string, unknown>>;
  stream?: boolean;
  cache_control?: unknown;
  service_tier?: string;
  context_management?: unknown;
  betas?: string[];
  [k: string]: unknown;
}

export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  service_tier?: "standard" | "priority" | "batch";
}

export interface FakeReply {
  text?: string;
  calls?: Array<{ name: string; input?: Record<string, unknown> }>;
  usage?: FakeUsage;
  /** Keep the request in flight until this settles. */
  hold?: Promise<void>;
  /** Answer with this HTTP status + error body instead (e.g. 429 / 529). */
  error?: { status: number; type: string; message: string };
}

export type FakeAnthropicScript = (body: AnthropicBody, req: RecordedAnthropicRequest) => FakeReply | Promise<FakeReply>;

export interface RecordedAnthropicRequest {
  seq: number;
  path: string;
  body: AnthropicBody;
  /** The anthropic-beta header (comma-separated), "" when absent. */
  betas: string;
  startedAt: number;
  endedAt: number | null;
  aborted: boolean;
}

export interface FakeBatch {
  id: string;
  requests: Array<{ custom_id: string; params: AnthropicBody }>;
  /** retrieve() calls so far; the batch ends after `endsAfterPolls`. */
  polls: number;
  createdAt: number;
}

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_MODEL_COPY",
  "LLM_MODEL_BULK",
  "LLM_MODEL_BACKGROUND",
  "LLM_MODEL_LEAD",
  "LLM_MODEL_SUBAGENT",
  "LLM_MODEL_CODE",
  "LLM_MODEL_CODE_MAX",
  "LLM_SELF_HOST",
  "LLM_FAILOVER",
  "LLM_ALLOW_RETENTION_MODELS",
  "AGENT_WORKER",
  "AGENT_MAX_STEPS",
  "AGENT_MAX_RUN_COST_MICRO_USD",
  "AGENT_MAX_RUN_MINUTES",
];

export interface FakeAnthropic {
  script: FakeAnthropicScript;
  requests: RecordedAnthropicRequest[];
  batches: Map<string, FakeBatch>;
  /** How many retrieve() polls before a batch reports processing_status "ended" (default 2). */
  batchEndsAfterPolls: number;
  baseUrl: string;
  close(): Promise<void>;
}

let seq = 0;
let msgSeq = 0;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
}

/** Everything the model was sent as plain text (system + messages), for matching. */
export function allText(body: AnthropicBody): string {
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => String(b.text ?? "")).join("\n");
  return `${system}\n${body.messages.map((m) => textOfContent(m.content)).join("\n")}`;
}

/** The system prompt as one string. */
export function systemText(body: AnthropicBody): string {
  return typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => String(b.text ?? "")).join("\n");
}

/** Tool names offered (client + server), in order. */
export function offered(body: AnthropicBody): string[] {
  return (body.tools ?? []).map((t) => String(t.name));
}

/** Tool names offered WITHOUT defer_loading (what the model sees up front). */
export function loaded(body: AnthropicBody): string[] {
  return (body.tools ?? []).filter((t) => t.defer_loading !== true).map((t) => String(t.name));
}

/** tool_result contents the model got back. */
export function toolResults(body: AnthropicBody): string[] {
  const out: string[] = [];
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") out.push(typeof b.content === "string" ? b.content : textOfContent(b.content));
    }
  }
  return out;
}

function message(body: AnthropicBody, reply: FakeReply): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (reply.text) content.push({ type: "text", text: reply.text });
  for (const c of reply.calls ?? []) content.push({ type: "tool_use", id: `toolu_${++seq}`, name: c.name, input: c.input ?? {} });
  return {
    id: `msg_fake_${++msgSeq}`,
    type: "message",
    role: "assistant",
    model: body.model ?? "claude-fake",
    content,
    stop_reason: reply.calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: reply.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/** The SSE event stream the SDK's MessageStream accumulates (event: + data: lines). */
function writeSse(res: ServerResponse, msg: Record<string, unknown>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (ev: Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  const usage = msg.usage as FakeUsage;
  send({ type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } });
  (msg.content as Array<Record<string, unknown>>).forEach((block, index) => {
    if (block.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of String(block.text).match(/\S+\s*|\s+/g) ?? []) send({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    } else {
      send({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    send({ type: "content_block_stop", index });
  });
  send({ type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  send({ type: "message_stop" });
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const savedEnv: Record<string, string | undefined> = {};

/**
 * Start the fake and point the router at it (Anthropic single-key mode).
 * `agentWorker` sets AGENT_WORKER for the suite (default "off": every chat
 * turn runs inline, which is what the probe and the eval runner want).
 */
export async function startFakeAnthropic(opts: { agentWorker?: "off" | "external" | "internal"; env?: Record<string, string> } = {}): Promise<FakeAnthropic> {
  const fake: FakeAnthropic = {
    script: () => ({ text: "ok" }),
    requests: [],
    batches: new Map(),
    batchEndsAfterPolls: 2,
    baseUrl: "",
    close: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const path = req.url ?? "";
      try {
        // ── Message Batches (Phase 17 A4) ─────────────────────────────────
        const batchMatch = path.match(/^\/v1\/messages\/batches(?:\/([^/?]+))?(\/results)?/);
        if (batchMatch) {
          const [, id, results] = batchMatch;
          if (req.method === "POST" && !id) {
            const body = JSON.parse(raw) as { requests: Array<{ custom_id: string; params: AnthropicBody }> };
            const batch: FakeBatch = { id: `msgbatch_fake_${++seq}`, requests: body.requests, polls: 0, createdAt: Date.now() };
            fake.batches.set(batch.id, batch);
            return json(res, 200, batchView(batch, fake.batchEndsAfterPolls));
          }
          const batch = id ? fake.batches.get(id) : undefined;
          if (!batch) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "batch not found" } });
          if (results) {
            if (batch.polls < fake.batchEndsAfterPolls) return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "batch still processing" } });
            const lines: string[] = [];
            for (const r of batch.requests) {
              const rec: RecordedAnthropicRequest = { seq: fake.requests.length + 1, path, body: r.params, betas: "", startedAt: Date.now(), endedAt: Date.now(), aborted: false };
              fake.requests.push(rec);
              const reply = await fake.script(r.params, rec);
              const result = reply.error
                ? { type: "errored", error: { type: "error", error: { type: reply.error.type, message: reply.error.message } } }
                : { type: "succeeded", message: { ...message(r.params, reply), usage: { ...(reply.usage ?? { input_tokens: 10, output_tokens: 5 }), service_tier: "batch" } } };
              lines.push(JSON.stringify({ custom_id: r.custom_id, result }));
            }
            res.writeHead(200, { "content-type": "application/x-jsonl" });
            return res.end(lines.join("\n") + "\n");
          }
          batch.polls++;
          return json(res, 200, batchView(batch, fake.batchEndsAfterPolls));
        }

        // ── Messages ──────────────────────────────────────────────────────
        if (!/^\/v1\/messages(\?|$)/.test(path)) throw new Error(`unexpected path ${path}`);
        const rec: RecordedAnthropicRequest = {
          seq: fake.requests.length + 1,
          path,
          body: JSON.parse(raw) as AnthropicBody,
          betas: String(req.headers["anthropic-beta"] ?? ""),
          startedAt: Date.now(),
          endedAt: null,
          aborted: false,
        };
        res.on("close", () => {
          if (!res.writableFinished) rec.aborted = true;
          rec.endedAt ??= Date.now();
        });
        fake.requests.push(rec);
        const reply = await fake.script(rec.body, rec);
        if (reply.hold) await reply.hold;
        if (res.destroyed) return;
        if (reply.error) {
          json(res, reply.error.status, { type: "error", error: { type: reply.error.type, message: reply.error.message } });
        } else {
          const msg = message(rec.body, reply);
          if (rec.body.stream) writeSse(res, msg);
          else json(res, 200, msg);
        }
        rec.endedAt = Date.now();
      } catch (err) {
        if (!res.destroyed) json(res, 500, { type: "error", error: { type: "api_error", message: err instanceof Error ? err.message : "fake failed" } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  fake.baseUrl = `http://127.0.0.1:${port}`;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = fake.baseUrl;
  process.env.AGENT_WORKER = opts.agentWorker ?? "off";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  fake.close = async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return fake;
}

function batchView(batch: FakeBatch, endsAfter: number): Record<string, unknown> {
  const ended = batch.polls >= endsAfter;
  const n = batch.requests.length;
  return {
    id: batch.id,
    type: "message_batch",
    processing_status: ended ? "ended" : "in_progress",
    request_counts: { processing: ended ? 0 : n, succeeded: ended ? n : 0, errored: 0, canceled: 0, expired: 0 },
    ended_at: ended ? new Date().toISOString() : null,
    created_at: new Date(batch.createdAt).toISOString(),
    expires_at: new Date(batch.createdAt + 86_400_000).toISOString(),
    archived_at: null,
    cancel_initiated_at: null,
    results_url: ended ? `/v1/messages/batches/${batch.id}/results` : null,
  };
}

/** A promise plus its resolver (hold a fake reply until the test says so). */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
