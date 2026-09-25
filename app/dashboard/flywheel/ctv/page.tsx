// Marketr — CTV/commercials buying path (Phase 7 F4).
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { CtvApp } from "@/components/flywheel/CtvApp";

export const metadata = { title: "CTV Buying Path — Marketr" };

export default async function CtvPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <CtvApp />;
}
