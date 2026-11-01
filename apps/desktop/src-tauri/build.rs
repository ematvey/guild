fn main() {
    // Every app command the webview may invoke. Declaring the list makes
    // each command opt-in: capabilities/default.json grants exactly these,
    // and a command not granted there is not callable from the webview.
    const COMMANDS: &[&str] = &[
        "check_update_now",
        "start_engine",
        "rpc_submit",
        "rpc_poll",
        "list_wsl_distros",
        "wsl_home",
        "wsl_pretty_name",
        "list_dir",
        "daemon_trace_state",
        "set_daemon_trace",
        "install_update",
        "pending_update_version",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build");
}
