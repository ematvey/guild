//! Installation-local release channel and the signed updater lifecycle.
use guild_app_server::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Develop,
}

impl UpdateChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Develop => "develop",
        }
    }
    fn default_for(version: &str) -> Self {
        if version.contains('-') {
            Self::Develop
        } else {
            Self::Stable
        }
    }
}

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    pub channel: UpdateChannel,
    pub phase: &'static str,
    pub pending_version: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct UpdateContext {
    server: String,
    channel: UpdateChannel,
    generation: u64,
    observed_version: Option<String>,
}
struct Pending {
    context: UpdateContext,
    update: Update,
    bytes: Vec<u8>,
}
struct UpdateData {
    status: UpdateStatus,
    generation: u64,
    pending: Option<Pending>,
    last_check: Option<Instant>,
    server_identity: Option<(String, String)>,
}
impl UpdateData {
    fn observe_server(&mut self, server: String, version: String) {
        let identity = (server, version);
        if self.server_identity.as_ref() == Some(&identity) || self.status.phase == "installing" {
            return;
        }
        self.server_identity = Some(identity);
        self.generation += 1;
        self.pending = None;
        self.status.pending_version = None;
        self.last_check = None;
        if self.status.phase != "disabled" {
            self.status.phase = "idle";
        }
    }
}
pub struct UpdateState {
    data: Mutex<UpdateData>,
    checking: tokio::sync::Mutex<()>,
}

fn channel_path() -> std::path::PathBuf {
    guild_app_server::fs_bridge::guild_config_dir().join("update-channel")
}

fn save_channel(path: &Path, channel: UpdateChannel) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("missing config directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&temporary, channel.as_str()).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn load_channel(path: &Path, version: &str) -> Result<UpdateChannel, String> {
    match std::fs::read_to_string(path) {
        Ok(value) => match value.trim() {
            "stable" => Ok(UpdateChannel::Stable),
            "develop" => Ok(UpdateChannel::Develop),
            _ => Err("Invalid saved update channel".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let channel = UpdateChannel::default_for(version);
            save_channel(path, channel)?;
            Ok(channel)
        }
        Err(e) => Err(e.to_string()),
    }
}

impl Default for UpdateState {
    fn default() -> Self {
        let loaded = load_channel(&channel_path(), env!("CARGO_PKG_VERSION"));
        let channel = loaded.as_ref().copied().unwrap_or(UpdateChannel::Stable);
        let disabled = cfg!(debug_assertions) && std::env::var("GUILD_UPDATER_FORCE").is_err();
        Self {
            data: Mutex::new(UpdateData {
                status: UpdateStatus {
                    channel,
                    phase: if disabled { "disabled" } else { "idle" },
                    pending_version: None,
                    message: loaded.err(),
                },
                generation: 0,
                pending: None,
                last_check: None,
                server_identity: None,
            }),
            checking: tokio::sync::Mutex::new(()),
        }
    }
}

fn paired_server() -> Option<String> {
    let path = guild_app_server::session_store::default_path().ok()?;
    guild_app_server::session_store::load(&path)
        .map(|s| s.base_url.trim_end_matches('/').to_string())
}

fn context(state: &UpdateState) -> Option<UpdateContext> {
    let server = paired_server()?;
    let data = state.data.guard();
    Some(UpdateContext {
        observed_version: data
            .server_identity
            .as_ref()
            .filter(|(url, _)| url == &server)
            .map(|(_, version)| version.clone()),
        server,
        channel: data.status.channel,
        generation: data.generation,
    })
}

fn publish(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let snapshot = state.data.guard().status.clone();
    let _ = app.emit("update-status", snapshot);
}

fn complete(
    app: &AppHandle,
    expected: &UpdateContext,
    phase: &'static str,
    message: Option<String>,
) {
    let state = app.state::<UpdateState>();
    if context(&state).as_ref() != Some(expected) {
        return;
    }
    {
        let mut data = state.data.guard();
        if data.generation != expected.generation || data.status.channel != expected.channel {
            return;
        }
        data.status.pending_version = if phase == "ready" {
            data.pending.as_ref().map(|p| p.update.version.clone())
        } else {
            None
        };
        data.status.phase = phase;
        data.status.message = message;
    }
    publish(app);
}

fn eligible(
    version: &str,
    current: &str,
    manifest: &serde_json::Value,
    channel: UpdateChannel,
) -> bool {
    let Ok(version) = version.parse::<semver::Version>() else {
        return false;
    };
    let Ok(current) = current.parse::<semver::Version>() else {
        return false;
    };
    let Some(server) = manifest
        .get("server_version")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<semver::Version>().ok())
    else {
        return false;
    };
    manifest.get("channel").and_then(|v| v.as_str()) == Some(channel.as_str())
        && version.cmp_precedence(&current).is_gt()
        && !version.cmp_precedence(&server).is_gt()
        && version.pre.is_empty() == (channel == UpdateChannel::Stable)
}

