// ShapesOS — Phase 10 (portal): /portal/login. A client enters the email
// their agency set up for them and gets a single-use sign-in link. The same
// answer whether or not the address is a client (no enumeration).

import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { emailAuthEnabled } from "@/lib/auth/email/mail";
import PortalLoginClient from "./PortalLoginClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Client portal sign-in — ShapesOS" };

export default function PortalLoginPage() {
  return <PortalLoginClient captcha={publicCaptchaConfig()} enabled={emailAuthEnabled()} />;
}
