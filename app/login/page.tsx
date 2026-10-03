// ShapesOS — sign-in page (server wrapper). Passes the PUBLIC CAPTCHA config
// (provider + site key, never the secret) to the client form; null when no
// CAPTCHA provider is configured (lib/auth/captcha.ts).

import LoginClient from "./LoginClient";
import { publicCaptchaConfig } from "@/lib/auth/captcha";

export const metadata = { title: "Sign in — ShapesOS" };

export default function LoginPage() {
  return <LoginClient captcha={publicCaptchaConfig()} />;
}