async fn candidate(app: &AppHandle, expected: &UpdateContext) -> Result<Option<Update>, String> {
    let endpoint = format!(
        "{}/api/v1/updates/latest.json?channel={}",
        expected.server,
        expected.channel.as_str()
    );
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .endpoints(vec![endpoint
            .parse()
            .map_err(|e| format!("Invalid update endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let result = updater.check().await.map_err(|e| e.to_string())?;
    if let Some(update) = result.as_ref() {
        if expected.observed_version.as_deref().is_some_and(|v| {
            update
                .raw_json
                .get("server_version")
                .and_then(|s| s.as_str())
                != Some(v)
        }) {
            return Err("The server version changed; waiting for the current connection".into());
        }
    }
    match result {
        Some(update)
            if eligible(
                &update.version,
                &app.package_info().version.to_string(),
                &update.raw_json,
                expected.channel,
            ) =>
        {
            Ok(Some(update))
        }
        Some(_) => Err("The offered update does not match this channel or server version".into()),
        None => Ok(None),
    }
}

pub async fn check(app: &AppHandle, force: bool) {
    if cfg!(debug_assertions) && std::env::var("GUILD_UPDATER_FORCE").is_err() {
        return;
    }
    let state = app.state::<UpdateState>();
    let _check = state.checking.lock().await;
    let Some(expected) = context(&state) else {
        {
            let mut data = state.data.guard();
            data.pending = None;
            data.status.pending_version = None;
            data.status.phase = "idle";
        }
        publish(app);
        return;
    };
    {
        let mut data = state.data.guard();
        if data.pending.as_ref().is_some_and(|p| p.context != expected) {
            data.pending = None;
            data.status.pending_version = None;
        }
        if !force
            && data
                .last_check
                .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
        {
            return;
        }
        data.last_check = Some(Instant::now());
        data.status.phase = "checking";
        data.status.pending_version = None;
        data.status.message = None;
    }
    publish(app);
    let update = match candidate(app, &expected).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            let mut data = state.data.guard();
            if data.generation == expected.generation {
                data.pending = None;
                data.status.pending_version = None;
            }
            drop(data);
            complete(app, &expected, "idle", None);
            return;
        }
        Err(e) => {
            complete(app, &expected, "error", Some(e));
            return;
        }
    };
    if context(&state).as_ref() != Some(&expected) {
        return;
    }
    if state.data.guard().pending.as_ref().is_some_and(|p| {
        p.context == expected
            && p.update.version == update.version
            && p.update.signature == update.signature
    }) {
        complete(app, &expected, "ready", None);
        return;
    }
    let bytes = match update
        .download(
            |chunk, total| {
                let _ = app.emit(
                    "update-progress",
                    serde_json::json!({ "chunk": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(e) => {
            complete(app, &expected, "error", Some(e.to_string()));
            return;
        }
    };
    if context(&state).as_ref() != Some(&expected) {
        return;
    }
    {
        let mut data = state.data.guard();
        if data.generation != expected.generation || data.status.channel != expected.channel {
            return;
        }
        data.status.pending_version = Some(update.version.clone());
        data.pending = Some(Pending {
            context: expected.clone(),
            update,
            bytes,
        });
    }
    complete(app, &expected, "ready", None);
}

#[tauri::command]
pub fn update_status(app: AppHandle, state: State<'_, UpdateState>) -> UpdateStatus {
    let current = context(&state);
    let mut data = state.data.guard();
    if data
        .pending
        .as_ref()
        .is_some_and(|p| current.as_ref() != Some(&p.context))
    {
        data.pending = None;
        data.status.pending_version = None;
        data.status.phase = "idle";
        drop(data);
        publish(&app);
        return state.data.guard().status.clone();
    }
    data.status.clone()
}

#[tauri::command]
pub async fn set_update_channel(
    app: AppHandle,
    state: State<'_, UpdateState>,
    channel: UpdateChannel,
) -> Result<UpdateStatus, String> {
    {
        let mut data = state.data.guard();
        if data.status.phase == "installing" {
            return Err("An update is already being installed".into());
        }
        save_channel(&channel_path(), channel)?;
        data.generation += 1;
        data.pending = None;
        data.last_check = None;
        data.status = UpdateStatus {
            channel,
            phase: "idle",
            pending_version: None,
            message: None,
        };
    }
    publish(&app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        check(&handle, true).await;
    });
    Ok(state.data.guard().status.clone())
}

#[tauri::command]
pub async fn check_update_now(app: AppHandle, force: Option<bool>, server_version: Option<String>) {
    if let (Some(server), Some(version)) = (paired_server(), server_version) {
        let state = app.state::<UpdateState>();
        {
            let mut data = state.data.guard();
            data.observe_server(server, version);
        }
        publish(&app);
    }
    check(&app, force.unwrap_or(false)).await;
}

#[tauri::command]
pub fn pending_update_version(app: AppHandle, state: State<'_, UpdateState>) -> Option<String> {
    update_status(app, state).pending_version
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let _check = state.checking.lock().await;
    let expected = context(&state).ok_or("Pair a server before updating")?;
    let fresh = match candidate(&app, &expected).await {
        Ok(Some(update)) => update,
        other => {
            let message = match other {
                Err(e) => e,
                _ => "This server no longer offers the downloaded update".into(),
            };
            complete(&app, &expected, "error", Some(message.clone()));
            return Err(message);
        }
    };
    if context(&state).as_ref() != Some(&expected) {
        return Err("Update channel or paired server changed".into());
    }
    let pending = {
        let mut data = state.data.guard();
        let valid = data.pending.as_ref().is_some_and(|p| {
            p.context == expected
                && p.update.version == fresh.version
                && p.update.signature == fresh.signature
        });
        if !valid {
            data.pending = None;
            data.status.pending_version = None;
            data.status.phase = "idle";
            drop(data);
            publish(&app);
            return Err("Check for updates again before installing".into());
        }
        data.status.phase = "installing";
        data.pending.take().ok_or("No pending update")?
    };
    publish(&app);
    if let Err(e) = pending.update.install(&pending.bytes) {
        {
            let mut data = state.data.guard();
            if data.generation == expected.generation {
                data.pending = Some(pending);
            }
        }
        complete(&app, &expected, "ready", Some(e.to_string()));
        return Err(e.to_string());
    }
    app.request_restart();
    #[allow(unreachable_code)]
    Ok(())
}

pub fn start_update_checker(app: AppHandle) {
    if cfg!(debug_assertions) && std::env::var("GUILD_UPDATER_FORCE").is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            check(&app, false).await;
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ceiling_and_channel_are_both_required() {
        let m = serde_json::json!({"server_version":"0.6.128-dev.200", "channel":"develop"});
        assert!(eligible(
            "0.6.128-dev.150",
            "0.6.128-dev.100",
            &m,
            UpdateChannel::Develop
        ));
        assert!(!eligible(
            "0.6.128-dev.250",
            "0.6.128-dev.100",
            &m,
            UpdateChannel::Develop
        ));
        assert!(!eligible(
            "0.6.128-dev.100",
            "0.6.128-dev.150",
            &m,
            UpdateChannel::Develop
        ));
        assert!(!eligible(
            "0.6.128-dev.150",
            "0.6.128-dev.100",
            &m,
            UpdateChannel::Stable
        ));
        assert!(!eligible(
            "0.6.128-dev.150",
            "0.6.128-dev.100",
            &serde_json::json!({}),
            UpdateChannel::Develop
        ));
        let stable = serde_json::json!({"server_version":"0.6.127", "channel":"stable"});
        assert!(eligible(
            "0.6.127",
            "0.6.126",
            &stable,
            UpdateChannel::Stable
        ));
        assert!(!eligible(
            "0.6.128",
            "0.6.126",
            &stable,
            UpdateChannel::Stable
        ));
    }
    #[test]
    fn channel_persists_across_build_types() {
        let path = std::env::temp_dir()
            .join(format!("guild-update-channel-test-{}", std::process::id()))
            .join("channel");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
        assert_eq!(
            load_channel(&path, "0.6.127-dev.1").unwrap(),
            UpdateChannel::Develop
        );
        assert_eq!(
            load_channel(&path, "0.6.127").unwrap(),
            UpdateChannel::Develop
        );
        save_channel(&path, UpdateChannel::Stable).unwrap();
        assert_eq!(
            load_channel(&path, "0.6.128-dev.1").unwrap(),
            UpdateChannel::Stable
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn server_version_changes_invalidate_offers_without_changing_installation_channel() {
        let mut data = UpdateData {
            status: UpdateStatus {
                channel: UpdateChannel::Develop,
                phase: "ready",
                pending_version: Some("0.6.128-dev.250".into()),
                message: None,
            },
            generation: 7,
            pending: None,
            last_check: Some(Instant::now()),
            server_identity: Some(("http://localhost:18080".into(), "0.6.128-dev.300".into())),
        };
        data.observe_server("http://localhost:18080".into(), "0.6.128-dev.200".into());
        assert_eq!(data.generation, 8);
        assert_eq!(data.status.pending_version, None);
        assert_eq!(data.last_check, None);
        assert_eq!(data.status.channel, UpdateChannel::Develop);
        data.observe_server("http://localhost:18080".into(), "0.6.128-dev.200".into());
        assert_eq!(data.generation, 8);
        data.observe_server("http://localhost:18081".into(), "0.6.128-dev.200".into());
        assert_eq!(data.generation, 9);
        assert_eq!(data.status.channel, UpdateChannel::Develop);
    }
}
