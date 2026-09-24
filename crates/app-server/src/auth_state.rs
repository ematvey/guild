//! Auth state: the cloud session (token + email), the machine identity
//! (webview-reported `machine_id` + generated `client_id`), token.json
//! persistence, and machine-link publication. Every auth transition —
//! `login`, `pair`, `machine.identify`, `session.clear` — goes through
//! [`AuthState::transition`]: mutate ⇒ persist ⇒ publish is ONE method, so
//! the three steps cannot drift apart.

use crate::cloud::{CloudClient, CloudError};
use crate::machine_link::MachineLinkConfig;
use crate::session_store::{self, StoredSession};
use anyhow::Context as _;
use std::path::Path;
use tokio::sync::watch;

/// The `Session`'s auth fields. The struct is public, its fields are
/// private: reads go through the accessors, every mutation through
/// [`AuthState::transition`].
#[derive(Clone, Default)]
pub struct AuthState {
    cloud: Option<CloudClient>,
    email: Option<String>,
    /// The webview-generated machine identity (stable per app install)
    /// once reported via `machine.identify`; the executor link keys on it.
    machine_id: Option<String>,
    /// Stable per-daemon-install WS presence key, generated on first
    /// identify and persisted with the session.
    client_id: Option<String>,
}

/// One auth transition. The RPC verbs map 1:1 onto these.
#[derive(Debug, Clone)]
pub enum AuthChange {
    /// `login` / `pair`: adopt a cloud session (always persists).
    Login {
        base_url: String,
        token: String,
        email: String,
    },
    /// `machine.identify`: record the webview-reported identity. Persists
    /// only alongside a live session — an anonymous identify stays in
    /// memory until login adopts it.
    Identify { machine_id: String },
    /// `session.clear`: drop everything in memory and the persisted token,
    /// so the next boot shows the pair/sign-in screen instead of
    /// re-logging in silently.
    SignOut,
}

impl AuthState {
    /// Assembles a state from parts. The restore path and tests use this;
    /// RPC transitions never do (they go through [`AuthState::transition`]).
    pub fn from_parts(
        cloud: Option<CloudClient>,
        email: Option<String>,
        machine_id: Option<String>,
        client_id: Option<String>,
    ) -> Self {
        Self {
            cloud,
            email,
            machine_id,
            client_id,
        }
    }

    pub fn cloud(&self) -> Option<&CloudClient> {
        self.cloud.as_ref()
    }

    pub fn email(&self) -> Option<&str> {
        self.email.as_deref()
    }

    pub fn machine_id(&self) -> Option<&str> {
        self.machine_id.as_deref()
    }

    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    /// The ONE transition method: apply the change to the in-memory state,
    /// persist (or clear) token.json, then publish the machine-link config —
    /// exactly one persist and one publish per call. `store` is the
    /// token.json path (`None` skips persistence — tests); `link` is the
    /// machine link's config channel.
    pub fn transition(
        &mut self,
        change: AuthChange,
        store: Option<&Path>,
        link: &watch::Sender<Option<MachineLinkConfig>>,
    ) -> anyhow::Result<()> {
        let persisted = match change {
            AuthChange::Login {
                base_url,
                token,
                email,
            } => {
                self.cloud = Some(CloudClient {
                    base_url: base_url.clone(),
                    token: token.clone(),
                });
                self.email = Some(email.clone());
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
                match (self.cloud.is_some(), store) {
                    (true, Some(path)) => self.persist(path),
                    _ => Ok(()),
                }
            }
            AuthChange::SignOut => {
                *self = Self::default();
                match store {
                    Some(path) => session_store::clear(path),
                    None => Ok(()),
                }
            }
        };
        // Publish regardless of the persist outcome — the in-memory state is
        // the truth the link follows (a sign-out drops the link even if the
        // token file was already gone).
        self.publish(link);
        persisted
    }

    /// Recomputes the machine-link config from the current state and
    /// publishes it on the link's watch channel. A link exists when the
    /// session is logged in AND a machine identity was reported; the WS
    /// presence client id is generated on first need. Also the boot-time
    /// publish (the daemon seeds the link from the restored session).
    pub fn publish(&mut self, link: &watch::Sender<Option<MachineLinkConfig>>) {
        let cfg = match (&self.cloud, &self.machine_id) {
            (Some(cloud), Some(machine_id)) => {
                let client_id = self
                    .client_id
                    .get_or_insert_with(|| uuid::Uuid::now_v7().to_string())
                    .clone();
                Some(MachineLinkConfig {
                    base_url: cloud.base_url.clone(),
                    token: cloud.token.clone(),
                    machine_id: machine_id.to_string(),
                    client_id,
                    machine_name: crate::machine_link::hostname_label(),
                })
            }
            _ => None,
        };
        let _ = link.send(cfg);
    }

    /// Adopts a store reloaded by ANOTHER process (the token.json watcher):
    /// memory only — no persist (the store is the source) and no publish
    /// (the watcher owns the link send with its own dedup).
    pub fn adopt_stored(&mut self, stored: &session_store::StoredSession) {
        self.cloud = Some(CloudClient {
            base_url: stored.base_url.clone(),
            token: stored.token.clone(),
        });
        self.email = stored.email.clone();
        self.machine_id = stored.machine_id.clone();
        self.client_id = stored.client_id.clone();
    }

    /// The store row for the current state (`Some` while logged in).
    fn stored(&self) -> Option<StoredSession> {
        let cloud = self.cloud.as_ref()?;
        Some(StoredSession {
            base_url: cloud.base_url.clone(),
            token: cloud.token.clone(),
            email: self.email.clone(),
            machine_id: self.machine_id.clone(),
            client_id: self.client_id.clone(),
            machine_name: Some(crate::machine_link::hostname_label()),
        })
    }

    fn persist(&self, path: &Path) -> anyhow::Result<()> {
        let stored = self.stored().context("no session to persist")?;
        session_store::save(path, &stored)
    }

    /// Restores the persisted session (token.json) into a fresh state, so
    /// an app restart or a GUI engine re-spawn keeps auth. A dead token is
    /// dropped, a transient network failure is not.
    pub async fn restored() -> anyhow::Result<Self> {
        let mut state = Self::default();
        let path = session_store::default_path()?;
        if let Some(stored) = session_store::load(&path) {
            let cloud = CloudClient {
                base_url: stored.base_url.clone(),
                token: stored.token,
            };
            state.machine_id = stored.machine_id.clone();
            state.client_id = stored.client_id.clone();
            match cloud.me().await {
                Ok(user) => {
                    state.email = Some(user.email.clone());
                    state.cloud = Some(cloud.clone());
                    // Upgrade old stores that lacked the email. The row is
                    // written as-is (preserving the stored machine label) —
                    // not through persist(), which stamps the hostname.
                    if stored.email.is_none() {
                        session_store::save(
                            &path,
                            &StoredSession {
                                base_url: stored.base_url,
                                token: cloud.token,
                                email: Some(user.email),
                                machine_id: stored.machine_id,
                                client_id: stored.client_id,
                                machine_name: stored.machine_name,
                            },
                        )?;
                    }
                }
                Err(CloudError::Unauthorized) => {
                    let _ = session_store::clear(&path);
                }
                Err(_) => {
                    // offline or server briefly down: keep the token
                    state.cloud = Some(cloud);
                    state.email = stored.email;
                }
            }
        }
        anyhow::Ok(state)
    }
}
