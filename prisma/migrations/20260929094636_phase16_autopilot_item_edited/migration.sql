-- Phase 16 slice 3: audit action for generative-approval-card edits
-- (update-then-requeue-pending on AutopilotItem).
ALTER TYPE "FileChangeAction" ADD VALUE 'autopilot_item_edited';
