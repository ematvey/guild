// Registry metadata reported on every machine connect: the durable hardware
// fingerprint (the re-pair adoption hint), the OS and its version, the app
// version, and the hostname label.

/// Unavailable values are omitted — the server stores NULL.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct MachineMeta {
    pub fingerprint: Option<String>,
    pub os: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
}

fn non_empty(v: &str) -> Option<String> {
    let t = v.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Stable per-install hardware identity, lowercase-trimmed: MachineGuid on
/// Windows, /etc/machine-id on Linux, IOPlatformUUID on macOS.
#[cfg(windows)]
fn machine_fingerprint() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .ok()?;
    let guid: String = key.get_value("MachineGuid").ok()?;
    non_empty(&guid).map(|v| v.to_lowercase())
}

#[cfg(target_os = "linux")]
fn machine_fingerprint() -> Option<String> {
    let raw = std::fs::read_to_string("/etc/machine-id").ok()?;
    non_empty(&raw).map(|v| v.to_lowercase())
}

#[cfg(target_os = "macos")]
fn machine_fingerprint() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.contains("IOPlatformUUID"))?;
    let value = line.split('"').nth(3)?;
    non_empty(value).map(|v| v.to_lowercase())
}

/// Human-facing OS version (e.g. "24H2", "15.5"), trimmed.
#[cfg(windows)]
fn machine_os_version() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?;
    let version: String = key
        .get_value("DisplayVersion")
        .or_else(|_| key.get_value("CurrentVersion"))
        .ok()?;
    non_empty(&version)
}

#[cfg(target_os = "linux")]
fn machine_os_version() -> Option<String> {
    if let Ok(release) = std::fs::read_to_string("/etc/os-release") {
        for line in release.lines() {
            if let Some(value) = line.strip_prefix("VERSION_ID=") {
                if let Some(v) = non_empty(value.trim().trim_matches('"')) {
                    return Some(v);
                }
            }
        }
    }
    let kernel = std::process::Command::new("uname")
        .arg("-r")
        .output()
        .ok()?;
    non_empty(&String::from_utf8_lossy(&kernel.stdout))
}

#[cfg(target_os = "macos")]
fn machine_os_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    non_empty(&String::from_utf8_lossy(&output.stdout))
}

pub fn machine_meta() -> MachineMeta {
    MachineMeta {
        fingerprint: machine_fingerprint(),
        os: Some(std::env::consts::OS.to_string()),
        os_version: machine_os_version(),
        app_version: non_empty(env!("CARGO_PKG_VERSION")),
    }
}

/// Hostname label reported at connect: COMPUTERNAME on Windows,
/// /etc/hostname elsewhere.
pub fn hostname_label() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "guild-machine".to_string())
}
