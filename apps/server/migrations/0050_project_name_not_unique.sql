-- Project names are derived from the chosen folder's basename, so they are
-- display labels, not keys — duplicates are natural and allowed.
ALTER TABLE projects DROP CONSTRAINT projects_user_id_name_key;
