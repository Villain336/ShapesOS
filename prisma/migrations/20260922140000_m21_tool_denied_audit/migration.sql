-- Milestone 21 (part C): audit event for refused connector tool invocations.
-- Enum addition is idempotent (ADD VALUE IF NOT EXISTS).
ALTER TYPE "FileChangeAction" ADD VALUE IF NOT EXISTS 'connector_tool_denied';
