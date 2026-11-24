-- A physical deletion removes the selected Conversation from its watch.
CREATE FUNCTION guild_activity_chat_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('guild_activity_conversation', OLD.id::text);
  RETURN NULL;
END
$$;

CREATE TRIGGER activity_chat_deleted
AFTER DELETE ON chats
FOR EACH ROW EXECUTE FUNCTION guild_activity_chat_deleted();
