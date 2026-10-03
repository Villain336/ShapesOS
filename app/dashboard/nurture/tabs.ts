// ShapesOS — Nurture tab ids. Server-safe (no "use client") so the page can
// parse `?tab=` deep links, e.g. the CRM lead panel's "Review" toast →
// /dashboard/nurture?tab=approvals.

export const NURTURE_TABS = ["sequences", "broadcasts", "enrollments", "approvals", "log", "consent"] as const;
export type NurtureTab = (typeof NURTURE_TABS)[number];

export function parseNurtureTab(v: string | undefined): NurtureTab {
  return (NURTURE_TABS as readonly string[]).includes(v ?? "") ? (v as NurtureTab) : "sequences";
}
