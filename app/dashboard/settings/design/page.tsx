// ShapesOS — Settings → Developer → Design kit. Every Agentic OS component
// (components/aos) in every state, laid out like the five kit renders in
// docs/design/kit/ so they can be compared side by side. Any workspace
// member (viewer access); it shows sample data only.

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";
import { KitGallery } from "@/components/aos/gallery/KitGallery";

export const metadata = {
  title: "Design kit — ShapesOS",
  description: "The Agentic OS UI kit as built: every component in every state.",
};

export default async function DesignKitPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto w-full max-w-[1320px]">
      <SettingsNav />
      <header className="mb-6">
        <h1 className="aos-heading">Design kit</h1>
        <p className="mt-1 max-w-[70ch] text-md text-muted">
          The Agentic OS components as the app renders them, in every state, laid out like the kit pages in
          docs/design/kit. Sample data only. Color always means an agent&rsquo;s current state and travels with its shape.
        </p>
      </header>
      <KitGallery />
    </div>
  );
}
