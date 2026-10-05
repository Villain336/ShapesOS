// ShapesOS Phase 12 (mfgpos) — /dashboard/ops/pos/till/[sessionId]: the
// touch-screen till for one session — product grid, current sale, cash and
// card, receipts, the offline queue and the cash count / close.
import { notFound, redirect } from "next/navigation";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { requireOpsViewer } from "@/lib/ops/page-guard";
import { getFinanceSettingsView } from "@/lib/ops/finance/stripe";
import { sessionSummary } from "@/lib/ops/pos/service";
import { terminalMockEnabled } from "@/lib/ops/pos/terminal";
import { PosTill, type TillItem } from "@/components/ops/PosViews";

export const dynamic = "force-dynamic";

export const metadata = { title: "Till — ShapesOS", description: "Sell at the counter: products, cash and card, receipts." };

export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { workspaceId } = await requireOpsViewer();
  const { sessionId } = await params;
  const data = await withWorkspaceScope(workspaceId, async (tx) => {
    const s = await tx.opsPosSession.findFirst({ where: { id: sessionId, workspaceId }, include: { register: true } });
    if (!s) return null;
    const [summary, products, finance, rate] = await Promise.all([
      sessionSummary(tx, workspaceId, sessionId),
      tx.opsProduct.findMany({
        where: { workspaceId, active: true },
        orderBy: { name: "asc" },
        take: 500,
        include: { variants: { where: { active: true, isDefault: false }, orderBy: { name: "asc" } } },
      }),
      getFinanceSettingsView(tx, workspaceId),
      s.register.taxRateId ? tx.opsTaxRate.findFirst({ where: { id: s.register.taxRateId, workspaceId, active: true }, select: { rateBps: true } }) : null,
    ]);
    return { summary, products, stripeConnected: finance.stripeConnected, taxRateBps: rate?.rateBps ?? 0 };
  });
  if (!data) notFound();
  // A closed session has nothing left to sell or count.
  if (data.summary.status === "closed") redirect("/dashboard/ops/pos");
  const items: TillItem[] = data.products.flatMap((p): TillItem[] =>
    p.variants.length
      ? p.variants.map((v) => ({ key: `${p.id}|${v.id}`, productId: p.id, variantId: v.id, name: `${p.name} — ${v.name}`, sku: v.sku, priceCents: v.priceCents ?? p.priceCents }))
      : [{ key: `${p.id}|`, productId: p.id, variantId: null, name: p.name, sku: p.sku, priceCents: p.priceCents }],
  );
  const cardMode = terminalMockEnabled() ? "mock" : data.stripeConnected ? "live" : null;
  const s = data.summary;
  return (
    <PosTill
      session={{
        id: s.id,
        number: s.number,
        status: s.status,
        registerName: s.registerName,
        openingCashCents: s.openingCashCents,
        countedCashCents: s.countedCashCents,
        expectedCashCents: s.expectedCashCents,
        cashDifferenceCents: s.cashDifferenceCents,
        totals: s.totals,
      }}
      items={items}
      taxRateBps={data.taxRateBps}
      cardMode={cardMode}
    />
  );
}
