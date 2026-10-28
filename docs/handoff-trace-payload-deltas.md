# Handoff — trace payload deltas

Status: implemented on `develop`, not deployed. Prod runs the full-body
version. Payload capture is on unless `GUILD_TRACE_PAYLOADS=0`.

## Why

Trace payload capture stores the raw model request for every call. The
request carries the whole message history, so a turn with N steps wrote the
same history N times. Measured on prod trace `01a182f7`: five requests of
43, 46, 48, 50 and 52 KB for one conversation. Cost grows with steps ×
context.

## What changed

A request now stores only the messages its predecessor in the same trace did
not carry. The read path rebuilds the full body.

- `llm_payloads` gets two columns: `parent_request_id UUID` and
  `prefix_count UInt32`. `prefix_count = 0` means a full body. Existing rows
  keep that meaning, so old data still reads.
- New table `llm_payload_chains(ts, org_id, trace_id, request_id,
  message_count, last_hash)`, ordered by `(org_id, trace_id, ts,
  request_id)`. It is the write-path index: the payload table is ordered by
  request id, so a parent lookup there would scan the whole table on every
  model call.
- Write path (`TraceStore.recordPayload`): parse the body, find the newest
  request of the trace, and accept it as parent only when the new request
  has at least as many messages and the parent's last message hashes the
  same. Then store the tail and the parent id. Otherwise store a full body.
- Read path (`TraceStore.payloads`): walk `parent_request_id` to the root,
  concatenate the tails in order, and return the same `{kind, body}` shape
  the activity API already serves.
- The chain key is the run id, else the chat id, else the request id. It is
  passed by the gateway (`openai.ts`) and by the approval judge
  (`approvals.ts`).

## Files

- `apps/server/src/platform/trace.ts` — DDL, delta write, chain rebuild.
- `apps/server/src/platform/http/openai.ts` — passes the chain key.
- `apps/server/src/harness/approvals.ts` — passes the chain key for the judge.
- `apps/server/src/test/trace.test.ts` — delta chain test: three steps,
  stored sizes, rebuilt history, and the full-body fallback.

## Known limits

- The prefix check compares the parent's last message hash, not the whole
  prefix. A request that rewrites the middle of the history but keeps the
  last message is stored as a delta and rebuilds wrong. The harness never
  does that today.
- `recordPayload` is fire-and-forget. Two calls of the same trace that land
  at the same moment can miss the parent and store a full body. Cost, not
  correctness.
- A request with no messages (or an unparsable body) is stored as a full
  body.
- Both tables keep the 14-day TTL, but the parent is older, so it can
  expire minutes before its child. A chain read in that window stops at a
  delta and shows a partial history. Fix if it matters: store the root's
  expiry on every row of the chain and TTL by that value.
- Rollback is not safe. An older server reads a delta row as if it were a
  full body and shows only the tail. Deploy forward only, or clear the
  traces tables before a rollback.
- Rows written before this change have `prefix_count = 0` and read exactly
  as before. The first request of a trace after the deploy is a new root,
  because the chain table has no row for it.
- `llm_payload_chains` is new, so no migration is needed. The two
  `llm_payloads` columns are added by `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS` on first use.

## To ship

1. Merge `develop` to `master`.
2. Rebuild the stack (`docs/deploy-nuances.md` §2) and check
   `/api/v1/health`.
3. Open a new run with at least three model calls. The trace detail must
   show the full message list in the Input pane of each call, and the stored
   request rows must shrink after the first call.

## Verify on ClickHouse

```sql
SELECT request_id, prefix_count, length(body)
FROM llm_payloads
WHERE org_id = toUUID('<org>') AND kind = 'request'
ORDER BY ts DESC LIMIT 10;
```
