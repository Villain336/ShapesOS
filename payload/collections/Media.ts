import path from "node:path";
import type { CollectionConfig } from "payload";

/**
 * Media — upload collection (Phase 12).
 *
 * Files land in `public/media/` (durable, under ~/workspace/marketr) and are
 * served by Next at `/media/<filename>`. Only images are accepted for now.
 */
export const Media: CollectionConfig = {
  slug: "media",
  admin: {
    group: "Content",
  },
  access: {
    read: () => true,
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  upload: {
    staticDir: path.resolve(process.cwd(), "public", "media"),
    mimeTypes: ["image/*"],
  },
  fields: [
    {
      name: "alt",
      type: "text",
      required: true,
    },
  ],
};
