// ShapesOS — test helper (NOT a test file): a scripted fake of the OpenAI
// Responses API (POST /v1/responses, streamed as SSE). MOCK — no model is
// called; every reply comes from the test's script.
//
// With only OPENAI_API_KEY set, single-key mode routes every agent workload
// to gpt-5.5 on the Responses API, so the REAL agent loop, gates, run service,
// queue and worker run unchanged against it (the agent-controls suite uses the
// same seam inline; this module is its reusable form for the Phase 16
// delegation suites).
//
// Extras over the inline version:
//   * every request is recorded with its start / end time (overlap proofs)
//     and whether the client aborted it mid-flight (Stop / lease-loss proofs);
//   * a reply may hold until a promise settles (`hold`) — the request stays in
//     flight, so a test can stop or steal it there;
//   * `usage` per reply (cost proofs: gpt-5.5 is $5 / $30 per M tokens).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ResponsesBody {
  instructions?: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<{ name: string }>;
  stream?: boolean;
}

export interface FakeReply {
  text?: string;
  calls?: Array<{ tool: string; args?: Record<string, unknown> }>;
  /** Keep the request in flight until this settles. */
  hold?: Promise<void>;
  usage?: { input_tokens: number; output_tokens: number };
}

export type FakeScript = (body: ResponsesBody, req: RecordedRequest) => FakeReply | Promise<FakeReply>;

export interface RecordedRequest {
  seq: number;
  body: ResponsesBody;
  startedAt: number;
  endedAt: number | null;
  /** The client went away before the reply was written (aborted call). */
  aborted: boolean;
}

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_MODEL_BULK",
  "LLM_MODEL",
  "LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "LLM_SELF_HOST",
  "LLM_MODEL_LEAD",
  "LLM_MODEL_SUBAGENT",
  "LLM_MODEL_CODE",
  "LLM_MODEL_CODE_MAX",
  "AGENT_WORKER",
  "AGENT_MAX_STEPS",
  "AGENT_MAX_RUN_COST_MICRO_USD",
  "AGENT_MAX_RUN_MINUTES",
];

export interface FakeModel {
  script: FakeScript;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

let callSeq = 0;

/** The function_call_output items the model got back (tool results). */
export function toolOutputs(body: ResponsesBody): string[] {
  return body.input.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
}

/** Tool names the model called earlier in this transcript. */
export function calledTools(body: ResponsesBody): string[] {
  return body.input.filter((i) => i.type === "function_call").map((i) => String(i.name));
}

/** Tool names offered to the model on this request. */
export function offered(body: ResponsesBody): string[] {
  return (body.tools ?? []).map((t) => t.name);
}

/** Everything the model was sent as plain text (instructions + input), for matching. */
export function allText(body: ResponsesBody): string {
  return `${body.instructions ?? ""}\n${JSON.stringify(body.input)}`;
}

let respSeq = 0;

async function respond(res: ServerResponse, body: ResponsesBody, reply: FakeReply): Promise<void> {
  const output: Array<Record<string, unknown>> = [];
  if (reply.text) output.push({ type: "message", content: [{ type: "output_text", text: reply.text }] });
  for (const c of reply.calls ?? []) {
    output.push({ type: "function_call", call_id: `call_${++callSeq}`, name: c.tool, arguments: JSON.stringify(c.args ?? {}) });
  }
  const response = {
    // Phase 15.2: unique per reply (as the real API's ids are) — the token
    // ledger is idempotent per response id.
    id: `resp_${++respSeq}_${callSeq}_${Date.now()}`,
    status: "completed",
    output,
    usage: reply.usage ?? { input_tokens: 10, output_tokens: 5 },
  };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const [output_index, item] of output.entries()) {
    if (item.type === "message") {
      const text = String((item.content as Array<{ text: string }>)[0]!.text);
      for (const piece of text.match(/\S+\s*|\s+/g) ?? []) send({ type: "response.output_text.delta", output_index, delta: piece });
    } else {
      send({ type: "response.output_item.added", output_index, item: { ...item, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", output_index, delta: item.arguments });
      send({ type: "response.output_item.done", output_index, item });
    }
  }
  send({ type: "response.completed", response });
  res.end();
}

const savedEnv: Record<string, string | undefined> = {};

/**
 * Start the fake and point the router at it (single-key OpenAI mode).
 * `agentWorker` sets AGENT_WORKER for the suite ("external": the app only
 * enqueues; the test drives an AgentWorker itself).
 */
export async function startFakeModel(opts: { agentWorker?: "off" | "external" | "internal"; env?: Record<string, string> } = {}): Promise<FakeModel> {
  const model: FakeModel = {
    script: () => ({ text: "ok" }),
    requests: [],
    close: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const rec: RecordedRequest = { seq: model.requests.length + 1, body: { input: [] }, startedAt: Date.now(), endedAt: null, aborted: false };
      res.on("close", () => {
        if (!res.writableFinished) rec.aborted = true;
        rec.endedAt ??= Date.now();
      });
      try {
        if (!req.url?.endsWith("/responses")) throw new Error(`unexpected path ${req.url}`);
        rec.body = JSON.parse(raw) as ResponsesBody;
        model.requests.push(rec);
        const reply = await model.script(rec.body, rec);
        if (reply.hold) await reply.hold;
        if (res.destroyed) return;
        await respond(res, rec.body, reply);
        rec.endedAt = Date.now();
      } catch {
        if (!res.destroyed) {
          res.writeHead(500);
          res.end();
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.AGENT_WORKER = opts.agentWorker ?? "external";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  model.close = async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return model;
}

/** A promise plus its resolver (hold a fake reply until the test says so). */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Poll until cond() is truthy (or fail after timeoutMs). */
export async function waitFor<T>(cond: () => Promise<T> | T, what: string, timeoutMs = 20_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
