// ShapesOS — Phase 10 (portal): landing page for emailed client-portal links
// (/portal/link#token=…). The token is only used when the person presses the
// button, so a mail scanner that fetches the link can't spend it.

import PortalLinkClient from "./PortalLinkClient";

export const metadata = { title: "Open your client portal — ShapesOS" };

export default function PortalLinkPage() {
  return <PortalLinkClient />;
}
