# Guild Milestone 3 — Registry Implementation Plan

**Status: COMPLETE** (2026-09-09, branch `feat/milestone-3`). Publish →
review → install covered by automated tests (Postgres + MinIO + ClickHouse
testcontainers) and smoke-tested against the deployed compose stack (CLI
publish, admin review, CLI install into a project, agent-visible SKILL.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Org-scoped registries for skills, MCP servers, and integrations:
users publish versioned bundles, admins review, clients install — the agent
then uses installed skills like local ones.

**Architecture:** Bundles are tar.gz archives with a `manifest.json` at the
root (Guild-specific metadata; SKILL.md stays untouched — spec §4.4).
Server stores bytes in S3-compatible object storage (MinIO), metadata in
Postgres. Publish = pack+PUT; install = GET+extract into
`{project}/.guild/skills/<slug>/`. Client publishes through the same API
guild-admin tooling uses.

**Tech Stack:** adds `object_store` (S3/MinIO), `tar`, `flate2`; server +
app-server; testcontainers MinIO for tests.

**Spec:** `docs/specs/2026-09-09-guild-design.md` (§4.4, §5; milestone 3 in §10)

## Global Constraints

- SKILL.md format untouched; Guild metadata only in the bundle's separate
  `manifest.json` (spec §4.4).
- Registry endpoints org-scoped; review status draft → approved by admins;
  members can install approved items only.
- Republishing the same slug+version replaces content (idempotent).
- All bundles validated at publish: manifest present, kind/slug/version
  match, SKILL.md present for kind=skill.
- Extraction rejects path traversal (no absolute paths, no `..`).
- Tests use testcontainers (Postgres + MinIO); no local services required.

---

### Task 1: guild-core — bundle pack/extract

**Files:**
- Create: `crates/guild-core/src/registry.rs`
- Test: `crates/guild-core/tests/registry_bundle.rs`

**Interfaces:**
- Produces:
  - `registry::BundleManifest { kind: String, slug: String, version: String, description: String, dependencies: Vec<String> }` (serde)
  - `registry::pack(source_dir: &Path, manifest: BundleManifest) -> Result<Vec<u8>>` — tar.gz with `manifest.json` first, then every file under source_dir (except `manifest.json` itself, no dirs named `.`); deterministic order (sorted).
  - `registry::extract(bundle: &[u8], dest: &Path) -> Result<BundleManifest>` — creates dest, unpacks; rejects entries with `..`, absolute paths, or symlinks; returns the manifest.
  - `registry::pack_skill(skill_dir, kind: "skill", version) -> Result<(Vec<u8>, BundleManifest)>` — convenience: slug = dir name, description from SKILL.md frontmatter (reuses the app-server frontmatter logic, moved here); errors if no SKILL.md.

- [x] **Step 1: Failing tests** — round-trip pack→extract with nested files; missing SKILL.md error; traversal entry rejected; manifest round-trips.
- [x] **Step 2: FAIL** (`cargo test -p guild-core`).
- [x] **Step 3: Implement** (tar + flate2; move `parse_frontmatter` from app-server/skills.rs to guild-core and re-export).
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(core): registry bundle pack/extract with manifest`

### Task 2: server — object storage (S3/MinIO)

**Files:**
- Create: `crates/server/src/s3.rs`
- Modify: `crates/server/src/config.rs`, `crates/server/src/state.rs`, `crates/server/Cargo.toml`
- Test: `crates/server/tests/s3_store.rs`

**Interfaces:**
- Produces:
  - Config additions: `GUILD_S3_URL` (default `http://localhost:9000`), `GUILD_S3_BUCKET` (default `guild`), `GUILD_S3_ACCESS_KEY_ID`, `GUILD_S3_SECRET_ACCESS_KEY`.
  - `s3::ObjectStore { store: object_store::ObjectStore }`:
    - `connect(cfg: &Config) -> Result<Self>`
    - `put(&self, key: &str, bytes: Vec<u8>)` (overwrite ok)
    - `get(&self, key: &str) -> Result<Vec<u8>>`
    - `delete(&self, key: &str)`
  - `AppState::objects(&self)` — lazy OnceCell like `usage()`.
  - test_support: `minio_container()` helper returning `(endpoint_url, credentials)`; `test_config_with_s3(endpoint)`.

- [x] **Step 1: Failing test** — put/get/delete round-trip against a MinIO testcontainer; get of missing key errors.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement** via `object_store::aws::AmazonS3Builder` (`with_endpoint`, `with_allow_http`).
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): s3 object store (minio) with lazy state wiring`

### Task 3: server — registry store + API

**Files:**
- Create: `crates/server/migrations/0005_registry.sql`, `crates/server/src/store/registry.rs`, `crates/server/src/http/registry.rs`
- Modify: `crates/server/src/store/mod.rs` (migrations array), `crates/server/src/http/mod.rs`
- Test: `crates/server/tests/registry_api.rs`

**Interfaces:**
- Schema `0005_registry.sql`:

  ```sql
  CREATE TABLE registry_items (
    id UUID PRIMARY KEY, org_id UUID NOT NULL REFERENCES orgs(id),
    kind TEXT NOT NULL CHECK (kind IN ('skill','mcp','integration')),
    slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    latest_version TEXT, review_status TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','approved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, kind, slug)
  );
  CREATE TABLE registry_versions (
    id UUID PRIMARY KEY, item_id UUID NOT NULL REFERENCES registry_items(id) ON DELETE CASCADE,
    version TEXT NOT NULL, manifest JSONB NOT NULL, object_key TEXT NOT NULL,
    published_by UUID REFERENCES users(id), published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, version)
  );
  ```

- `store::registry::RegistryStore`:
  - `upsert_version(&self, org, kind, slug, version, description, manifest_json, object_key, publisher)` → 409 `review_locked` if the item was approved and the version is new? (No: new versions of an approved item start as draft again; same-version republish of an approved item keeps approved status.)
  - `list_items(&self, org, kind) -> Vec<RegistryItemRow { slug, description, latest_version, review_status }>`
  - `item_versions(&self, org, kind, slug) -> Vec<VersionRow { version, published_at }>`
  - `get_version(&self, org, kind, slug, version) -> (manifest_json, object_key)` — 404 if missing
  - `set_review(&self, org, kind, slug, status)` — admin-only at the HTTP layer
- `http::registry::routes()` (auth):
  - `POST /api/v1/registry/{kind}` — query `?slug=&version=`; body = tar.gz bytes (content-length cap 50 MiB); parses bundle, validates manifest (kind/slug/version match, SKILL.md present for kind=skill)
  - `GET /api/v1/registry/{kind}` — item list
  - `GET /api/v1/registry/{kind}/{slug}` — versions
  - `GET /api/v1/registry/{kind}/{slug}/{version}/bundle` — bytes (approved, or caller is admin)
  - `POST /api/v1/registry/{kind}/{slug}/review` — admin; body `{status}`

- [x] **Step 1: Failing tests** — full round-trip: publish skill bundle (bytes from guild-core pack) → list → versions → download → bytes equal; review approve by admin; member 403 on review + on downloading draft; republish same version replaces; kind/slug mismatch 400.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement** (Postgres testcontainer + MinIO testcontainer via test_support).
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): registry api — publish, versions, review, download`

