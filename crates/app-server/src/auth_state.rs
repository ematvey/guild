//! Auth state: the cloud sessions (one per workspace/server), the machine
//! identity (webview-reported `machine_id` + generated `client_id`),
//! `workspaces.json` persistence with the `token.json` active-session
//! mirror, and machine-link publication. Every auth transition — `login`,
//! `pair`, `machine.identify`, `session.clear`, `workspace.switch` — goes
//! through [`AuthState::transition`]: mutate ⇒ persist ⇒ publish is ONE
//! method, so the steps cannot drift apart.

use crate::cloud::{CloudClient, CloudError};
use crate::machine_link::{LinkRegistry, MachineLinkConfig};
use crate::machine_meta::hostname_label;
use crate::session_store::{self, StoredSession, WorkspaceStore};
use anyhow::Context as _;
use std::collections::BTreeMap;
use std::path::Path;

/// One workspace's auth fields (a live session on one server). `cloud` is
/// None for an entry whose token died (restore found it unauthorized) —
/// the entry stays listed so the switcher can offer "sign in again".
#[derive(Clone, Default)]
struct WorkspaceAuth {
    cloud: Option<CloudClient>,
    email: Option<String>,
    /// Display name + logo URL fetched from the server (the switcher's
    /// identity data; refreshed at login and restore).
    org_name: Option<String>,
    org_logo_url: Option<String>,
}

/// A workspace row as the RPC layer and UI see it: identity plus whether a
/// usable token survived the last restore.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceInfo {
    pub base_url: String,
    pub email: Option<String>,
    pub has_token: bool,
    pub name: Option<String>,
    pub logo_url: Option<String>,
}

/// The `EngineState`'s auth fields. The struct is public, its fields are
/// private: reads go through the accessors, every mutation through
/// [`AuthState::transition`].
#[derive(Clone, Default)]
pub struct AuthState {
    /// Live sessions keyed by normalized base_url (one per server — a map
    /// key, so the same server can never be logged into twice).
    workspaces: BTreeMap<String, WorkspaceAuth>,
    /// The active workspace's base_url. The webview mirrors it, the CLI
    /// reads it (via the token.json mirror), execution state belongs to it.
    active: Option<String>,
    /// The webview-generated machine identity (stable per app install)
    /// once reported via `machine.identify`; every link keys on it.
    machine_id: Option<String>,
    /// Stable per-daemon-install WS presence key, generated on first
    /// identify and persisted with the sessions. One value for every link
    /// (presence keys are per-server).
    client_id: Option<String>,
}

/// One auth transition. The RPC verbs map 1:1 onto these.
#[derive(Debug, Clone)]
pub enum AuthChange {
    /// `login` / `pair`: adopt-or-replace the cloud session for that server
    /// AND make it the active workspace (always persists).
    Login {
        base_url: String,
        token: String,
        email: String,
    },
    /// `machine.identify`: record the webview-reported identity. Persists
    /// only alongside a live session — an anonymous identify stays in
    /// memory until a login adopts it.
    Identify { machine_id: String },
    /// `session.clear` (no param): drop the ACTIVE workspace in memory and
    /// the persisted store, so the next restore shows the pair/sign-in
    /// screen when nothing remains.
    SignOut,
    /// `session.clear { base_url }`: drop a specific workspace (the active
    /// pointer moves to another entry when it was the dropped one).
    SignOutWorkspace { base_url: String },
    /// `workspace.switch`: make an existing, token-bearing entry active.
    /// Link configs are per-workspace, so a switch publishes nothing —
    /// persistence (the token.json mirror re-pointing) is the whole effect.
    Switch { base_url: String },
}

impl AuthState {
    /// Assembles a single-workspace state from parts. The restore path and
    /// tests use this; RPC transitions never do (they go through
    /// [`AuthState::transition`]).
    pub fn from_parts(
        cloud: Option<CloudClient>,
        email: Option<String>,
        machine_id: Option<String>,
        client_id: Option<String>,
    ) -> Self {
        let mut state = Self {
            machine_id,
            client_id,
            ..Self::default()
        };
        if let Some(cloud) = cloud {
            let base = session_store::normalize_base(&cloud.base_url);
            state.workspaces.insert(
                base.clone(),
                WorkspaceAuth {
                    cloud: Some(CloudClient {
                        base_url: base.clone(),
                        token: cloud.token,
                    }),
                    email,
                    ..Default::default()
                },
            );
            state.active = Some(base);
        }
        state
    }

