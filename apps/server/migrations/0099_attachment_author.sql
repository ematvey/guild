-- A user upload is pending until a message references it: the row exists
-- before the user_message event, so it has no event to bind. Only an agent
-- file gets an event_id, bound when the turn's assistant event lands.
ALTER TABLE attachments ALTER COLUMN event_id DROP NOT NULL;

-- The author is known at upload time on both paths. Old user rows predate
-- author tracking; the chat owner is the author.
UPDATE attachments a
   SET author_kind = 'user', author_id = c.user_id
  FROM chats c
 WHERE c.id = a.chat_id AND a.author_kind IS NULL;

ALTER TABLE attachments ALTER COLUMN author_kind SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN author_id SET NOT NULL;
