-- A pin is optional. NULL means "follow the latest published version": the
-- install row only records that the user wants the skill, and the served
-- version advances on every publish until the user pins one.
ALTER TABLE skill_installs ALTER COLUMN pinned_version DROP NOT NULL;
