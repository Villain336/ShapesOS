// ShapesOS — Phase 10 (finance): /api/ops/finance/settings.
//   GET → invoice sender name/footer, currency, whether the workspace's own
//         Stripe is connected (a key hint only — secrets never leave the
//         server) and the webhook URL to paste into Stripe. Viewer+.
//   PUT { stripeSecretKey?, stripeWebhookSecret?, disconnectStripe?,
//         invoiceFromName?, invoiceFooter?, currency? } → admin+. Keys are
//         stored with the lib/secrets envelope.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getFinanceSettingsView, saveFinanceSettings } from "@/lib/ops/finance/stripe";
import { financeError, financeGuard, readJsonBody } from "@/lib/ops/finance/http";
import { appBaseUrl } from "@/lib/workspace/invite-mail";

export const dynamic = "force-dynamic";

function webhookUrl(req: Request, workspaceId: string): string {
  const base = appBaseUrl(process.env, new URL(req.url).origin) ?? new URL(req.url).origin;
  return `${base}/api/ops/stripe/webhook/${encodeURIComponent(workspaceId)}`;
}

export async function GET(req: Request) {
  const actor = await financeGuard("viewer");
  if (actor instanceof Response) return actor;
  try {
    const settings = await withWorkspaceScope(actor.workspaceId, (tx) => getFinanceSettingsView(tx, actor.workspaceId));
    return Response.json({ settings, stripeWebhookUrl: webhookUrl(req, actor.workspaceId) });
  } catch (err) {
    return financeError(err);
  }
}

export async function PUT(req: Request) {
  const actor = await financeGuard("admin");
  if (actor instanceof Response) return actor;
  try {
    const body = await readJsonBody(req);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const settings = await withWorkspaceScope(actor.workspaceId, (tx) =>
      saveFinanceSettings(tx, actor, {
        stripeSecretKey: str(body.stripeSecretKey) || undefined,
        stripeWebhookSecret: str(body.stripeWebhookSecret) || undefined,
        disconnectStripe: body.disconnectStripe === true,
        invoiceFromName: body.invoiceFromName === null ? null : str(body.invoiceFromName),
        invoiceFooter: body.invoiceFooter === null ? null : str(body.invoiceFooter),
        currency: str(body.currency),
      }),
    );
    return Response.json({ settings, stripeWebhookUrl: webhookUrl(req, actor.workspaceId) });
  } catch (err) {
    return financeError(err);
  }
}
