// ShapesOS — Phase 12 (mfgpos): card payments on the till's reader.
//   POST { sessionId, amountCents, clientOrderId } → { paymentIntentId, status, mode }
//        creates a card_present PaymentIntent on the workspace's OWN Stripe
//        account and sends it to the register's reader (Stripe Terminal REST).
//   GET ?paymentIntentId=… → { status, amountCents, mode } (poll until succeeded)
// Editor+. With POS_TERMINAL_MOCK=1 a labelled mock approves instantly
// (provider stripe_terminal_mock — recorded as a mock, never real money).
// UNVERIFIED-LIVE: no physical reader was used.

import { z } from "zod";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";
import { tenantKeys } from "@/lib/ops/finance/stripe";
import { CLIENT_ORDER_ID_RE } from "@/lib/ops/pos/rules";
import { terminalAdapter, TerminalError } from "@/lib/ops/pos/terminal";

export const dynamic = "force-dynamic";

const Body = z.object({
  sessionId: z.string().min(1).max(64),
  amountCents: z.number().int().positive().max(2_147_483_647),
  clientOrderId: z.string().regex(CLIENT_ORDER_ID_RE),
  // The till's try count for this sale: a retry after a declined/cancelled
  // card is a NEW payment (a fresh Stripe idempotency key); a resent request
  // of the same try is the same payment.
  attempt: z.number().int().min(1).max(100).default(1),
});

function notConnected() {
  return Response.json({ error: "Card payments need Stripe connected in Finance settings." }, { status: 409 });
}

export async function POST(req: Request) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const raw = await readJsonBody(req);
    const parsed = Body.safeParse(raw);
    if (!raw || !parsed.success) return Response.json({ error: parsed.error?.issues[0]?.message ?? "Invalid card payment" }, { status: 400 });
    const { sessionId, amountCents, clientOrderId, attempt } = parsed.data;
    const ctx = await withWorkspaceScope(actor.workspaceId, async (tx) => {
      const s = await tx.opsPosSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId }, include: { register: { select: { terminalReaderId: true } } } });
      return { session: s, keys: await tenantKeys(tx, actor.workspaceId) };
    });
    if (!ctx.session) return Response.json({ error: `pos-sessions "${sessionId}" not found in workspace` }, { status: 404 });
    if (ctx.session.status !== "open") return Response.json({ error: "This session isn't open for sales." }, { status: 409 });
    const adapter = terminalAdapter(ctx.keys.secretKey);
    if (!adapter) return notConnected();
    const p = await adapter.startPayment({
      amountCents,
      currency: ctx.keys.currency,
      readerId: ctx.session.register.terminalReaderId,
      idempotencyKey: `${clientOrderId}-${amountCents}-${attempt}`,
      metadata: { workspace_id: actor.workspaceId, pos_session_id: sessionId, client_order_id: clientOrderId },
    });
    return Response.json({ paymentIntentId: p.id, status: p.status, amountCents: p.amountCents, mode: adapter.mode });
  } catch (err) {
    if (err instanceof TerminalError) return Response.json({ error: err.message }, { status: err.status });
    return financeError(err);
  }
}

export async function GET(req: Request) {
  const actor = await financeGuard("editor");
  if (actor instanceof Response) return actor;
  try {
    const ref = new URL(req.url).searchParams.get("paymentIntentId") ?? "";
    if (!ref || ref.length > 128) return Response.json({ error: "paymentIntentId is required" }, { status: 400 });
    const keys = await withWorkspaceScope(actor.workspaceId, (tx) => tenantKeys(tx, actor.workspaceId));
    const adapter = terminalAdapter(keys.secretKey);
    if (!adapter) return notConnected();
    const p = await adapter.getPayment(ref);
    return Response.json({ paymentIntentId: p.id, status: p.status, amountCents: p.amountCents, mode: adapter.mode });
  } catch (err) {
    if (err instanceof TerminalError) return Response.json({ error: err.message }, { status: err.status });
    return financeError(err);
  }
}
