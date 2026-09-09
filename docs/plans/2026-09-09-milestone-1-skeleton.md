# Guild Milestone 1 — Skeleton Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workspace scaffolding; guild-server and guild-app-server both run; managed-account login; one chat round-trip through the gateway with SSE streaming; history persisted; per-request usage events with cost.

**Architecture:** Cargo workspace with `protocol` (shared types), `guild-core` (provider client traits), `app-server` (local engine with a headless chat path), `server` (axum API tier). Postgres for records, ClickHouse for usage events. Desktop Tauri shell with login + one chat view wired to app-server over stdio JSON-RPC. Compose bundle runs Postgres + ClickHouse + MinIO + server.

**Tech Stack:** Rust 1.97 (tokio, axum 0.8, sqlx 0.8, argon2, aes-gcm, reqwest 0.12, eventsource-stream, clickhouse crate, testcontainers-modules), Tauri v2, React + TypeScript + shadcn/ui, npm.

**Spec:** `docs/specs/2026-09-09-guild-design.md` (sections 2, 3.2, 4.1, 4.2, 4.3, 4.5, 4.9, 5, 6, 7, 10-M1)

## Global Constraints

- Rust edition 2021, workspace `resolver = "2"`, `cargo fmt` + `cargo clippy -D warnings` clean on every commit.
- All HTTP endpoints under `/api/v1/...`; single error envelope `{"error": {"code": string, "message": string}}` (from spec §7).
- JSON-RPC envelopes carry `"protocol": 1` on every message (spec §6).
- Managed-account passwords hashed with argon2id; provider keys encrypted at rest with AES-256-GCM using a master key from config (spec §4.2).
- Every model request writes exactly one `usage_event` to ClickHouse (spec §4.5).
- Tests that need Postgres or ClickHouse use testcontainers; no test may depend on a long-running local service.
- No public OpenAI-compatible endpoint, no registry, no integrations, no webui app in M1 (later milestones).

---

### Task 1: Cargo workspace scaffold

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `.gitignore`, `crates/protocol/Cargo.toml`, `crates/protocol/src/lib.rs`, `crates/guild-core/Cargo.toml`, `crates/guild-core/src/lib.rs`, `crates/app-server/Cargo.toml`, `crates/app-server/src/main.rs`, `crates/server/Cargo.toml`, `crates/server/src/main.rs`

**Interfaces:**
- Produces: workspace with members `crates/protocol`, `crates/guild-core`, `crates/app-server`, `crates/server`; `cargo test` and `cargo clippy --workspace` pass.

- [ ] **Step 1: Write workspace `Cargo.toml`**

```toml
[workspace]
resolver = "2"
members = [
    "crates/protocol",
    "crates/guild-core",
    "crates/app-server",
    "crates/server",
]

[workspace.package]
edition = "2021"
version = "0.1.0"
license = "Apache-2.0"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
thiserror = "2"
axum = "0.8"
tower = "0.5"
sqlx = { version = "0.8", features = ["runtime-tokio", "tls-rustls", "postgres", "uuid", "chrono", "migrate"] }
uuid = { version = "1", features = ["v4", "v7", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
reqwest = { version = "0.12", features = ["json", "stream"] }
eventsource-stream = "0.2"
argon2 = "0.5"
aes-gcm = "0.10"
rand = "0.8"
rand_core = { version = "0.6", features = ["os_rng"] }
hex = "0.4"
async-trait = "0.1"
futures = "0.3"
testcontainers-modules = { version = "0.24", features = ["postgres", "clickhouse"] }
```

- [ ] **Step 2: Create member crates**

`crates/protocol/Cargo.toml`:

```toml
[package]
name = "protocol"
workspace = true
version.workspace = true
edition.workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true
```

`crates/protocol/src/lib.rs`:

```rust
//! Shared protocol types: local JSON-RPC and cloud API schemas.
```

`crates/guild-core/Cargo.toml`:

```toml
[package]
name = "guild-core"
workspace = true
version.workspace = true
edition.workspace = true

[dependencies]
protocol = { path = "../protocol" }
```

`crates/guild-core/src/lib.rs`:

```rust
//! Agent loop, tools, provider client types.
```

`crates/app-server/Cargo.toml`:

```toml
[package]
name = "guild-app-server"
workspace = true
version.workspace = true
edition.workspace = true

[dependencies]
guild-core = { path = "../guild-core" }
protocol = { path = "../protocol" }
tokio.workspace = true
serde.workspace = true
serde_json.workspace = true
anyhow.workspace = true
```

`crates/app-server/src/main.rs`:

```rust
fn main() -> anyhow::Result<()> {
    println!("guild-app-server");
    Ok(())
}
```

`crates/server/Cargo.toml`:

```toml
[package]
name = "guild-server"
workspace = true
version.workspace = true
edition.workspace = true

[dependencies]
protocol = { path = "../protocol" }
guild-core = { path = "../guild-core" }
tokio.workspace = true
serde.workspace = true
serde_json.workspace = true
anyhow.workspace = true
thiserror.workspace = true
axum.workspace = true
tower.workspace = true
```

`crates/server/src/main.rs`:

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!("guild-server");
    Ok(())
}
```

`.gitignore`:

```
/target
node_modules
dist
.env
*.local
```

- [ ] **Step 3: Verify build, test, clippy**

Run: `cargo fmt --all && cargo build --workspace && cargo test --workspace && cargo clippy --workspace -- -D warnings`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: cargo workspace scaffold with four crates"
```

