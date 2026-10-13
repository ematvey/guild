-- Composer approval modes adopt the codex vocabulary (2026-09-14):
-- "allow" becomes "full_access" (unrestricted), "never" is dropped entirely
-- (chat-level deny removed; the account policy remains the place for a hard
-- deny, so the key falls back to the owner's policy), "ask" is unchanged,
-- and the new "approve_for_me" (AI auto-approval policy) has no legacy value.
UPDATE chats
SET approval = jsonb_set(approval, '{default}', '"full_access"'::jsonb, true)
WHERE approval->>'default' = 'allow';

UPDATE chats
SET approval = approval - 'default'
WHERE approval->>'default' = 'never';
