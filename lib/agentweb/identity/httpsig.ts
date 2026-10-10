// ShapesOS — Phase 21A round 2 (WS=agentweb): Web Bot Auth (PURE).
//
// Signed, honest agent traffic: HTTP Message Signatures (RFC 9421) with Ed25519, as
// profiled by draft-meunier-web-bot-auth-architecture-05 (expired; superseded by
// draft-meunier-webbotauth-httpsig-protocol) and Cloudflare's "Web Bot Auth" docs:
//   - three headers: Signature-Input, Signature, and (recommended) Signature-Agent;
//   - tag="web-bot-auth"; keyid = base64url JWK SHA-256 thumbprint (RFC 7638 for the
//     Ed25519 OKP key as in RFC 8037 A.3); created and expires are required, expires
//     should be short (recommended at most 24 h); nonce is recommended;
//   - at least @authority (or @target-uri) is covered. The authority is in the
//     signature base, so a signature made for one host does not verify on another:
//     that is the whole replay story across hosts;
//   - if Signature-Agent is sent it is covered: as "signature-agent" for the quoted-string
//     form Cloudflare documents (our default), or as "signature-agent";key="<member>" for the
//     draft's dictionary form (Signature-Agent: agent="https://…"). Note the draft's vector A.2.2
//     is generated over the member's UNQUOTED string value, which we reproduce byte for byte.
// The key directory (/.well-known/http-message-signatures-directory, media type
// application/http-message-signatures-directory+json) is signed with
// tag="http-message-signatures-directory" over "@authority";req.
//
// This module signs and verifies; it knows nothing about keys at rest, the network or
// the database. It is the identity of an agent, not a way to look like a person: no
// evasion lives here.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

export const TAG_WEB_BOT_AUTH = "web-bot-auth";
export const TAG_DIRECTORY = "http-message-signatures-directory";
export const DEFAULT_MAX_WINDOW_SEC = 86_400;
const SKEW_SEC = 30;

export interface KeyPair {
  /** Public key, base64url (JWK "x"). */
  x: string;
  /** JWK thumbprint of the public key: what goes in keyid. */
  kid: string;
  privateKey: KeyObject;
  /** Private scalar, base64url (JWK "d"), kept so the caller can seal it. */
  d: string;
}

export function jwkThumbprint(x: string): string {
  // RFC 7638: members in lexicographic order, no whitespace; RFC 8037 A.3 for OKP.
  return createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest("base64url");
}

export function keyPairFromJwk(jwk: { x: string; d: string }): KeyPair {
  const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, format: "jwk" });
  return { x: jwk.x, d: jwk.d, kid: jwkThumbprint(jwk.x), privateKey };
}

export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return keyPairFromJwk(jwk);
}

