//! Single Guild client binary:
//! - no args  → GUI (Tauri window); hosts the engine, the CLI socket, and
//!   the member WS link in-process (single-process design — nothing spawns
//!   a daemon automatically)
//! - `daemon` → the same engine headless on the local socket (manual
//!   fallback for debugging; CLI verbs require the GUI instead)
//! - `daemon install [--linger]` / `status` / `uninstall` → manage the
//!   daemon as a systemd user unit (Linux); the unit owns the executor
//!   while active and the GUI defers to it, so install works while the
//!   GUI is up
//! - `login` / `chat` / `publish` / `install` / `verify` → headless CLI
//!   (cloud-touching verbs go through the daemon); `login` takes either
//!   `--url/--email/--password` or `--token <pairing-code>`
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(windows, not(debug_assertions)))]
fn attach_parent_console() {
    // windows_subsystem="windows" detaches from the console; headless
    // subcommands re-attach so println! output is visible.
    const ATTACH_PARENT_PROCESS: u32 = 1;
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
fn attach_parent_console() {}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("gui") && !args.is_empty() {
        attach_parent_console();
    }
    match args.first().map(String::as_str) {
        None => {
            guild_desktop::run();
            Ok(())
        }
        // Headless host of the local socket (manual fallback): the same
        // engine and dispatch surface the GUI process serves in-process.
        // The install/status/uninstall sub-verbs dispatch here: this is the
        // binary release builds ship as `Guild`, and headless hosts run it too.
        Some("daemon") => match args.get(1).map(String::as_str) {
            Some("install") => guild_app_server::daemon_install::install(
                args.iter().any(|a| a == "--linger"),
            ),
            Some("status") => guild_app_server::daemon_install::status(),
            Some("uninstall") => guild_app_server::daemon_install::uninstall(),
            _ => {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?;
                rt.block_on(guild_app_server::daemon::run_daemon())?;
                // Shutdown is unconditional: exit now instead of waiting for
                // open client connections (a client holding its socket would
                // deadlock the runtime teardown).
                std::process::exit(0);
            }
        },
        Some("login") => guild_app_server::cli::cmd_login(&args[1..]),
        Some("chat") => guild_app_server::cli::cmd_chat(&args[1..]),
        Some("publish") => guild_app_server::cli::cmd_publish(&args[1..]),
        Some("install") => guild_app_server::cli::cmd_install(&args[1..]),
        Some("verify") => guild_app_server::cli::cmd_verify(&args[1..]),
        Some(other) => anyhow::bail!(
            "unknown subcommand {other:?}; expected none (GUI), daemon [install|status|uninstall], login [--token CODE | --url U --email E --password P], chat, publish, install, or verify"
        ),
    }
}
