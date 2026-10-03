// Marketr — Revenue attribution dashboard (C2).
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { AttributionApp } from "@/components/attribution/AttributionApp";

export const metadata = { title: "Revenue Attribution — ShapesOS" };

export default async function AttributionPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <AttributionApp />;
}