---

### Task 2: protocol crate — JSON-RPC envelope + cloud API types

**Files:**
- Modify: `crates/protocol/src/lib.rs`
- Create: `crates/protocol/src/rpc.rs`, `crates/protocol/src/api.rs`
- Test: `crates/protocol/src/rpc.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces (used by Tasks 3, 9, 12):
  - `rpc::Request { jsonrpc: "2.0", id: u64, protocol: u32, method: String, params: serde_json::Value }`
  - `rpc::Response { jsonrpc, id, protocol, result: Result<Value, rpc::RpcError> }`
  - `rpc::Event { protocol: u32, event: String, payload: serde_json::Value }`
  - `rpc::ClientConnection` — `write_request` / `read_message` over any `BufRead + Write` pair (framed one-JSON-per-line, stdio-friendly)
  - `api::LoginRequest { email, password }`, `api::LoginResponse { token, user: api::UserInfo }`, `api::UserInfo { id: Uuid, email, org_id: Uuid, role: String }`
  - `api::CreateChatRequest { title: Option<String> }`, `api::Chat { id, title, created_at }`
  - `api::ChatCompletionRequest { chat_id: Uuid, model: String, messages: Vec<api::Message> }`, `api::Message { role: String, content: String }`
  - `api::StreamEvent` — serde-tagged enum: `delta { content }`, `done { message_id, cost_usd: f64, tokens_in: u32, tokens_out: u32 }`, `error { code, message }`

- [ ] **Step 1: Write failing round-trip tests in `crates/protocol/src/rpc.rs`**

```rust
use crate::rpc::*;
use serde_json::json;

#[test]
fn request_serializes_with_protocol_field() {
    let r = Request { id: 1, protocol: 1, method: "chat.send".into(), params: json!({"text": "hi"}) };
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["protocol"], 1);
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["method"], "chat.send");
    assert_eq!(v["params"]["text"], "hi");
}

