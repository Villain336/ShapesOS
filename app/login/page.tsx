// ShapesOS — sign-in page (server wrapper). Passes the PUBLIC CAPTCHA config
// (provider + site key, never the secret) to the client form; null when no
// CAPTCHA provider is configured (lib/auth/captcha.ts). Phase 6: whether the
// email sign-in options show (lib/auth/email/mail.ts emailAuthEnabled — off in
// production without a mailer).

import LoginClient from "./LoginClient";
import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { emailAuthEnabled } from "@/lib/auth/email/mail";

export const metadata = { title: "Sign in — ShapesOS" };

export default function LoginPage() {
  return <LoginClient captcha={publicCaptchaConfig()} emailAuth={emailAuthEnabled()} />;
}
