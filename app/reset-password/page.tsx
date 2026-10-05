// ShapesOS — choose a new password from an emailed reset link (Phase 6).
// The token arrives in the URL fragment (#token=…) and is read client-side.

import ResetClient from "./ResetClient";

export const metadata = { title: "Choose a new password — ShapesOS" };

export default function ResetPasswordPage() {
  return <ResetClient />;
}
