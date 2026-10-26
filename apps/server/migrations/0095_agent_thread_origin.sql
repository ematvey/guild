-- A thread an agent opens for the user records the thread it was opened
-- from, so the agent can read the run behind a delivered message and the
-- client can link back to it. This is provenance, not delegation:
-- parent_thread_id stays the subagent tree edge.

ALTER TABLE agent_threads
  ADD COLUMN IF NOT EXISTS origin_thread_id UUID REFERENCES agent_threads(id) ON DELETE SET NULL;
