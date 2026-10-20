// ShapesOS — Phase 18.2 (WS=comms): Direct mail moved to /dashboard/direct-mail
// so /dashboard/mail is the Mail app. Old links to this page keep working.
import { redirect } from "next/navigation";

export default function MovedDirectMailEddmPage() {
  redirect("/dashboard/direct-mail/eddm");
}
