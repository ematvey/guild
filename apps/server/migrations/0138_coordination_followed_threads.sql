CREATE TABLE agent_coordination_followed_threads (
  worker_thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  source_thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  PRIMARY KEY (worker_thread_id, source_thread_id),
  CHECK (worker_thread_id <> source_thread_id)
);

CREATE INDEX coordination_followed_source ON agent_coordination_followed_threads(source_thread_id);
