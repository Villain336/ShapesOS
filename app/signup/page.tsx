// ShapesOS — create an email account (Phase 6). Server wrapper: passes the
// public CAPTCHA config, whether email sign-in is configured on this
// deployment, and whether signup is invite-only (copy only; the API enforces).

import SignupClient from "./SignupClient";
import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { emailAuthEnabled } from "@/lib/auth/email/mail";
import { signupMode } from "@/lib/auth/signup";

export const metadata = { title: "Create your account — ShapesOS" };

export default function SignupPage() {
  return <SignupClient captcha={publicCaptchaConfig()} enabled={emailAuthEnabled()} inviteOnly={signupMode() === "invite"} />;
}
