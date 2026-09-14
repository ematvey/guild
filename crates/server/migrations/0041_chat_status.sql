-- Thread-list status: a server-side generating flag on the chat (flipped by
-- the ChatRunner workflow in journaled steps) and per-(chat, user) read
-- markers. Unread is derived at list time: an assistant turn newer than the
-- marker on a non-generating chat.
ALTER TABLE chats ADD COLUMN generating BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE chat_reads (
    chat_id            UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_event_id UUID NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);
