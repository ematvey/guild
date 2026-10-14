ALTER TABLE registry_items
  ADD COLUMN owner_user_id uuid REFERENCES users(id),
  ADD COLUMN owner_team_id uuid REFERENCES teams(id),
  ADD COLUMN maintainer_gated boolean NOT NULL DEFAULT false,
  ADD COLUMN tombstoned_at timestamptz,
  ADD COLUMN forked_from text;

ALTER TABLE registry_versions
  ADD COLUMN skill_md_text text,
  ADD COLUMN files jsonb;

CREATE TABLE skill_installs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id),
  user_id uuid NOT NULL REFERENCES users(id),
  slug text NOT NULL,
  pinned_version text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);