    /// The ACTIVE workspace's cloud client (None signed out, or active on
    /// a tokenless entry).
    pub fn cloud(&self) -> Option<&CloudClient> {
        self.active
            .as_ref()
            .and_then(|base| self.workspaces.get(base))
            .and_then(|w| w.cloud.as_ref())
    }

    /// The ACTIVE workspace's email.
    pub fn email(&self) -> Option<&str> {
        self.active
            .as_ref()
            .and_then(|base| self.workspaces.get(base))
            .and_then(|w| w.email.as_deref())
    }

    pub fn machine_id(&self) -> Option<&str> {
        self.machine_id.as_deref()
    }

    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    /// The active workspace's normalized base_url.
    pub fn active_base(&self) -> Option<&str> {
        self.active.as_deref()
    }

    /// A specific workspace's cloud client (None when absent or tokenless).
    pub fn cloud_of(&self, base_url: &str) -> Option<&CloudClient> {
        self.workspaces
            .get(&session_store::normalize_base(base_url))
            .and_then(|w| w.cloud.as_ref())
    }

    /// Every workspace row (the switcher's data), active pointer included.
    pub fn workspaces(&self) -> (Option<String>, Vec<WorkspaceInfo>) {
        let rows = self
            .workspaces
            .iter()
            .map(|(base, w)| WorkspaceInfo {
                base_url: base.clone(),
                email: w.email.clone(),
                has_token: w.cloud.is_some(),
                name: w.org_name.clone(),
                logo_url: w.org_logo_url.clone(),
            })
            .collect();
        (self.active.clone(), rows)
    }

    /// The ONE transition method: apply the change to the in-memory state,
    /// persist (or clear) the store, then publish the machine-link configs —
    /// exactly one persist and one publish per call. `store` is the
    /// token.json path (the workspace store derives as its sibling; `None`
    /// skips persistence — tests); `links` is the machine-link registry.
    pub fn transition(
        &mut self,
        change: AuthChange,
        store: Option<&Path>,
        links: &LinkRegistry,
    ) -> anyhow::Result<()> {
        let mut removed: Option<String> = None;
        let persisted = match change {
            AuthChange::Login {
                base_url,
                token,
                email,
            } => {
                let base = session_store::normalize_base(&base_url);
                self.workspaces.insert(
                    base.clone(),
                    WorkspaceAuth {
                        cloud: Some(CloudClient {
                            base_url: base.clone(),
                            token,
                        }),
                        email: Some(email),
                        org_name: None,
                        org_logo_url: None,
                    },
                );
                self.active = Some(base);
                match store {
                    Some(path) => self.persist(path),
                    None => Ok(()),
                }
            }
            AuthChange::Identify { machine_id } => {
                anyhow::ensure!(!machine_id.is_empty(), "machine_id must not be empty");
                self.machine_id = Some(machine_id);
                self.client_id
                    .get_or_insert_with(|| uuid::Uuid::now_v7().to_string());
                match (self.workspaces.values().any(|w| w.cloud.is_some()), store) {
                    (true, Some(path)) => self.persist(path),
                    _ => Ok(()),
                }
            }
            AuthChange::SignOut => {
                let target = self.active.clone();
                removed = self.remove_workspace(target.as_deref());
                match store {
                    Some(path) => self.persist(path),
                    None => Ok(()),
                }
            }
            AuthChange::SignOutWorkspace { base_url } => {
                removed = self.remove_workspace(Some(&session_store::normalize_base(&base_url)));
                match store {
                    Some(path) => self.persist(path),
                    None => Ok(()),
                }
            }
            AuthChange::Switch { base_url } => {
                let base = session_store::normalize_base(&base_url);
                anyhow::ensure!(
                    self.workspaces
                        .get(&base)
                        .is_some_and(|w| w.cloud.is_some()),
                    "no live session for {base}"
                );
                self.active = Some(base);
                match store {
                    Some(path) => self.persist(path),
                    None => Ok(()),
                }
            }
        };
        // Publish regardless of the persist outcome — the in-memory state is
        // the truth the links follow (a sign-out drops its link even if the
        // store write failed). Removed workspaces tear their link down; a
        // tokenless remaining one just parks (the channel survives — a
        // login step publishes None before identify fills the identity).
        if let Some(base) = removed {
            links.drop_link(&base);
        }
        self.publish(links);
        persisted
    }

