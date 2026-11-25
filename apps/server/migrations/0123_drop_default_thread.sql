-- A Thread is not special because its Agent made it with its creator: the
-- creator's first Thread is an ordinary Thread of that Agent. The assistant
-- inbox keeps its own identity through execution_role.
ALTER TABLE agent_threads DROP COLUMN is_default;
