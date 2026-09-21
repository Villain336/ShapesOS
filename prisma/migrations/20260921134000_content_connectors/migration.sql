-- Marketr milestone 8: WordPress + Webflow content connectors.
-- Extends SiteSourceType with content-level sources. Secrets (WP application
-- passwords, Webflow API tokens) stay in sites.config_enc (AES-256-GCM),
-- exactly like the milestone-7 GitHub tokens.
ALTER TYPE "SiteSourceType" ADD VALUE IF NOT EXISTS 'wordpress';
ALTER TYPE "SiteSourceType" ADD VALUE IF NOT EXISTS 'webflow';
