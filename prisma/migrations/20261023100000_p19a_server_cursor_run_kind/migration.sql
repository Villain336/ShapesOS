-- ShapesOS Phase 19A (WS=server): the agentic cursor's run kind.
-- In its own migration: a new enum value cannot be used in the transaction
-- that adds it.

-- AlterEnum
ALTER TYPE "AgentRunKind" ADD VALUE 'cursor';
