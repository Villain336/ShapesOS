// Marketr — Wave B: the M20 Buffer-based project social studio is retired.
// Single Postiz-centered entry lives at /dashboard/social. This route
// redirects there (kept for bookmarks/deep links).

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ProjectSocialRedirect() {
  redirect("/dashboard/social");
}
