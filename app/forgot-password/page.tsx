// ShapesOS — ask for a password reset link (Phase 6).

import ForgotClient from "./ForgotClient";
import { publicCaptchaConfig } from "@/lib/auth/captcha";
import { emailAuthEnabled } from "@/lib/auth/email/mail";

export const metadata = { title: "Reset your password — ShapesOS" };

export default function ForgotPasswordPage() {
  return <ForgotClient captcha={publicCaptchaConfig()} enabled={emailAuthEnabled()} />;
}
