-- One live project per (machine, folder): the executor runs agents inside
-- the folder, so two live bindings on the same tree would drive one working
-- tree from two projects. Comparison folds case (Windows paths differ in
-- case freely) and ignores trailing separators (pickers canonicalize
-- differently). Archived rows step aside and free the folder for re-binding.
-- Pre-existing duplicates are archived, keeping the oldest live row per
-- (machine, folder) — the one existing chats most plausibly belong to;
-- archiving (not deleting) keeps every chat's binding intact.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY machine_id, lower(rtrim(folder, '\/'))
               ORDER BY created_at, id
           ) AS rn
    FROM projects
    WHERE archived_at IS NULL
)
UPDATE projects SET archived_at = now()
FROM ranked
WHERE projects.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS projects_live_machine_folder_uniq
    ON projects (machine_id, lower(rtrim(folder, '\/')))
    WHERE archived_at IS NULL;
