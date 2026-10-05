// ShapesOS — landing page for emailed sign-in links (Phase 6): verification
// and magic links both arrive at /login/link#token=…. The token is only used
// when the person presses the button, so a mail scanner that fetches (or
// even renders) the link can't spend it.

import LinkClient from "./LinkClient";

export const metadata = { title: "Sign in with your email link — ShapesOS" };

export default function EmailLinkPage() {
  return <LinkClient />;
}
