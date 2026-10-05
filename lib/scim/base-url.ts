// ShapesOS — absolute base URL for SCIM meta.location / $ref values.
import { appBaseUrl } from "@/lib/workspace/invite-mail";

export function scimBaseUrl(req: Request): string {
  const origin = new URL(req.url).origin;
  return appBaseUrl(process.env, origin) ?? origin;
}
