// ShapesOS — Phase 8: the agent loop's tool list (PURE).
//
// Turns the ToolDef catalog (lib/chat/tools.ts allTools(), which includes
// tools other modules register at runtime with registerExtraTool — the
// sandbox code tools among them) and the project's connector tools into
// native chat() tool definitions, filtered by the task's Phase 5 grant.
//
// Tool names: the API accepts ^[a-zA-Z0-9_-]{1,64}$ (Anthropic allows 128,
// OpenAI 64 — the stricter one wins). Our canonical names stay what the gates
// know (`get_keywords`, `connector.<key>.<tool>`); each gets a stable
// API-safe alias (`connector__<key>__<tool>`), mapped back before the call
// reaches executeTool. A name the model invents is mapped back the same way
// and then refused by the gates (never silently dropped).

import { createHash } from "node:crypto";
import type { ChatJsonSchema, ChatServerTool, ChatToolDef } from "@/lib/llm/types";
import type { ToolDef } from "@/lib/chat/tools";
import { connectorGroup, isGroupGranted } from "@/lib/agents/grants";

export const API_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CONNECTOR_PREFIX = "connector.";
const API_CONNECTOR_PREFIX = "connector__";

/** A connector tool as the loop sees it (lib/chat/connector-tools.ts). */
export interface ConnectorChatTool {
  connectorKey: string;
  name: string;
  description: string;
  mutating: boolean;
  argsSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** The API-safe alias of a canonical tool name (deterministic). */
export function apiToolName(canonical: string): string {
  if (API_TOOL_NAME_RE.test(canonical)) return canonical;
  let name = canonical.startsWith(CONNECTOR_PREFIX)
    ? API_CONNECTOR_PREFIX + canonical.slice(CONNECTOR_PREFIX.length).replace(/\./g, "__")
    : canonical.replace(/\./g, "__");
  name = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.length > 64 || name.length === 0) name = `${name.slice(0, 55)}_${shortHash(canonical)}`;
  return name;
}

/** Best-effort reverse of apiToolName for a name not in the run's map. */
export function canonicalFromApiName(api: string): string {
  if (api.startsWith(API_CONNECTOR_PREFIX)) {
    const parts = api.slice(API_CONNECTOR_PREFIX.length).split("__");
    if (parts.length >= 2) {
      const tool = parts.pop()!;
      return `${CONNECTOR_PREFIX}${parts.join("__")}.${tool}`;
    }
  }
  return api;
}

/** JSON schema for a ToolDef's args (properties pass through unchanged). */
export function argsToJsonSchema(schema: {
  properties: Record<string, unknown>;
  required?: string[];
}): ChatJsonSchema {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    properties[k] = v && typeof v === "object" ? { ...(v as Record<string, unknown>) } : { type: "string" };
  }
  const out: ChatJsonSchema = { type: "object", properties };
  if (schema.required && schema.required.length > 0) out.required = [...schema.required];
  return out;
}

const KIND_NOTE: Record<string, string> = {
  safe: "",
  spend: " [costs money or runs a heavy job: waits for the user's OK unless a rule allows it]",
  publish: " [publishes or sends: waits for the user's OK unless a rule allows it]",
  destructive: " [destructive: always waits for the user's OK]",
};

export function toolDefToChat(t: ToolDef): ChatToolDef {
  return {
    name: apiToolName(t.name),
    description: `${t.description}${KIND_NOTE[t.kind] ?? ""}`.slice(0, 4000),
    inputSchema: argsToJsonSchema(t.argsSchema),
  };
}

export function connectorToolToChat(t: ConnectorChatTool): ChatToolDef {
  return {
    name: apiToolName(`${CONNECTOR_PREFIX}${t.connectorKey}.${t.name}`),
    description: `[${t.connectorKey}] ${t.description}${t.mutating ? KIND_NOTE.publish : ""}`.slice(0, 4000),
    inputSchema: argsToJsonSchema(t.argsSchema),
  };
}

export interface LoopToolSet {
  defs: ChatToolDef[];
  serverTools: ChatServerTool[];
  /** API name → canonical name (falls back to canonicalFromApiName). */
  toCanonical(apiName: string): string;
  /** Canonical names offered to the model, in order. */
  canonical: string[];
}

export interface BuildLoopToolsInput {
  /** The catalog (allTools()). */
  tools: readonly ToolDef[];
  /** Phase 5 grant; null = role checks only (legacy). */
  grant: readonly string[] | null;
  /** Group of each catalog tool (lib/chat/tools.ts toolGroup). */
  groupOf: (name: string) => string;
  connectorTools?: readonly ConnectorChatTool[];
  /** Narrower than the grant (e.g. a skill's declared tools); canonical names. */
  filter?: (canonical: string) => boolean;
}

/**
 * The model's tool list for one run: granted catalog tools + granted
 * connector tools, plus Claude's server-side web_search / web_fetch when the
 * grant includes the web group.
 */
export function buildLoopTools(input: BuildLoopToolsInput): LoopToolSet {
  const defs: ChatToolDef[] = [];
  const canonical: string[] = [];
  const map = new Map<string, string>();
  const add = (canon: string, def: ChatToolDef) => {
    if (input.filter && !input.filter(canon)) return;
    let name = def.name;
    // Two canonical names may sanitise to the same alias: disambiguate.
    if (map.has(name) && map.get(name) !== canon) name = `${name.slice(0, 55)}_${shortHash(canon)}`;
    if (map.has(name)) return;
    map.set(name, canon);
    defs.push({ ...def, name });
    canonical.push(canon);
  };
  for (const t of input.tools) {
    if (!isGroupGranted(input.grant, input.groupOf(t.name) as never)) continue;
    add(t.name, toolDefToChat(t));
  }
  for (const c of input.connectorTools ?? []) {
    if (!isGroupGranted(input.grant, connectorGroup(c.connectorKey))) continue;
    add(`${CONNECTOR_PREFIX}${c.connectorKey}.${c.name}`, connectorToolToChat(c));
  }
  const serverTools: ChatServerTool[] = isGroupGranted(input.grant, "web") ? ["web_search", "web_fetch"] : [];
  return {
    defs,
    serverTools,
    canonical,
    toCanonical: (api) => map.get(api) ?? canonicalFromApiName(api),
  };
}
