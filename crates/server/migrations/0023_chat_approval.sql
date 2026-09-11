-- Phase 2 approvals (docs/plans/2026-09-12-approvals-design.md §A):
-- per-chat approval policy stored on the chat row.
-- NULL means the server default policy is in effect.
-- Shape mirrors guild-core ApprovalPolicy:
--   {"default": "ask"|"allow"|"never", "overrides": {"read": "allow"}}
ALTER TABLE chats ADD COLUMN IF NOT EXISTS approval JSONB;