function publicKeyOf(x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

// ---------------------------------------------------------------------------
// Structured field serialization / parsing (the small subset these headers use)
// ---------------------------------------------------------------------------

interface ComponentId {
  name: string;
  /** Parameters such as key="agent2" or req. */
  params: Record<string, string | true>;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const serializeId = (c: ComponentId): string =>
  `${quote(c.name)}${Object.entries(c.params)
    .map(([k, v]) => (v === true ? `;${k}` : `;${k}=${quote(v)}`))
    .join("")}`;

/** Split on top-level separators, ignoring those inside quotes, parentheses or :bytes:. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let inBytes = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\") cur += s[++i] ?? "";
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inBytes) {
      cur += ch;
      if (ch === ":") inBytes = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ":" && depth === 0) inBytes = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((p) => p.trim());
}

const unquote = (s: string): string => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(["\\])/g, "$1") : s);

function parseParams(raw: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const p of splitTop(raw, ";")) {
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 0) out[p] = true;
    else out[p.slice(0, eq)] = unquote(p.slice(eq + 1));
  }
  return out;
}

interface ParsedInput {
  label: string;
  /** Exactly as received: the verifier signs this text, never a re-serialization. */
  paramsText: string;
  components: ComponentId[];
  params: Record<string, string | true>;
}

function parseSignatureInput(header: string): ParsedInput[] {
  const out: ParsedInput[] = [];
  for (const member of splitTop(header, ",")) {
    const eq = member.indexOf("=");
    if (eq < 0) continue;
    const label = member.slice(0, eq).trim();
    const rest = member.slice(eq + 1).trim();
    if (!rest.startsWith("(")) continue;
    let depth = 0;
    let inStr = false;
    let close = -1;
    for (let i = 0; i < rest.length; i++) {
      const ch = rest[i]!;
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const inner = rest.slice(1, close);
    const components: ComponentId[] = [];
    for (const item of splitTop(inner.replace(/\s+/g, " "), " ")) {
      const semi = item.indexOf(";");
      const name = unquote(semi < 0 ? item : item.slice(0, semi));
      components.push({ name, params: semi < 0 ? {} : parseParams(item.slice(semi + 1)) });
    }
    out.push({ label, paramsText: rest, components, params: parseParams(rest.slice(close + 1).replace(/^;/, "")) });
  }
  return out;
}

function parseSignatures(header: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const member of splitTop(header, ",")) {
    const m = /^([A-Za-z0-9_-]+)=:([A-Za-z0-9+/=_-]*):$/.exec(member.trim());
    if (m) out.set(m[1]!, Buffer.from(m[2]!, "base64"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signature base
// ---------------------------------------------------------------------------

type Headers = Record<string, string | undefined>;
const lower = (h: Headers): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined).map(([k, v]) => [k.toLowerCase(), String(v)]));

function componentValue(c: ComponentId, req: { url: URL; method: string; headers: Record<string, string> }): string | null {
  switch (c.name) {
    case "@authority":
      return req.url.host.toLowerCase();
    case "@target-uri":
      return req.url.href;
    case "@method":
      return req.method.toUpperCase();
    case "@path":
      return req.url.pathname || "/";
    case "@query":
      return req.url.search || "?";
    case "@scheme":
      return req.url.protocol.replace(":", "");
    default: {
      if (c.name.startsWith("@")) return null;
      const v = req.headers[c.name];
      if (v === undefined) return null;
      const key = c.params.key;
      if (typeof key === "string") {
        // a Structured Field dictionary member: its serialized value
        const member = splitTop(v, ",").map((m) => m.trim()).find((m) => m.startsWith(`${key}=`));
        // The draft's own vector (A.2.2) verifies only with the member's string value WITHOUT its
        // structured-field quotes, although the draft's prose prints them: we follow the vector.
        return member ? unquote(member.slice(key.length + 1)) : null;
      }
      return v.trim();
    }
  }
}

function signatureBase(components: ComponentId[], paramsText: string, req: { url: URL; method: string; headers: Record<string, string> }, responseAuthority?: string): string | null {
  const lines: string[] = [];
  for (const c of components) {
    // "@authority";req in a RESPONSE signature is the authority of the request it answers.
    const v = c.params.req === true && responseAuthority !== undefined ? responseAuthority.toLowerCase() : componentValue(c, req);
    if (v === null) return null;
    lines.push(`${serializeId(c)}: ${v}`);
  }
  lines.push(`"@signature-params": ${paramsText}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SignatureAgentInput {
  /** The agent's identity URL: its key directory lives under this origin. */
  url: string;
  /** Dictionary member name ("agent" by default). */
  member?: string;
  /**
   * "string" (default): Signature-Agent: "https://…", covered as "signature-agent": what Cloudflare's
   * Web Bot Auth page documents today. "dictionary": the newer draft's agent="https://…" member,
   * covered as "signature-agent";key="agent". Flip the default if a verifier wants the dictionary.
   */
  form?: "dictionary" | "string";
}

export interface SignInput {
  url: string;
  method?: string;
  keys: KeyPair;
  /** Unix seconds. */
  created: number;
  expires: number;
  nonce?: string;
  label?: string;
  tag?: string;
  /** Covered components; default ["@authority"]. signature-agent is added when signatureAgent is set. */
  components?: string[];
  signatureAgent?: SignatureAgentInput;
}

export interface SignedHeaders {
  "Signature-Input": string;
  Signature: string;
  "Signature-Agent"?: string;
}

export function signRequest(input: SignInput): SignedHeaders {
  const u = new URL(input.url);
  const label = input.label ?? "sig1";
  const ids: ComponentId[] = (input.components ?? ["@authority"]).map((name) => ({ name, params: {} }));
  const headers: Record<string, string> = {};
  const out: SignedHeaders = { "Signature-Input": "", Signature: "" };
  if (input.signatureAgent) {
    const form = input.signatureAgent.form ?? "string";
    if (form === "string") {
      out["Signature-Agent"] = quote(input.signatureAgent.url);
      ids.push({ name: "signature-agent", params: {} });
    } else {
      const member = input.signatureAgent.member ?? "agent";
      out["Signature-Agent"] = `${member}=${quote(input.signatureAgent.url)}`;
      ids.push({ name: "signature-agent", params: { key: member } });
    }
    headers["signature-agent"] = out["Signature-Agent"];
  }
  const nonce = input.nonce ?? randomBytes(64).toString("base64");
  const paramsText = `(${ids.map(serializeId).join(" ")});created=${input.created};keyid=${quote(input.keys.kid)};alg="ed25519";expires=${input.expires};nonce=${quote(nonce)};tag=${quote(input.tag ?? TAG_WEB_BOT_AUTH)}`;
  const base = signatureBase(ids, paramsText, { url: u, method: input.method ?? "GET", headers });
  if (base === null) throw new Error("A covered component is missing from the request.");
  out["Signature-Input"] = `${label}=${paramsText}`;
  out.Signature = `${label}=:${edSign(null, Buffer.from(base), input.keys.privateKey).toString("base64")}:`;
  return out;
}

export function signDirectoryResponse(input: { authority: string; keys: KeyPair; created: number; expires: number; label?: string }): { "Signature-Input": string; Signature: string } {
  const label = input.label ?? "sig1";
  const ids: ComponentId[] = [{ name: "@authority", params: { req: true } }];
  const paramsText = `(${ids.map(serializeId).join(" ")});created=${input.created};expires=${input.expires};keyid=${quote(input.keys.kid)};alg="ed25519";tag=${quote(TAG_DIRECTORY)}`;
  const base = signatureBase(ids, paramsText, { url: new URL("https://invalid.example/"), method: "GET", headers: {} }, input.authority);
  return { "Signature-Input": `${label}=${paramsText}`, Signature: `${label}=:${edSign(null, Buffer.from(base!), input.keys.privateKey).toString("base64")}:` };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifyFailure =
  | "missing_headers"
  | "no_web_bot_auth_signature"
  | "missing_params"
  | "unsupported_alg"
  | "authority_not_covered"
  | "signature_agent_not_covered"
  | "unknown_key"
  | "keyid_mismatch"
  | "not_yet_valid"
  | "expired"
  | "window_too_long"
  | "replayed_nonce"
  | "bad_signature";

export type VerifyResult =
  | { ok: true; keyid: string; label: string; signatureAgent: string | null; created: number; expires: number; nonce: string | null }
  | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  /** The URL the verifier actually received the request on: its own view of the host. */
  url: string;
  method?: string;
  headers: Headers;
  /** Public key (base64url x) for a keyid, e.g. fetched from the agent's directory. */
  resolveKey: (keyid: string, signatureAgent: string | null) => string | null;
  /** Unix seconds. */
  now: number;
  maxWindowSec?: number;
  /** Returns true when the nonce was already used (the verifier keeps that ledger). */
  seenNonce?: (nonce: string) => boolean;
}

const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });

export function verifyRequest(input: VerifyInput): VerifyResult {
  const headers = lower(input.headers);
  const inputHeader = headers["signature-input"];
  const sigHeader = headers.signature;
  if (!inputHeader || !sigHeader) return fail("missing_headers");
  const sigs = parseSignatures(sigHeader);
  const entry = parseSignatureInput(inputHeader).find((e) => e.params.tag === TAG_WEB_BOT_AUTH && sigs.has(e.label));
  if (!entry) return fail("no_web_bot_auth_signature");
  const created = Number(entry.params.created);
  const expires = Number(entry.params.expires);
  const keyid = typeof entry.params.keyid === "string" ? entry.params.keyid : "";
  if (!Number.isFinite(created) || !Number.isFinite(expires) || !keyid) return fail("missing_params");
  if (entry.params.alg !== undefined && entry.params.alg !== "ed25519") return fail("unsupported_alg");
  if (!entry.components.some((c) => c.name === "@authority" || c.name === "@target-uri")) return fail("authority_not_covered");
  const agentHeader = headers["signature-agent"];
  if (agentHeader !== undefined && !entry.components.some((c) => c.name === "signature-agent")) return fail("signature_agent_not_covered");

  const agentMember = agentHeader === undefined ? null : (splitTop(agentHeader, ",")[0] ?? "");
  const signatureAgent = agentMember === null ? null : unquote(agentMember.includes("=") && !agentMember.startsWith('"') ? agentMember.slice(agentMember.indexOf("=") + 1) : agentMember);
  const x = input.resolveKey(keyid, signatureAgent);
  if (!x) return fail("unknown_key");
  if (jwkThumbprint(x) !== keyid) return fail("keyid_mismatch");
  if (created > input.now + SKEW_SEC) return fail("not_yet_valid");
  if (expires <= input.now) return fail("expired");
  if (expires - created > (input.maxWindowSec ?? DEFAULT_MAX_WINDOW_SEC)) return fail("window_too_long");

  const base = signatureBase(entry.components, entry.paramsText, { url: new URL(input.url), method: input.method ?? "GET", headers });
  if (base === null) return fail("bad_signature");
  let valid = false;
  try {
    valid = edVerify(null, Buffer.from(base), publicKeyOf(x), sigs.get(entry.label)!);
  } catch {
    valid = false;
  }
  if (!valid) return fail("bad_signature");
  const nonce = typeof entry.params.nonce === "string" ? entry.params.nonce : null;
  if (nonce !== null && input.seenNonce?.(nonce)) return fail("replayed_nonce");
  return { ok: true, keyid, label: entry.label, signatureAgent, created, expires, nonce };
}

export function verifyDirectoryResponse(input: { authority: string; headers: Headers; x: string; now: number }): { ok: boolean; reason?: VerifyFailure } {
  const headers = lower(input.headers);
  if (!headers["signature-input"] || !headers.signature) return { ok: false, reason: "missing_headers" };
  const sigs = parseSignatures(headers.signature);
  const entry = parseSignatureInput(headers["signature-input"]).find((e) => e.params.tag === TAG_DIRECTORY && sigs.has(e.label));
  if (!entry) return { ok: false, reason: "no_web_bot_auth_signature" };
  if (Number(entry.params.expires) <= input.now) return { ok: false, reason: "expired" };
  if (entry.params.keyid !== jwkThumbprint(input.x)) return { ok: false, reason: "keyid_mismatch" };
  const base = signatureBase(entry.components, entry.paramsText, { url: new URL("https://invalid.example/"), method: "GET", headers: {} }, input.authority);
  if (base === null) return { ok: false, reason: "bad_signature" };
  let valid = false;
  try {
    valid = edVerify(null, Buffer.from(base), publicKeyOf(input.x), sigs.get(entry.label)!);
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