    /// Stores one workspace's display name + logo and persists the store.
    /// The fetch happens in the caller, with no lock held: the session lock
    /// is a `std::sync::Mutex`, and holding it across the network await
    /// parks a worker thread the rest of the daemon needs. Returns false
    /// when the workspace is gone (the token changed while the fetch was
    /// out), so a stale fetch never writes into another account.
    pub fn apply_org_identity(
        &mut self,
        base_url: &str,
        name: String,
        logo: Option<String>,
        store: Option<&Path>,
    ) -> bool {
        let base = session_store::normalize_base(base_url);
        let Some(w) = self.workspaces.get_mut(&base) else {
            return false;
        };
        w.org_name = Some(name);
        w.org_logo_url = logo;
        if let Some(path) = store {
            let _ = self.persist(path);
        }
        true
    }

    /// Removes one workspace, returning its normalized base_url (the
    /// caller drops its link). The active pointer moves to another entry;
    /// an install left with no workspaces resets fully — the machine
    /// identity goes with it, the webview re-identifies on the next login
    /// (today's sign-out shape).
    fn remove_workspace(&mut self, base: Option<&str>) -> Option<String> {
        let removed = base.and_then(|base| {
            self.workspaces.remove(base);
            (!self.workspaces.contains_key(base)).then(|| base.to_string())
        });
        if self.workspaces.is_empty() {
            *self = Self::default();
            return removed;
        }
        if self
            .active
            .as_ref()
            .map_or(true, |a| !self.workspaces.contains_key(a))
        {
            self.active = self.workspaces.keys().next().cloned();
        }
        removed
    }

    /// Recomputes every machine-link config from the current state and
    /// publishes them: token-bearing (and identified) workspaces connect,
    /// tokenless entries drop their link. Also the boot-time publish (the
    /// daemon seeds the links from the restored sessions).
    pub fn publish(&mut self, links: &LinkRegistry) {
        // A link exists when the workspace is logged in AND the machine
        // identity was reported; the client id generates on first need —
        // and is only persisted when a link is actually built (an idle
        // publish must not resurrect identity after a full sign-out).
        let any_executable =
            self.machine_id.is_some() && self.workspaces.values().any(|w| w.cloud.is_some());
        let machine_id = self
            .machine_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let client_id = if any_executable {
            Some(
                self.client_id
                    .get_or_insert_with(|| uuid::Uuid::now_v7().to_string())
                    .clone(),
            )
        } else {
            self.client_id.clone()
        };
        let machine_name = hostname_label();
        let bases: Vec<String> = self.workspaces.keys().cloned().collect();
        for base in bases {
            let cfg = self.workspaces.get(&base).and_then(|w| {
                let token = &w.cloud.as_ref()?.token;
                any_executable.then(|| MachineLinkConfig {
                    base_url: base.clone(),
                    token: token.clone(),
                    machine_id: machine_id.clone(),
                    client_id: client_id.clone().unwrap(),
                    machine_name: machine_name.clone(),
                })
            });
            match cfg {
                Some(cfg) => links.publish(&base, Some(cfg)),
                None => links.publish(&base, None),
            }
        }
    }

    /// Adopts a store row reloaded by ANOTHER process (the token.json
    /// watcher — the store is the active-session mirror): memory only — no
    /// persist (the store is the source) and no publish (the watcher owns
    /// the link send with its own dedup).
    pub fn adopt_stored(&mut self, stored: &StoredSession) {
        let base = session_store::normalize_base(&stored.base_url);
        self.workspaces.insert(
            base.clone(),
            WorkspaceAuth {
                cloud: Some(CloudClient {
                    base_url: base.clone(),
                    token: stored.token.clone(),
                }),
                email: stored.email.clone(),
                org_name: stored.org_name.clone(),
                org_logo_url: stored.org_logo_url.clone(),
            },
        );
        self.machine_id = stored.machine_id.clone().or(self.machine_id.clone());
        self.client_id = stored.client_id.clone().or(self.client_id.clone());
        self.active = Some(base);
    }

    /// Memory-only removal of the ACTIVE workspace (its token.json mirror
    /// vanished under an external sign-out): the entry goes, remaining
    /// workspaces keep theirs, an install left empty resets fully. No
    /// persistence — the store file is the source and it no longer holds
    /// the active session. Link drops are the watcher's job.
    pub fn adopt_cleared_active(&mut self) {
        let target = self.active.clone();
        self.remove_workspace(target.as_deref());
    }

    /// The store rows for the current state.
    fn store(&self) -> WorkspaceStore {
        WorkspaceStore {
            active: self.active.clone(),
            workspaces: self
                .workspaces
                .iter()
                .map(|(base, w)| StoredSession {
                    base_url: base.clone(),
                    token: w
                        .cloud
                        .as_ref()
                        .map(|c| c.token.clone())
                        .unwrap_or_default(),
                    email: w.email.clone(),
                    machine_id: self.machine_id.clone(),
                    client_id: self.client_id.clone(),
                    machine_name: Some(hostname_label()),
                    org_name: w.org_name.clone(),
                    org_logo_url: w.org_logo_url.clone(),
                })
                .collect(),
        }
    }

