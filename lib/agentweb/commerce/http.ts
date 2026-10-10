// ShapesOS — Phase 21A round 2 (WS=agentweb): the guard in front of the signing routes.
//
// Signing a cart mandate must be a person clicking a card in this app. The route is
// reachable only with the signed-in session cookie, and on top of that it refuses requests
// that did not come from this app's own page: a cross-site fetch (Sec-Fetch-Site), a foreign
// Origin, a body that is not JSON, or a body that does not name the channel "ui_click".
// Anything that is not a browser click on our page (a script with an API key, a voice
// assistant, an agent's HTTP tool) cannot satisfy it.

export type GuardResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: 400 | 403 | 415; error: string };

export async function humanClickGuard(req: Request, opts: { requireChannel: boolean; /** What is being decided, for the error text (default "A cart"). */ subject?: string }): Promise<GuardResult> {
  const what = opts.subject ?? "A cart";
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return { ok: false, status: 403, error: `${what} can only be decided from this app's own page.` };
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* bad origin */
    }
    if (host !== new URL(req.url).host) return { ok: false, status: 403, error: `${what} can only be decided from this app's own page.` };
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return { ok: false, status: 415, error: "Send JSON." };
  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text.length > 2000) return { ok: false, status: 400, error: "Request too large." };
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON." };
  }
  if (opts.requireChannel && body.channel !== "ui_click") return { ok: false, status: 403, error: `${what} is approved only by the person clicking its card (channel ui_click).` };
  return { ok: true, body };
}
