-- Machine binding is project-derived: a chat is project-bound (the project
-- names the machine and folder) or fully unbound. A machine binding without
-- a project is invalid data — clear it.
UPDATE chats SET machine_id = NULL, machine_label = NULL WHERE project_id IS NULL;
