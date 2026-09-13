-- Client tools renamed to their registry names: read→read_file,
-- bash→execute, edit→edit_file, write→write_file. Stored user approval
-- policies carry the old keys as overrides; rewrite them so trust survives
-- the rename (an unmapped key would silently fall back to Ask).
UPDATE users SET approval = jsonb_build_object(
  'default', approval->'default',
  'overrides', COALESCE((
    SELECT jsonb_object_agg(
      CASE k
        WHEN 'read' THEN 'read_file'
        WHEN 'bash' THEN 'execute'
        WHEN 'edit' THEN 'edit_file'
        WHEN 'write' THEN 'write_file'
        ELSE k
      END,
      v)
    FROM jsonb_each(COALESCE(approval->'overrides', '{}'::jsonb)) AS e(k, v)
  ), '{}'::jsonb)
)
WHERE approval IS NOT NULL;
