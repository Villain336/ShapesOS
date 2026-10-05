// ShapesOS — Phase 10 (portal): the signed-in client portal shell. Its own
// minimal layout (no workspace sidebar, no workspace session): canvas page,
// white header with the agency's name, the client's sections and sign out.
// Every page below re-checks the portal session itself (portalPage()).

import { redirect } from "next/navigation";
import { portalPagePrincipal } from "@/lib/portal/http";
import { portalSections } from "@/lib/portal/core";
import { PortalNav } from "@/components/portal/PortalNav";
import { SignOutButton } from "@/components/portal/PortalActions";

export const dynamic = "force-dynamic";

export default async function PortalAppLayout({ children }: { children: React.ReactNode }) {
  const p = await portalPagePrincipal();
  if (!p) redirect("/portal/login");
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="border-b border-line bg-paper">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="aos-subheading">{p.workspaceName}</div>
              <div className="text-sm text-muted">
                Client portal for {p.clientName} · <span className="aos-mono">{p.email}</span>
              </div>
            </div>
            <SignOutButton />
          </div>
          <PortalNav sections={portalSections(p.role)} />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
