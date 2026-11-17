//! guild-app-server — the local engine (spec §3.2) as a standalone binary.
//! The shipped desktop app links the same library and runs the engine
//! in-process; this
//! binary is the dev/test and headless-host surface.
//!
//! - No args: JSON-RPC loop on stdio (dev/test surface).
//! - `daemon`: host the engine's local socket headless — the same engine
//!   and dispatch surface the app hosts in-process.
//! - `daemon install [--linger]` / `status` / `uninstall`: manage the
//!   headless host as a systemd user unit (Linux).
//! - `login --url U --email E --password P`: login via the socket host.
//! - `chat --model M "text"`: chat round-trip via the socket host.

use guild_app_server::{cli, jsonrpc_loop};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            // Restore a persisted session so a GUI reload (F5) or an app
            // restart keeps auth; a dead token is dropped, a transient
            // network failure is not.
            let session = rt.block_on(jsonrpc_loop::restored_session())?;
            let (session, _writer) = rt.block_on(jsonrpc_loop::serve(
                std::io::stdin(),  // Stdin handle: Read + Send + 'static
                std::io::stdout(), // Stdout handle: Write + Send + 'static
                session,
            ))?;
            let _ = session;
            Ok(())
        }
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
        Some("login") => cli::cmd_login(&args[1..]),
        Some("chat") => cli::cmd_chat(&args[1..]),
        Some("publish") => cli::cmd_publish(&args[1..]),
        Some("install") => cli::cmd_install(&args[1..]),
        Some("verify") => cli::cmd_verify(&args[1..]),
        Some(other) => anyhow::bail!(
            "unknown subcommand {other}; expected none, daemon [install|status|uninstall], login, chat, publish, install, or verify"
        ),
    }
}