#[test]
fn connection_roundtrips_request_and_event() {
    let mut client_buf: Vec<u8> = Vec::new();
    let wire = {
        let mut conn = Connection::new(&mut client_buf, std::io::empty().lock());
        conn.write_request(&Request { id: 7, protocol: 1, method: "ping".into(), params: json!(null) }).unwrap();
        conn.take_written()
    };
    let line = String::from_utf8(wire).unwrap();
    assert!(line.trim_end().ends_with('}'));
    assert!(serde_json::from_str::<Request>(&line).is_ok());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p protocol`
Expected: FAIL — `Request`, `Connection` not defined.

- [ ] **Step 3: Implement `rpc.rs`**

```rust
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub jsonrpc: &'static str, // always "2.0" — serialize via const; see impl below
    pub id: u64,
    pub protocol: u32,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

impl Request {
    pub fn new(id: u64, method: impl Into<String>, params: serde_json::Value) -> Self {
        Self { jsonrpc: "2.0", id, protocol: PROTOCOL_VERSION, method: method.into(), params }
    }
}
```

Note: `&'static str` does not deserialize; use `String` with a custom `new` that fills `"2.0"` and a validation `ensure_jsonrpc()` called by the server loop. Simplify to:

```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub protocol: u32,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}
```

`Response` and `Event` follow the same shape (spec §6). `RpcError { code: i64, message: String, data: Option<Value> }` with standard JSON-RPC codes.

`Connection` writes one compact JSON per line and reads one line per message:

```rust
pub struct Connection<R: BufRead, W: Write> {
    reader: BufReader<R>,
    writer: Mutex<W>,
}

impl<R: BufRead, W: Write> Connection<R, W> {
    pub fn new(reader: R, writer: W) -> Self { /* wrap reader in BufReader, writer in Mutex */ }
    pub fn write_line(&self, value: &impl Serialize) -> anyhow::Result<()> { /* serde_json::to_writer + b'\n' + flush */ }
    pub fn read_line(&mut self) -> Option<serde_json::Result<serde_json::Value>> { /* read_line, EOF -> None, trim */ }
}
```

- [ ] **Step 4: Write `api.rs` types exactly as in Interfaces above**

All types derive `Serialize, Deserialize, Debug, Clone`; ids use `uuid::Uuid` (add `uuid.workspace = true`, `chrono.workspace = true` to protocol deps).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p protocol && cargo clippy -p protocol -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/protocol && git commit -m "feat(protocol): json-rpc envelope and cloud api types"
```

---

### Task 3: server scaffold — config, health endpoint, error envelope

**Files:**
- Modify: `crates/server/src/main.rs`
- Create: `crates/server/src/config.rs`, `crates/server/src/http/mod.rs`, `crates/server/src/http/error.rs`, `crates/server/src/state.rs`
- Test: `crates/server/tests/http_scaffold.rs`

**Interfaces:**
- Consumes: nothing yet.
- Produces:
  - `config::Config { bind_addr: String, database_url: String, clickhouse_url: String, clickhouse_database: String, master_key_hex: String, jwt_secret: String }` — loaded from env vars with `GUILD_` prefix (`GUILD_BIND_ADDR`, `GUILD_DATABASE_URL`, ...) via the `envy`-style manual loader (no extra dep).
  - `http::error::ApiError { code: String, message: String }` implementing `IntoResponse` producing `{"error": {"code": "...", "message": "..."}}` with mapped status.
  - `state::AppState` (later tasks add stores).
  - `build_router(state) -> axum::Router` in `http/mod.rs` — `GET /api/v1/health` returns `{"status":"ok"}`.
  - `server::run(config)` — binds, serves; `main` loads config and calls it.

- [ ] **Step 1: Write failing test `crates/server/tests/http_scaffold.rs`**

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt; // oneshot

#[tokio::test]
async fn health_endpoint_returns_ok() {
    let state = guild_server::test_support::test_state().await;
    let app = guild_server::build_router(state);
    let res = app.oneshot(Request::builder().uri("/api/v1/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["status"], "ok");
}

#[tokio::test]
async fn unknown_route_returns_error_envelope() {
    let state = guild_server::test_support::test_state().await;
    let app = guild_server::build_router(state);
    let res = app.oneshot(Request::builder().uri("/api/v1/nope").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    assert!(body.window::<serde_json::Value>()["error"]["code"].is_string());
}
```

(`test_support` is a `#[cfg(test)]`-gated public module providing an in-memory `AppState` before stores exist; it stays for later tasks and grows DB support.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p guild-server`
Expected: FAIL — `build_router`, `test_state` not defined.

- [ ] **Step 3: Implement**

`crates/server/src/lib.rs` (move logic out of main; main calls `guild_server::main_entry()`):

```rust
pub mod config;
pub mod http;
pub mod state;

pub fn build_router(state: state::AppState) -> axum::Router { http::build_router(state) }

pub async fn main_entry() -> anyhow::Result<()> {
    let cfg = config::Config::from_env()?;
    let state = state::AppState::from_config(&cfg).await?;
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
pub mod test_support;
```

`http/mod.rs`:

```rust
pub mod error;
use crate::state::AppState;
use axum::routing::get;
use axum::{Json, Router};

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health", get(|| async { Json(serde_json::json!({"status": "ok"})) }))
        .fallback(error::not_found)
        .with_state(state)
}
```

`http/error.rs`:

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct ErrorBody { pub code: String, pub message: String }

#[derive(Debug)]
pub struct ApiError { pub status: StatusCode, pub code: String, pub message: String }

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({ "error": ErrorBody { code: self.code, message: self.message } }))).into_response()
    }
}

impl<E: std::error::Error> From<E> for ApiError where E: Send + Sync + 'static {
    fn from(e: E) -> Self { ApiError { status: StatusCode::INTERNAL_SERVER_ERROR, code: "internal".into(), message: e.to_string() } }
}

pub async fn not_found() -> ApiError {
    ApiError { status: StatusCode::NOT_FOUND, code: "not_found", message: "no such route" }
}
```

`config.rs` reads `GUILD_BIND_ADDR` (default `0.0.0.0:8080`), `GUILD_DATABASE_URL`, `GUILD_CLICKHOUSE_URL`, `GUILD_CLICKHOUSE_DATABASE` (default `guild`), `GUILD_MASTER_KEY_HEX` (64 hex chars = 32 bytes), `GUILD_JWT_SECRET`. `AppState::from_config` in this task only stores the config (stores arrive in Task 4); `test_state()` builds a `Config` with placeholder URLs.

- [ ] **Step 4: Run tests to verify pass; clippy**

Run: `cargo test -p guild-server && cargo clippy --workspace -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/server && git commit -m "feat(server): axum scaffold, health endpoint, error envelope, config"
```

---

### Task 4: Postgres store — identity tables and queries

**Files:**
- Create: `crates/server/migrations/0001_identity.sql`, `crates/server/src/store/mod.rs`, `crates/server/src/store/identity.rs`, `crates/server/src/crypto.rs`
- Modify: `crates/server/src/state.rs`, `crates/server/src/lib.rs`
- Modify: `crates/server/Cargo.toml` (add sqlx, argon2, aes-gcm, rand, rand_core, hex, uuid, chrono, testcontainers-modules as dev-dep)
- Test: `crates/server/tests/identity_store.rs`

**Interfaces:**
- Produces:
  - `store::Store { pool: sqlx::PgPool }` with `Store::connect(url)` (runs migrations via `sqlx::migrate!`), `Store::connect_test()` for tests (spins a Postgres testcontainer).
  - `store::identity::IdentityStore`:
    - `ensure_bootstrap_admin(&self, email, password) -> anyhow::Result<uuid::Uuid>` — creates org `org` + admin user only if no users exist; returns user id.
    - `create_user(&self, org_id, email, password, role) -> Result<UserRow, ApiError>` (code `email_taken` on unique violation)
    - `authenticate(&self, email, password) -> Result<UserRow, ApiError>` (code `invalid_credentials` on any miss)
    - `create_session(&self, user_id) -> Result<(Uuid /*session_id*/, String /*token*/)>`, `validate_session(&self, token) -> Result<UserRow, ApiError>` (code `unauthorized`), `revoke_session(&self, token)`
  - `UserRow { id, org_id, email, role: String }`
  - `crypto::encrypt_secret(master_key: &[u8; 32], plaintext: &str) -> String` (AES-256-GCM, random nonce, `nonce||ciphertext` hex) and `crypto::decrypt_secret(master_key, encoded) -> String`.

Schema (`0001_identity.sql`):

```sql
CREATE TABLE orgs (id UUID PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE users (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  identity_type TEXT NOT NULL DEFAULT 'managed' CHECK (identity_type IN ('managed','oidc')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
```

- [ ] **Step 1: Write failing test `crates/server/tests/identity_store.rs`**

```rust
use guild_server::store::Store;

#[tokio::test]
async fn bootstrap_admin_once_then_login_and_session() {
    let store = Store::connect_test().await;
    let admin_email = "admin@example.org";
    let user_id = store.identity().ensure_bootstrap_admin(admin_email, "hunter226").await.unwrap();
    // second call is a no-op returning the same user
    let again = store.identity().ensure_bootstrap_admin(admin_email, "other").await.unwrap();
    assert_eq!(user_id, again);

    let user = store.identity().authenticate(admin_email, "hunter226").await.unwrap();
    assert_eq!(user.role, "admin");
    assert!(store.identity().authenticate(admin_email, "wrong").await.is_err());

    let (_sid, token) = store.identity().create_session(user.id).await.unwrap();
    let validated = store.identity().validate_session(&token).await.unwrap();
    assert_eq!(validated.id, user.id);
    store.identity().revoke_session(&token).await.unwrap();
    assert!(store.identity().validate_session(&token).await.is_err());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p guild-server --test identity_store`
Expected: FAIL — `Store` not defined.

- [ ] **Step 3: Implement store, migrations, crypto**

Migrations embedded with `sqlx::migrate!("crates/server/migrations")` run in `Store::connect`. Session tokens: 32 random bytes hex. Passwords: `argon2::Argon2::default()` with random salt, PHC string stored. `validate_session` joins `sessions`+`users`, filters `revoked_at IS NULL AND expires_at > now()`, returns `UserRow`, uses `code: "unauthorized"`.

`Store::connect_test()` uses `testcontainers_modules::postgres` (image `postgres:17`, default user/password/db), loops until the container port is ready, returns a `Store` whose container is kept alive via the returned `ContainerAsync` — expose it as `TestDb { store: Store, _container: ... }` with `Deref` to `Store`, so tests hold `_db` alive.

Crypto test (inline in `crypto.rs`): round-trip plus wrong-key failure.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p guild-server && cargo clippy --workspace -- -D warnings`
Expected: PASS (identity_store, crypto, http_scaffold).

- [ ] **Step 5: Commit**

```bash
git add crates/server && git commit -m "feat(server): identity store with migrations, argon2, sessions, crypto"
```

---

### Task 5: Auth API — signup/bootstrap, login, me

**Files:**
- Create: `crates/server/src/http/auth.rs`
- Modify: `crates/server/src/http/mod.rs`, `crates/server/src/state.rs`
- Test: `crates/server/tests/auth_api.rs`

**Interfaces:**
- Consumes: `store::identity` (Task 4), `protocol::api::{LoginRequest, LoginResponse, UserInfo}` (Task 2).
- Produces:
  - `POST /api/v1/auth/bootstrap` → `{}` — bootstrap admin; `409 code: "already_bootstrapped"` if users exist.
  - `POST /api/v1/auth/login` → `LoginResponse` (`401 code: "invalid_credentials"` on miss).
  - `GET /api/v1/auth/me` with `Authorization: Bearer <token>` → `UserInfo` (`401 code: "unauthorized"`).
  - `state::AppState { store: Option<Store>, config, .. }`; `http::auth::auth_middleware` extracts `UserRow` into request extensions (used by later tasks). Test helper `test_state_with_db()` returns `TestDb`-backed state.

- [ ] **Step 1: Write failing test `crates/server/tests/auth_api.rs`**

```rust
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn bootstrap_login_me_flow() {
    let db = guild_server::test_support::test_state_with_db().await;
    let app = guild_server::build_router(db.state.clone());

    let res = app.clone().oneshot(Request::builder()
        .method("POST").uri("/api/v1/auth/bootstrap")
        .header("content-type", "application/json")
        .body(Body::from(json!({"email": "a@b.c", "password": "hunter226"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = app.clone().oneshot(/* same bootstrap request again */).await.unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    let res = app.clone().oneshot(Request::builder()
        .method("POST").uri("/api/v1/auth/login")
        .header("content-type", "application/json")
        .body(Body::from(json!({"email": "a@b.c", "password": "hunter226"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let login: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let token = login["token"].as_str().unwrap().to_string();

    let res = app.oneshot(Request::builder()
        .uri("/api/v1/auth/me").header("authorization", format!("Bearer {token}"))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p guild-server --test auth_api`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement `http/auth.rs` and middleware**

Handlers call the identity store directly; `bootstrap` handler shape:

```rust
async fn bootstrap(State(state): State<AppState>, Json(body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, ApiError> {
    let email = body["email"].as_str().ok_or_else(|| ApiError::bad_request("missing email"))?;
    let password = body["password"].as_str().ok_or_else(|| ApiError::bad_request("missing password"))?;
    let store = state.store().await?;
    if store.identity().any_users().await? { return Err(ApiError { status: StatusCode::CONFLICT, code: "already_bootstrapped".into(), message: "org already has users".into() }); }
    store.identity().ensure_bootstrap_admin(email, password).await?;
    Ok(Json(json!({})))
}
```

`auth_middleware`: parse `Bearer`, `validate_session`, insert `UserRow` into extensions; `401 code: "unauthorized"` otherwise. `state.store()` lazily connects using `config.database_url` (once, via `tokio::sync::OnceCell`), so `test_state()` (no DB) can still serve health.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p guild-server && cargo clippy --workspace -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/server && git commit -m "feat(server): auth api — bootstrap, login, me, bearer middleware"
```

---

### Task 6: guild-core — model provider traits and SSE clients

**Files:**
- Create: `crates/guild-core/src/provider/mod.rs`, `crates/guild-core/src/provider/openai.rs`, `crates/guild-core/src/provider/anthropic.rs`, `crates/guild-core/src/usage.rs`
- Modify: `crates/guild-core/src/lib.rs`, `crates/guild-core/Cargo.toml`
- Test: `crates/guild-core/tests/provider_stream.rs`

**Interfaces:**
- Consumes: `protocol::api::{Message, StreamEvent}` (Task 2).
- Produces (used by Tasks 7, 8, and later milestones):
  - `provider::ChatChunk { text_delta: String, tokens_in: Option<u32>, tokens_out: Option<u32> }`
  - `provider::ModelProvider` (async_trait): `fn name(&self) -> &str; async fn chat_stream(&self, req: provider::ProviderRequest<'_>) -> Result<BoxStream<'static, Result<provider::ChatChunk, anyhow::Error>>, provider::ProviderError>`
  - `provider::ProviderRequest<'a> { model: &'a str, system: Option<&'a str>, messages: &'a [protocol::api::Message], api_key: &'a str, base_url: &'a str }`
  - `provider::openai::OpenAiProvider` — POST `{base_url}/v1/chat/completions` body `{model, messages, stream: true, stream_options: {include_usage: true}}`, parses SSE `data:` frames (`choices[0].delta.content`, final frame `usage`), `[DONE]` sentinel.
  - `provider::anthropic::AnthropicProvider` — POST `{base_url}/v1/messages` with `x-api-key`, `anthropic-version` headers, body `{model, max_tokens, system, messages, stream: true}`, parses `content_block_delta` (`delta.text`) and `message_delta` (`usage.output_tokens`) plus `message_start` (`usage.input_tokens`).
  - `usage::UsageEvent { ts: chrono::DateTime<Utc>, org_id: Uuid, user_id: Uuid, team_id: Option<Uuid>, session_id: Uuid, model: String, provider: String, tokens_in: u32, tokens_out: u32, cost_usd: f64, request_id: Uuid }`

- [ ] **Step 1: Write failing test `crates/guild-core/tests/provider_stream.rs`**

Uses `wiremock` (add `wiremock = "0.6"` dev-dep) serving an SSE body; asserts chunks collected.

```rust
use futures::StreamExt;
use guild_core::provider::{openai::OpenAiProvider, ModelProvider, ProviderRequest};
use protocol::api::Message;

#[tokio::test]
async fn openai_stream_yields_deltas_then_usage() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path("/v1/chat/completions"))
        .respond_with(wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string("data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
                              data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
                              data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n\
                              data: [DONE]\n\n"))
        .mount(&server).await;

    let p = OpenAiProvider::new();
    let msgs = vec![Message { role: "user".into(), content: "say hi".into() }];
    let req = ProviderRequest { model: "gpt-test", system: None, messages: &msgs, api_key: "sk-test", base_url: &server.uri() };
    let stream = p.chat_stream(&req).await.unwrap();
    let chunks: Vec<_> = stream.map(|r| r.unwrap()).collect().await;
    let text: String = chunks.iter().map(|c| c.text_delta.as_str()).collect();
    assert_eq!(text, "Hello");
    assert_eq!(chunks.last().unwrap().tokens_in, Some(3));
    assert_eq!(chunks.last().unwrap().tokens_out, Some(2));
}
```

Add an equivalent `anthropic_stream_yields_deltas_then_usage` test with the Anthropic frame shapes.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p guild-core`
Expected: FAIL — providers not defined.

- [ ] **Step 3: Implement**

SSE parsing: `reqwest::Response::bytes_stream()` → `eventsource_stream::Eventsource` → `.map(|ev| parse_frame(ev?))`. Each provider maps frames to `ChatChunk`; usage carried on the final chunk (fields `Option`). `ProviderError` enum: `auth`, `rate_limited`, `upstream(String)`, maps provider HTTP status codes; terminal vs retryable is decided by callers.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p guild-core && cargo clippy --workspace -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/guild-core && git commit -m "feat(core): openai/anthropic streaming provider clients with fixtures"
```

---

### Task 7: Gateway service — keys, model routes, streaming endpoint, usage events

**Files:**
- Create: `crates/server/migrations/0002_gateway.sql`, `crates/server/src/store/gateway.rs`, `crates/server/src/http/gateway.rs`, `crates/server/src/usage.rs`
- Modify: `crates/server/src/http/mod.rs`, `crates/server/src/state.rs`, `crates/server/Cargo.toml` (clickhouse, uuid, chrono)
- Test: `crates/server/tests/gateway_api.rs`

**Interfaces:**
- Consumes: `guild_core::provider::*` (Task 6), `protocol::api::StreamEvent` (Task 2), identity middleware (Task 5).
- Produces:
  - Schema `0002_gateway.sql`:

    ```sql
    CREATE TABLE provider_keys (
      id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES orgs(id),
      provider TEXT NOT NULL, base_url TEXT NOT NULL, encrypted_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, provider)
    );
    CREATE TABLE model_routes (
      org_id UUID NOT NULL REFERENCES orgs(id),
      model TEXT NOT NULL, provider TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
      price_per_mtok_in_usd DOUBLE PRECISION NOT NULL, price_per_mtok_out_usd DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (org_id, model)
    );
    ```

  - `store::gateway::GatewayStore`:
    - `upsert_provider_key(&self, org, provider, base_url, plaintext_key, master_key) -> Result<()>` (encrypts with `crypto`)
    - `resolve_route(&self, org_id, model) -> Result<RouteRow, ApiError>` — `RouteRow { provider, base_url, api_key: String /* decrypted */, price_in, price_out }`; `404 code: "model_not_found"`, `409 code: "key_missing"`.
  - `http::gateway::routes()` — mounted under the auth middleware:
    - `GET /api/v1/gateway/models` → `{"models": ["gpt-4o", ...]}` (enabled routes for the org)
    - `POST /api/v1/gateway/chat` — body `protocol::api::ChatCompletionRequest`, response `text/event-stream` of `protocol::api::StreamEvent` JSON lines. On completion persists assistant message (Task 8 store) and writes `usage_events` row. Emits `error {code, message}` event on provider failure.
  - `usage::UsageSink` — `async fn record(&self, ev: guild_core::usage::UsageEvent)` inserting into ClickHouse table `usage_events` (schema below); batched (flush every 1s or 100 events); drops with a warning log if ClickHouse is unreachable (availability of chat must not depend on analytics).

  ClickHouse schema (created at startup if absent):

  ```sql
  CREATE TABLE IF NOT EXISTS usage_events (
    ts DateTime64(3), org_id UUID, user_id UUID, team_id Nullable(UUID),
    session_id UUID, model String, provider String,
    tokens_in UInt32, tokens_out UInt32, cost_usd Float64, request_id UUID
  ) ENGINE = MergeTree ORDER BY (org_id, ts);
  ```

- [ ] **Step 1: Write failing test `crates/server/tests/gateway_api.rs`**

Wiremock fake provider + Postgres + ClickHouse testcontainers:

```rust
#[tokio::test]
async fn chat_roundtrip_streams_persists_and_records_usage() {
    let provider = wiremock::MockServer::start().await;
    wiremock::Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string("data: {\"choices\":[{\"delta\":{\"content\":\"hi there\"}}]}\n\n\
                              data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n\
                              data: [DONE]\n\n"))
        .mount(&provider).await;

    let db = guild_server::test_support::full_state().await; // pg + clickhouse + wiremock provider registered as "openai" route
    let app = guild_server::build_router(db.state.clone());
    let token = db.login_admin().await; // helper: bootstrap + login, returns token

    // seed route + key via a test-only admin API (POST /api/v1/admin/gateway/keys, /routes) — same endpoints real admins use
    // (admin endpoints are part of this task; guarded by admin middleware)

    let res = app.clone().oneshot(Request::builder()
        .method("POST").uri("/api/v1/gateway/chat")
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(json!({
            "chat_id": db.chat_id, "model": "gpt-test",
            "messages": [{"role":"user","content":"greet"}]
        }).to_string())).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.contains("delta") && text.contains("hi there") && text.contains("done"));

    let msgs = db.store().chats().list_messages(db.chat_id).await.unwrap();
    assert_eq!(msgs.len(), 2); // user message written by endpoint, assistant message at stream end
    assert_eq!(msgs[1].content, "hi there");
    assert!(msgs[1].cost_usd > 0.0);

    let usage = db.clickhouse_usage_rows().await; // SELECT count(*), sum(cost_usd) FROM usage_events
    assert_eq!(usage.count, 1);
}
```

Admin endpoints in this task (needed by the test and by M4's admin UI): `POST /api/v1/admin/gateway/keys {provider, base_url, key}`, `PUT /api/v1/admin/gateway/routes {model, provider, enabled, price_in, price_out}`, guarded by a role-check middleware (`403 code: "forbidden"` for non-admins).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p guild-server --test gateway_api`
Expected: FAIL.

- [ ] **Step 3: Implement**

`http/gateway.rs` handler: resolve route → build `ProviderRequest` → map provider stream to `protocol::api::StreamEvent::delta` frames → accumulate full text + usage → on end: `chats().append_message(chat_id, "assistant", text, cost, tokens)` + `usage.record(...)` → final `done` event. Cost: `tokens_in/1e6*price_in + tokens_out/1e6*price_out`. The endpoint also appends the incoming user message before calling the provider.

`test_support::full_state()`: postgres + clickhouse testcontainers, an "openai" provider key + route pointing at the wiremock server, a seeded chat. `UsageSink` in tests points at the testcontainer ClickHouse; a `count_usage_events()` helper is exposed via `test_support` (not shipped logic).

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test -p guild-server && cargo clippy --workspace -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/server && git commit -m "feat(server): gateway — streaming chat, keys/routes admin api, clickhouse usage"
```

---

### Task 8: Chats store + API

**Files:**
- Create: `crates/server/migrations/0003_chats.sql`, `crates/server/src/store/chats.rs`, `crates/server/src/http/chats.rs`
- Modify: `crates/server/src/http/mod.rs`, `crates/server/src/state.rs`
- Test: `crates/server/tests/chats_api.rs`

**Interfaces:**
- Consumes: identity middleware (Task 5).
- Produces:
  - Schema `0003_chats.sql`:

    ```sql
    CREATE TABLE chats (
      id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES orgs(id), user_id UUID NOT NULL REFERENCES users(id),
      title TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE messages (
      id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL, tool_calls JSONB,
      tokens_in INT, tokens_out INT, cost_usd DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX messages_chat_idx ON messages (chat_id, created_at);
    ```

  - `store::chats::ChatStore`:
    - `create_chat(&self, org_id, user_id, title: Option<&str>) -> Result<ChatRow, ApiError>`
    - `list_chats(&self, org_id, user_id) -> Result<Vec<ChatRow>, ApiError>`
    - `get_chat(&self, org_id, chat_id) -> Result<ChatRow, ApiError>` (404 `not_found`; org-scoped)
    - `append_message(&self, chat_id, role, content, tokens_in: Option<u32>, tokens_out: Option<u32>, cost_usd: Option<f64>) -> Result<MessageRow, ApiError>`
    - `list_messages(&self, org_id, chat_id) -> Result<Vec<MessageRow>, ApiError>` (org-scoped join on chats)
  - `http::chats::routes()` (auth-guarded):
    - `POST /api/v1/chats` → `Chat`
    - `GET /api/v1/chats` → `{"chats": [...]}` (caller's own chats)
    - `GET /api/v1/chats/:id/messages` → `{"messages": [...]}`

  Task 7's gateway endpoint already writes messages through `ChatStore` — this task adds the store if not present and the user-facing routes; keep the `append_message` signature identical to Task 7 usage.

- [ ] **Step 1: Write failing test `crates/server/tests/chats_api.rs`** — login via helpers, create chat, append two messages via store, list via API, assert ordering and 404 for a foreign org's chat id (use a second org row inserted directly).

- [ ] **Step 2: Run to verify failure** — `cargo test -p guild-server --test chats_api` → FAIL.

- [ ] **Step 3: Implement store and routes** — straightforward sqlx queries; org scoping enforced in SQL (`WHERE c.org_id = $1`).

- [ ] **Step 4: Run tests to verify pass** — `cargo test --workspace && cargo clippy --workspace -- -D warnings` → PASS.

- [ ] **Step 5: Commit** — `git add crates/server && git commit -m "feat(server): chats store and user-facing chat api"`

---

### Task 9: app-server — headless login and chat round-trip

**Files:**
- Create: `crates/app-server/src/cloud.rs`, `crates/app-server/src/jsonrpc_loop.rs`, `crates/app-server/src/session_store.rs`
- Modify: `crates/app-server/src/main.rs`, `crates/app-server/Cargo.toml` (add reqwest, eventsource-stream, futures, uuid, dirs)
- Test: `crates/app-server/tests/roundtrip.rs`

**Interfaces:**
- Consumes: `protocol::rpc::{Request, Event, Connection, PROTOCOL_VERSION}` (Task 2), `protocol::api::*` (Task 2), server API from Tasks 5–8.
- Produces:
  - `cloud::CloudClient { base_url, token }`:
    - `login(base_url, email, password) -> Result<(token, UserInfo), CloudError>`
    - `create_chat(&self, title: Option<&str>) -> Result<Uuid>`
    - `chat_stream(&self, chat_id, model, messages) -> Result<impl Stream<Item = Result<protocol::api::StreamEvent>>>` — POST `/api/v1/gateway/chat`, parse SSE lines
  - `session_store::token_path() -> PathBuf` (`dirs::config_dir()/guild/token.json` storing `{base_url, token}`), `save`/`load`/`clear`
  - `jsonrpc_loop::serve<R, W>(read: R, write: W, dispatch: impl FnMut(Request) -> ...)`: reads `rpc::Request` lines, for M1 supports methods:
    - `login {base_url, email, password}` → result `{ok: true}`
    - `chat.send {text}` → starts/uses a session chat; streams back `rpc::Event { event: "chat.delta" | "chat.done", payload }`
  - `main`: `guild-app-server` with no args runs the JSON-RPC stdio loop (UI path); `guild-app-server login --url ... --email ...` and `guild-app-server chat --model ... "text"` are headless paths for M1 tests and humans.

- [ ] **Step 1: Write failing end-to-end test `crates/app-server/tests/roundtrip.rs`**

The test boots the real guild-server (lib entry `build_router` + `axum::serve` on an ephemeral port with testcontainer pg/clickhouse and a wiremock provider seeded exactly like Task 7's `full_state()` — expose `test_support::serve_full()` from guild-server returning `(base_url, TestDb)`), then drives `CloudClient`:

```rust
#[tokio::test]
async fn login_create_chat_stream_roundtrip() {
    let srv = guild_server::test_support::serve_full().await;
    let (token, user) = guild_app_server::cloud::CloudClient::login(&srv.base_url, "a@b.c", "hunter226").await.unwrap();
    let client = guild_app_server::cloud::CloudClient { base_url: srv.base_url.clone(), token };
    let chat_id = client.create_chat(Some("t")).await.unwrap();
    let stream = client.chat_stream(chat_id, "gpt-test",
        &[Message { role: "user".into(), content: "greet".into() }]).await.unwrap();
    let events: Vec<_> = stream.map(|e| e.unwrap()).collect().await;
    assert!(matches!(events.last().unwrap(), StreamEvent::Done { .. }));
    let msgs = srv.db.store().chats().list_messages(user.org_id, chat_id).await.unwrap();
    assert_eq!(msgs.len(), 2);
}
```

A second test drives the JSON-RPC stdio loop through in-memory buffers: send `login` then `chat.send`, read events, assert `chat.done` arrives.

- [ ] **Step 2: Run to verify failure** — `cargo test -p guild-app-server` → FAIL (modules missing).

- [ ] **Step 3: Implement** — `cloud.rs` (reqwest + `eventsource-stream` parsing `StreamEvent` JSON lines), `session_store.rs` (JSON file in config dir), `jsonrpc_loop.rs` (line-based `Connection` from protocol crate; in-memory state: base_url/token/chat id/model), `main.rs` (clap-free manual arg parsing for `login`/`chat` subcommands; default runs the loop).

- [ ] **Step 4: Run tests to verify pass** — `cargo test --workspace && cargo clippy --workspace -- -D warnings` → PASS.

- [ ] **Step 5: Commit** — `git add crates/app-server && git commit -m "feat(app-server): cloud client, stdio jsonrpc loop, headless login/chat"`

---

### Task 10: Deploy — compose bundle and config

**Files:**
- Create: `deploy/compose/docker-compose.yml`, `deploy/compose/config.env.example`, `deploy/README.md`
- Create: `Dockerfile` (workspace root, multi-stage rust build for guild-server)

**Interfaces:**
- Produces: `docker compose -f deploy/compose/docker-compose.yml up` brings up the **full server-side stack**: guild-server (api + worker roles) + restate + postgres + clickhouse + minio; health check passes; manual smoke: bootstrap → login → chat (with a real provider key configured via the admin API). Restate is present from M1 even though the integrations runtime lands in M5, so the deployed stack always matches the final shape.

`docker-compose.yml` services: `server` (build `../..`, ports `8080:8080`, env from `config.env`), `restate` (`docker.io/restatedev/restate:latest`, ingress port 8080 internal, admin 9070 — worker role consumes it from M5), `postgres:17` (volume, healthcheck), `clickhouse/clickhouse-server:24` (volume, healthcheck), `minio/minio` (`server /data`, console off, volume). Server depends_on all healthy. `config.env.example` documents every `GUILD_*` var from Task 3 plus `GUILD_RESTATE_URL`.

- [ ] **Step 1: Write Dockerfile** — multi-stage: `rust:1.97` build (`cargo build --release -p guild-server`), `debian:bookworm-slim` runtime with `ca-certificates`, entrypoint `guild-server`.
- [ ] **Step 2: Write compose file + config example + README** (README includes the exact smoke commands).
- [ ] **Step 3: Smoke test locally** — `docker compose -f deploy/compose/docker-compose.yml up -d`, wait for health, `curl -s localhost:8080/api/v1/health` → `{"status":"ok"}`; then `docker compose down -v`.
  Expected: health OK. (Full chat smoke needs a real provider key — documented in README as optional.)
- [ ] **Step 4: Commit** — `git add -A && git commit -m "deploy: compose bundle with postgres, clickhouse, minio, server image"`

---

### Task 11: Desktop shell — Tauri app with login + chat view

**Files:**
- Create: `apps/desktop/` (Tauri v2 scaffold: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src/main.tsx`, `src/App.tsx`, minimal shadcn components), `apps/desktop/src-tauri/src/lib.rs` (spawns `guild-app-server`, owns stdio JSON-RPC bridge)
- Modify: root `README.md` (run instructions)

**Interfaces:**
- Consumes: `protocol::rpc` (Task 2), app-server JSON-RPC loop (Task 9).
- Produces: desktop app that logs in and completes one chat round-trip against a running guild-server.

- [ ] **Step 1: Scaffold** — `npm create tauri-app@latest` into `apps/desktop` (template: react-ts, identifier `org.guild.desktop`), `npm install`, add Tailwind + shadcn init with button/input/card components only.
- [ ] **Step 2: Tauri side bridge** — `src-tauri/src/lib.rs`: tauri command `start_engine()` spawns `guild-app-server` (resolved from `PATH`, overridable by `GUILD_APP_SERVER_BIN`), keeps child handle in tauri state, exposes `rpc_request(method, params)` and `rpc_events()` (channel) that relay through the child's stdin/stdout using the same line-based JSON-RPC. Unit-test the relay with a fake child (a tiny script echoing a JSON-RPC response) where possible; otherwise verify via `cargo check -p` of the tauri crate.
- [ ] **Step 3: React UI** — two views: `Login` (server URL, email, password → calls `rpc_request("login", ...)`; on success stores nothing sensitive in the webview — token lives in the engine) and `Chat` (model input + message list; `chat.send` streams `chat.delta` events into the transcript). Keep components shadcn-styled, no router.
- [ ] **Step 4: Verify** — run compose (Task 10) or a dev guild-server, seed provider key/route via admin API, `npm run tauri dev`, login, send "hello", see streamed reply. Manual verification; record result in commit message.
- [ ] **Step 5: Commit** — `git add apps/desktop README.md && git commit -m "feat(desktop): tauri shell with login and chat over stdio jsonrpc"`

---

## Self-Review

- **Spec coverage (M1):** scaffolding (T1), both binaries (T3, T9, T11), managed-account login (T4, T5), gateway round-trip with streaming (T6, T7), history persisted (T8), usage events with cost (T7), compose (T10). Later-milestone features deliberately excluded and listed in Global Constraints.
- **Placeholders:** none — every task has concrete schemas, signatures, and test code. Task 11 step 3 is the largest manual-verification step and is explicit about what "verified" means.
- **Type consistency:** `append_message` signature identical in T7 and T8; `StreamEvent` shapes fixed in T2 and consumed in T6/T7/T9; `PROTOCOL_VERSION` single source in protocol crate.
