-- Read-only manual analysis must never enter the paper trade ledger or risk budget.
-- Full payload and normal RecordController audit history remain available to its owner.
CREATE TABLE IF NOT EXISTS manual_analysis_plans (LIKE analysis_reports INCLUDING ALL);
CREATE INDEX IF NOT EXISTS manual_plans_owner_idx ON manual_analysis_plans(created_by,updated_at DESC);
