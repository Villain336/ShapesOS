-- Phase A (fix 5): audit event for rejected file uploads (type/scan failures).
-- Enum addition is idempotent (ADD VALUE IF NOT EXISTS).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'file_rejected';
