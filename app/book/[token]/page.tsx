// Marketr — public booking page (R5).
import { BookingWidget } from "@/components/calls/BookingWidget";

export const metadata = { title: "Book a time — Marketr" };

export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BookingWidget token={token} />;
}
