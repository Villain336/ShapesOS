// ShapesOS — Phase 14 (connectors): the credential fields a non-OAuth
// connection is made of (PURE: no I/O; the registry declares them, the
// api-key route validates against them, the Connectors page renders them).
//
// Before Phase 14 the generic api-key route stored only { apiKey }, so a
// connector that needs more than one value (WordPress: site URL + username +
// application password; DataForSEO: login + password; Shopify: store domain
// + token) could never go live through it. Now every connector that accepts
// typed-in credentials declares one or more MODES, each a list of fields; a
// field's `name` is the key the adapter reads from the decrypted payload, so
// the route stores exactly those keys and nothing else.
//
// Connectors that declare nothing and are authType "api_key" keep the old
// single-field shape ({ apiKey }) — unchanged for Resend, Supabase, Netlify.

export type CredentialFieldKind = "text" | "secret" | "url" | "shop_domain";

export interface CredentialField {
  /** Payload key the adapter reads (e.g. "apiKey", "username", "access_token"). */
  name: string;
  label: string;
  kind: CredentialFieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
  /** Max characters (default 8000 for secrets, 500 otherwise). */
  maxLength?: number;
}

export interface CredentialMode {
  id: string;
  label: string;
  help?: string;
  fields: CredentialField[];
}

/** The default single-key mode every plain api_key connector uses. */
export const API_KEY_MODE: CredentialMode = {
  id: "api_key",
  label: "API key",
  fields: [{ name: "apiKey", label: "API key", kind: "secret", required: true, placeholder: "sk-…" }],
};

export interface CredentialMeta {
  key: string;
  authType: "oauth2" | "api_key" | "none";
  credentialModes?: CredentialMode[];
}

/**
 * The typed-in credential modes a connector accepts. api_key connectors get
 * their declared modes (else the single-key default); an OAuth connector only
 * has modes when it declares an alternative to OAuth (Shopify's single-store
 * connection); "none" connectors have none.
 */
export function credentialModesFor(meta: CredentialMeta): CredentialMode[] {
  if (meta.credentialModes && meta.credentialModes.length > 0) return meta.credentialModes;
  return meta.authType === "api_key" ? [API_KEY_MODE] : [];
}

export type ParsedCredential =
  | { ok: true; mode: CredentialMode; values: Record<string, string> }
  | { ok: false; error: string };

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

function normalizeShop(v: string): string | null {
  let s = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (s && !s.includes(".")) s = `${s}.myshopify.com`;
  return SHOP_RE.test(s) ? s : null;
}

/**
 * Validate untrusted form input against a connector's credential schema.
 * Returns exactly the declared fields of the chosen mode (empty optional
 * fields dropped). Secrets are kept byte-for-byte (keys are opaque; only an
 * all-whitespace value counts as empty); text/url/shop fields are trimmed.
 * `legacyApiKey` keeps old clients that post { apiKey } working when the
 * chosen mode has an apiKey field.
 */
export function parseCredentialFields(
  meta: CredentialMeta,
  input: { mode?: string | null; fields?: Record<string, unknown> | null; legacyApiKey?: string | null },
): ParsedCredential {
  const modes = credentialModesFor(meta);
  if (modes.length === 0) {
    return { ok: false, error: `${meta.key} connects with ${meta.authType === "oauth2" ? "OAuth" : "no credentials"} — not with typed-in keys` };
  }
  const mode = input.mode ? modes.find((m) => m.id === input.mode) : modes[0];
  if (!mode) return { ok: false, error: `Unknown connection mode "${String(input.mode).slice(0, 40)}" for ${meta.key} (use ${modes.map((m) => m.id).join(" or ")})` };
  const raw: Record<string, unknown> = { ...(input.fields ?? {}) };
  if (input.legacyApiKey !== undefined && input.legacyApiKey !== null && raw.apiKey === undefined && mode.fields.some((f) => f.name === "apiKey")) {
    raw.apiKey = input.legacyApiKey;
  }
  const known = new Set(mode.fields.map((f) => f.name));
  const unknown = Object.keys(raw).filter((k) => !known.has(k) && raw[k] !== undefined && raw[k] !== null && raw[k] !== "");
  if (unknown.length) return { ok: false, error: `Unexpected field${unknown.length === 1 ? "" : "s"} for ${meta.key}: ${unknown.slice(0, 5).join(", ")}` };

  const values: Record<string, string> = {};
  for (const f of mode.fields) {
    const v = raw[f.name];
    if (v !== undefined && v !== null && typeof v !== "string") return { ok: false, error: `${f.label} must be text` };
    const s = typeof v === "string" ? v : "";
    const max = f.maxLength ?? (f.kind === "secret" ? 8000 : 500);
    if (!s.trim()) {
      if (f.required) return { ok: false, error: `${f.label} is required` };
      continue;
    }
    if (s.length > max) return { ok: false, error: `${f.label} is too long` };
    if (f.kind === "secret") {
      values[f.name] = s;
    } else if (f.kind === "url") {
      let u: URL;
      try {
        u = new URL(s.trim());
      } catch {
        return { ok: false, error: `${f.label} must be a full URL (https://…)` };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: `${f.label} must be an http(s) URL` };
      if (u.username || u.password) return { ok: false, error: `${f.label} must not contain a username or password` };
      values[f.name] = u.toString().replace(/\/+$/, "");
    } else if (f.kind === "shop_domain") {
      const shop = normalizeShop(s);
      if (!shop) return { ok: false, error: `${f.label} must be your-store.myshopify.com` };
      values[f.name] = shop;
    } else {
      values[f.name] = s.trim();
    }
  }
  return { ok: true, mode, values };
}

/** What the Connectors page needs to render a connect form (no secrets). */
export function publicCredentialModes(meta: CredentialMeta): CredentialMode[] {
  return credentialModesFor(meta).map((m) => ({ ...m, fields: m.fields.map((f) => ({ ...f })) }));
}
