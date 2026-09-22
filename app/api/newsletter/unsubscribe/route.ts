// Marketr — newsletter API: public unsubscribe (milestone 19).
// GET /api/newsletter/unsubscribe?token= → confirm page
// POST → { token } → unsubscribe (also serves RFC 8058 one-click: the
// List-Unsubscribe-Post header means providers POST here with the token).

import { prisma } from "@/lib/prisma";
import { unsubscribeByToken } from "@/lib/newsletter/service";

export const dynamic = "force-dynamic";

function page(email: string | null, listName: string | null, ok: boolean): Response {
  const title = ok ? "You've been unsubscribed" : "Invalid link";
  const body = ok
    ? `<p>${email ? `<strong>${email}</strong> has` : "You have"} been removed from <strong>${listName ?? "the list"}</strong>. No more emails will be sent to this address.</p>`
    : `<p>This unsubscribe link is invalid or has already been used.</p>`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Marketr</title></head>` +
      `<body style="font-family:Arial,Helvetica,sans-serif;background:#f3f4f6;margin:0;padding:48px 16px">` +
      `<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center">` +
      `<h1 style="font-size:20px;color:#111827">${title}</h1>${body}</div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const result = token ? await unsubscribeByToken(prisma, token) : null;
  if (!result) return page(null, null, false);
  return page(result.email, result.listName, true);
}

export async function POST(req: Request) {
  // One-click unsubscribe: token may arrive as a form field or query param.
  let token = new URL(req.url).searchParams.get("token") ?? "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      token = String(form.get("token") ?? form.get("List-Unsubscribe") ?? token);
    } else if (ct.includes("application/json")) {
      const body = (await req.json()) as { token?: string };
      if (body.token) token = body.token;
    }
  } catch {
    // fall through with the query-param token
  }
  const result = token ? await unsubscribeByToken(prisma, token) : null;
  return Response.json({ ok: !!result });
}
