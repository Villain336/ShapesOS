// Marketr — CRM public capture-form endpoint.
//
// PUBLIC BY DESIGN (see scripts/verify-m11-security.mjs): no session.
// Capability model: the unguessable token (mkfrm_<32 hex>, stored as sha256)
// IS the capability — possession of the token authorizes exactly one action:
// submitting a lead into the token's pipeline. Defenses in depth:
//   - token hashed at rest; disabled/missing token → 404 (no oracle)
//   - per-token+IP rate limit (10/min); see lib/crm/public-form.ts
//   - honeypot field ("website") — bots fill it, humans don't
//   - Zod validation, 2KB body cap, dedup-checked insert (409 on duplicate)
//   - leads are created with source=website_form and the pipeline's first stage
//
// GET  /api/crm/public/forms/[token]  → public form config (pipeline name, fields)
// POST /api/crm/public/forms/[token]  → submit a lead

import {
  findFormByToken,
  getPublicFormConfig,
  handlePublicSubmit,
} from "@/lib/crm/public-form";

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await findFormByToken(token);
  if (!form || !form.enabled) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ form: getPublicFormConfig(form) });
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let raw = "";
  try {
    raw = await req.text();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const res = await handlePublicSubmit({ token, rawBody: raw, ip });
  return Response.json(res.json, {
    status: res.status,
    headers: res.headers,
  });
}
