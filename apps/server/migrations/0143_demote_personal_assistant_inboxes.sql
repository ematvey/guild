UPDATE agent_threads AS t
SET execution_role = 'thread'
FROM agents AS a
WHERE t.agent_id = a.id AND t.execution_role = 'inbox' AND a.is_personal;
