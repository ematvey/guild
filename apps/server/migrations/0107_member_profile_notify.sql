-- A change to a member's own account (role, name, avatar, onboarding flag)
-- repaints that member's open clients: the update notifies the user's
-- workspace channel with the `member` part, which the feed answers with a
-- `member_profile` frame.
CREATE OR REPLACE FUNCTION guild_notify_member_profile() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'guild_workspace',
    json_build_object('org_id', NEW.org_id, 'user_id', NEW.id, 'parts', json_build_array('member'))::text
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_profile_notify ON users;

CREATE TRIGGER users_profile_notify AFTER UPDATE OF role, email, display_name, avatar_url, onboarded_at ON users
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.email IS DISTINCT FROM NEW.email
    OR OLD.display_name IS DISTINCT FROM NEW.display_name
    OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
    OR OLD.onboarded_at IS DISTINCT FROM NEW.onboarded_at
  )
  EXECUTE FUNCTION guild_notify_member_profile();
