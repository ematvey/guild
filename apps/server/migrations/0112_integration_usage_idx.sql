-- The integrations page reads an integration's calls over a time window
-- from the integration.tool_called audit events.
CREATE INDEX IF NOT EXISTS events_integration_calls_idx
  ON events (org_id, (payload->>'slug'), created_at DESC)
  WHERE kind = 'integration.tool_called';
