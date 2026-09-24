// Marketr — R4 review engine dashboard.
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ReviewsApp } from "@/components/reviews/ReviewsApp";

export const metadata = { title: "Reviews — Marketr" };

export default async function ReviewsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <ReviewsApp />;
}