    /// Persists the whole workspace store (sibling workspaces.json) and
    /// re-mirrors the ACTIVE session into token.json (cleared when the
    /// active entry has no token).
    fn persist(&self, token_path: &Path) -> anyhow::Result<()> {
        let store = self.store();
        session_store::save_store(&session_store::workspaces_path(token_path), &store)?;
        match self
            .active
            .as_ref()
            .and_then(|base| self.workspaces.get(base))
            .and_then(|w| w.cloud.as_ref())
        {
            Some(cloud) => session_store::save(
                token_path,
                &StoredSession {
                    base_url: cloud.base_url.clone(),
                    token: cloud.token.clone(),
                    email: self.email().map(str::to_owned),
                    machine_id: self.machine_id.clone(),
                    client_id: self.client_id.clone(),
                    machine_name: Some(hostname_label()),
                    org_name: self
                        .active
                        .as_ref()
                        .and_then(|b| self.workspaces.get(b))
                        .and_then(|w| w.org_name.clone()),
                    org_logo_url: self
                        .active
                        .as_ref()
                        .and_then(|b| self.workspaces.get(b))
                        .and_then(|w| w.org_logo_url.clone()),
                },
            ),
            None => session_store::clear(token_path),
        }
    }

    /// Restores the persisted store (workspaces.json, migrating a legacy
    /// token.json) into a fresh state — injectable store path (tests never
    /// touch the real config dir); `restored` is the default-path wrapper.
    pub async fn restored_at(token_path: &Path) -> anyhow::Result<Self> {
        let mut state = Self::default();
        let path = token_path;
        let store = session_store::load_store(&path);
        for row in &store.workspaces {
            let base = session_store::normalize_base(&row.base_url);
            let auth = if row.token.is_empty() {
                WorkspaceAuth {
                    cloud: None,
                    email: row.email.clone(),
                    org_name: row.org_name.clone(),
                    org_logo_url: row.org_logo_url.clone(),
                }
            } else {
                let cloud = CloudClient {
                    base_url: row.base_url.clone(),
                    token: row.token.clone(),
                };
                match cloud.me().await {
                    Ok(user) => {
                        // The switcher's identity data (name + logo):
                        // best-effort — a fetch failure keeps the row usable.
                        let (org_name, org_logo_url) = match cloud.org_settings().await {
                            Ok(v) => (Some(v.0), v.1),
                            Err(_) => (None, None),
                        };
                        WorkspaceAuth {
                            cloud: Some(cloud),
                            email: Some(user.email),
                            org_name,
                            org_logo_url,
                        }
                    }
                    Err(CloudError::Unauthorized) => WorkspaceAuth {
                        cloud: None,
                        email: row.email.clone(),
                        org_name: row.org_name.clone(),
                        org_logo_url: row.org_logo_url.clone(),
                    },
                    Err(_) => WorkspaceAuth {
                        // offline or server briefly down: keep the token
                        cloud: Some(cloud),
                        email: row.email.clone(),
                        org_name: row.org_name.clone(),
                        org_logo_url: row.org_logo_url.clone(),
                    },
                }
            };
            state.workspaces.insert(base, auth);
        }
        // Machine identity: per-install, shared by every row — any row that
        // carries it seeds the state (upgrade path for legacy token.json).
        state.machine_id = store
            .workspaces
            .iter()
            .find_map(|r| r.machine_id.clone())
            .or(state.machine_id);
        state.client_id = store
            .workspaces
            .iter()
            .find_map(|r| r.client_id.clone())
            .or(state.client_id);
        // Active pointer: the stored one when its entry survived with a
        // token, else the first token-bearing entry.
        state.active = store
            .active
            .filter(|a| state.workspaces.get(a).is_some_and(|w| w.cloud.is_some()))
            .or_else(|| {
                state
                    .workspaces
                    .iter()
                    .find(|(_, w)| w.cloud.is_some())
                    .map(|(base, _)| base.clone())
            });
        // The validation may have cleared tokens: write the pruned store
        // back so the mirror matches memory.
        if !store.workspaces.is_empty() {
            state.persist(&path).context("persist restored store")?;
        }
        anyhow::Ok(state)
    }

    /// Restores from the real store path (the daemon boot path).
    pub async fn restored() -> anyhow::Result<Self> {
        Self::restored_at(&session_store::default_path()?).await
    }
}
