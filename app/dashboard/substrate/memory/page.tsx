// Marketr — Phase 8 G3: Growth Memory root redirects to Learnings.

import { redirect } from "next/navigation";

export default function MemoryPage() {
  redirect("/dashboard/substrate/memory/learnings");
}
