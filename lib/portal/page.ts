// ShapesOS — Phase 10 (portal): page guard for /portal server pages. Signed
// out → /portal/login; a section the client's role doesn't include → the
// overview. Never consults the workspace session.

import { redirect } from "next/navigation";
import { portalPagePrincipal } from "./http";
import { portalSees, type PortalSection } from "./core";
import type { PortalPrincipal } from "./store";

export async function portalPage(section?: PortalSection): Promise<PortalPrincipal> {
  const p = await portalPagePrincipal();
  if (!p) redirect("/portal/login");
  if (section && !portalSees(p.role, section)) redirect("/portal");
  return p;
}
