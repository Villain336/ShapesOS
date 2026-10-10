// ShapesOS — Phase 21A round 2 (WS=agentweb): which merchants have a checkout we can drive.
//
// Today none: no merchant onboarding exists, and no payment service provider is wired, so the
// resolver returns null and every signed cart ends at the typed "stopped at payment" outcome
// with the merchant's address for the person to finish. The seam is here (and tested with a
// mock ACP merchant) so that adding a merchant is data plus an adapter, not a redesign.
// Live ACP merchants and a live payment rail are UNVERIFIED-LIVE / not built.

import type { CheckoutAdapter, PaymentRail } from "./checkout";

export type AdapterResolver = (workspaceId: string, merchantOrigin: string) => Promise<{ adapter: CheckoutAdapter; rail: PaymentRail } | null>;

let resolver: AdapterResolver = async () => null;

export function setAdapterResolver(fn: AdapterResolver): void {
  resolver = fn;
}
export function resetAdapterResolver(): void {
  resolver = async () => null;
}
export const resolveMerchant: AdapterResolver = (w, o) => resolver(w, o);
