-- Phase 7 F4: add CTV audit action kinds to the FlywheelAuditKind enum.
-- Additive only (ALTER TYPE ... ADD VALUE); applied directly to the live
-- preview DB and recorded in _prisma_migrations.
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'creative_validated';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'campaign_created';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'campaign_paused';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'spot_kit_minted';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'io_created';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'io_state_transition';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'io_brief_generated';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'vibe_call';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'vibe_budget_move_rejected';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'concierge_pause_alerted';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'seat_status_checked';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'seat_action_rejected';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'attribution_viewed';
ALTER TYPE "FlywheelAuditKind" ADD VALUE 'pixel_impression';
