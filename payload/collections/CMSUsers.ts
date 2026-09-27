import type { CollectionConfig } from "payload";

/**
 * CMSUsers — Payload admin operators (Phase 12).
 *
 * Deliberately named `cms_users` (not `users`) so the Payload auth surface
 * stays namespaced away from Marketr's own auth (`/api/auth/*`, next-auth).
 * First operator is created by `scripts/seed-payload.ts` from the .env
 * ADMIN_EMAIL / ADMIN_PASSWORD; afterwards create-first-user is disabled by
 * the presence of that user.
 */
export const CMSUsers: CollectionConfig = {
  slug: "cms_users",
  auth: {
    tokenExpiration: 7200,
    verify: false,
    maxLoginAttempts: 5,
    lockTime: 600_000,
  },
  admin: {
    useAsTitle: "email",
    defaultColumns: ["email", "name", "createdAt"],
    group: "Admin",
  },
  access: {
    // Only logged-in CMS operators can manage operators.
    create: ({ req }) => Boolean(req.user),
    read: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  fields: [
    {
      name: "name",
      type: "text",
    },
  ],
};