### Task 4: app-server — publish and install

**Files:**
- Create: `crates/app-server/src/registry_client.rs`
- Modify: `crates/app-server/src/jsonrpc_loop.rs`, `crates/app-server/src/main.rs`, `crates/app-server/src/skills.rs` (frontmatter moves to guild-core)
- Test: `crates/app-server/tests/registry_client.rs`

**Interfaces:**
- Produces:
  - `registry_client::RegistryClient { cloud }`:
    - `publish(&self, kind: &str, source_dir: &Path, version: &str) -> Result<(String, String)>` — packs via guild-core, POSTs to the registry API
    - `install(&self, project_dir: &Path, slug: &str, version: Option<&str>) -> Result<SkillEntry>` — resolves latest (list + approved filter), downloads, extracts into `{project}/.guild/skills/{slug}/`
  - JSON-RPC: `registry.publish {kind, dir, version}` → `{slug, version}`; `registry.install {slug, version?}` → `{path, name}` (uses session project_dir)
  - CLI: `guild-app-server publish --kind skill --dir D --version 1.0.0` (login required); `guild-app-server install --slug S [--version V] --project P`

- [x] **Step 1: Failing tests** — against the full stack (server + minio testcontainers): publish a scratch skill dir → install into a fresh project → SKILL.md content matches; install of draft rejected for members.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(app-server): registry publish/install over the cloud api`

### Task 5: deploy — MinIO wiring for the server

**Files:**
- Modify: `deploy/compose/config.env.example`, `deploy/compose/docker-compose.yml`, `deploy/README.md`

**Interfaces:**
- Compose: minio gets healthcheck; server env gains `GUILD_S3_URL=http://minio:9000`, bucket/credentials matching the minio service env (`MINIO_ROOT_USER/GUILD_S3_ACCESS_KEY_ID` aligned).
- README: registry smoke commands (publish via CLI, list, install).

- [x] **Step 1: Update compose + env example + README.**
- [x] **Step 2: Smoke** — compose up; publish a scratch skill via CLI; install into a scratch project; SKILL.md matches; compose down -v.
- [x] **Step 3: Commit** — `deploy: minio wiring for the registry`

## Self-Review

- **Spec coverage (M3):** org-scoped catalogs with three kinds (T3), publish/versioning/review/install (T3/T4), SKILL.md untouched with separate manifest (T1), bundle storage in S3 (T2), CLI publish (T4), compose has MinIO since M1 and is now wired (T5). Integration-kind install semantics (server-executed triggers) are milestone 5.
- **Placeholders:** none; test assertions name exact values.
- **Type consistency:** `BundleManifest` single source in guild-core, used by server (validation) and app-server (pack/extract); `SkillEntry` remains the install result type.
