-- Phase 17 slice 2: payment due date on invoices (drives the overdue sweep).
ALTER TABLE ops_invoices ADD COLUMN due_at TIMESTAMPTZ;
