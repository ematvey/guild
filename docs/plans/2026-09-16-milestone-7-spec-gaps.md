# Milestone 7 — spec-completion audit items

Status: COMPLETE

(All tasks done on feat/milestone-7. Accepted gaps documented in the plan:
Restate forced-replay CI test remains open; org-event trigger_kind for
routines deferred — events are emitted and streamed, but webhook/interval
remain the only routine triggers.) (branch `feat/milestone-7`, on top of master @ d7914e8)

The six milestones (spec §10) are complete, but the audit against the spec
body found v1 requirements that were never implemented. This milestone closes
them.

## Audit findings (spec § → evidence)

1. **OIDC SSO** (§4.1, §5 `oidc_configs`) — MISSING. `auth.rs` explicitly
   deferred it; only managed accounts exist. v1 Goal #3 says "managed
   accounts + OIDC SSO".
2. **Model route quotas** (§4.2 "with quotas", §4.5 "Org-level quotas …
   enforced in the gateway by checking recent usage") — MISSING. Routes carry
   prices only.
3. **Attachments** (§4.3, §5 `attachments` table, object storage refs) —
   MISSING (no table, no endpoints).
4. **Registry kind `integration` install** (§4.4 "installing one activates
   its trigger") — schema allows the kind, but install does nothing for it.
5. **Org-event triggers + events to subscribed clients** (§4.6) — MISSING.
6. **Realtime fan-out via Postgres LISTEN/NOTIFY** (§4.8 "now") — MISSING.
7. **TS types generated from `protocol`** (§6) — MISSING (hand-written TS in
   apps). Low value until a consumer drifts; document or generate.
8. §8 Restate replay tests — partially covered (determinism enforced by
   journaling design; no forced-replay CI test). Accepted gap for now.

## Tasks

- **T1 OIDC SSO**: migration `0010_oidc.sql` (`oidc_configs`: org-unique
  issuer/client_id/encrypted client_secret). Admin API PUT/GET
  `/api/v1/admin/oidc`. `GET /api/v1/auth/oidc/login` → 302 to IdP with
  HMAC-signed state (jwt secret); `GET /api/v1/auth/oidc/callback` → code
  exchange via discovery, userinfo → provision `identity_type='oidc'` user
  (member) + session. Tests: fake IdP over wiremock (discovery, token,
  userinfo), full round trip, disabled-config → 404, wrong state → 401.
- **T2 quotas**: `model_routes.quota_monthly_usd` nullable; gateway rejects
  when month-to-date ClickHouse usage ≥ quota (OpenAI 429-style response on
  the public endpoint, error envelope internally). Tests: route with tiny
  quota + existing usage → rejected; higher usage clears → passes.
- **T3 attachments**: `0011_attachments.sql` (id, org, chat, key, filename,
  content_type, size, created_at); `POST /api/v1/chats/{id}/attachments`
  (raw body → object store `attachments/{org}/{key}`), GET list, GET download
  (org-scoped). Message rows may reference attachment keys in content.
- **T4 registry integrations**: `POST /api/v1/registry/{kind}/{slug}/install`
  for kind=integration creates a disabled routine from the bundle's manifest
  (prompt/model/trigger config), reusing the routines plumbing; routine edit
  + enable flow finishes activation.
- **T5 events + fan-out**: `events` table (org, kind, payload, created_at);
  org-event triggers emit on skill publish + member join; LISTEN/NOTIFY
  channel `guild_events` + `GET /api/v1/events/stream` (SSE) subscribed per
  org; webhook routines can be triggered by events (trigger_kind 'event' is
  out of scope for v1 unless cheap).
- **T6 TS generation**: quick ts-rs or hand-synced check; if ts-rs is heavy,
  add a protocol round-trip test asserting the TS file matches exported JSON
  fixtures (spec §8 "Rust ↔ TS types stay in lockstep").

## Deferred decisions (user-directed)

- **MinIO is placeholder object storage** — to be replaced in the future.
  The server speaks plain S3 via `object_store` (`GUILD_S3_URL`,
  `GUILD_S3_BUCKET`, key id/secret), so any S3-compatible backend (or a
  purpose-built store) is a config-only swap. Compose's `minio` +
  `minio-init` services are the only MinIO-specific pieces.

## Verification

- `cargo test --workspace`, `cargo test -p guild-server --features test-support`
- `cargo clippy --workspace --all-targets -- -D warnings`, fmt clean
- compose smoke per task where integration-level (OIDC callback flow,
  quota rejection, attachment round-trip).
