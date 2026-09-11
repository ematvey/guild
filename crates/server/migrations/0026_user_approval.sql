-- Approval policy moves from per-chat (chats.approval, 0023) to per-user:
-- tool-execution trust is a property of the user and their bound machine,
-- not of an individual conversation. Existing per-chat policies are dropped
-- with the column; a NULL user policy means the server default is in effect
-- (default Ask, read-only tools allowed).
-- Shape mirrors guild-core ApprovalPolicy:
--   {"default": "ask"|"allow"|"never", "overrides": {"read": "allow"}}
ALTER TABLE users ADD COLUMN approval JSONB;
ALTER TABLE chats DROP COLUMN approval;
