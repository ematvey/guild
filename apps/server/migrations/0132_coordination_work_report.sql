ALTER TABLE agent_runs
  ADD COLUMN work_report_state text,
  ADD COLUMN work_report_summary text,
  ADD COLUMN work_report_question text,
  ADD COLUMN work_reported_at timestamptz,
  ADD CONSTRAINT coordination_work_report_state CHECK (
    (work_report_state IS NULL AND work_report_summary IS NULL
      AND work_report_question IS NULL AND work_reported_at IS NULL)
    OR (work_report_state IS NOT NULL
      AND work_report_state IN ('progress', 'ready', 'waiting', 'blocked', 'failed')
      AND work_report_summary IS NOT NULL AND work_reported_at IS NOT NULL
      AND (work_report_question IS NULL OR work_report_state = 'blocked')));
