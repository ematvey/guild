//! Workspace classification for tool workdirs (spec §4): a
//! `\\wsl.localhost\<distro>\…` workdir routes shell and file tools through
//! wsl.exe into the distro; everything else runs directly on the host.

use std::path::Path;

/// Where a tool's workdir lives. Derived from the workdir path alone — no
/// machine-OS lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceKind {
    Unix,
    WindowsNative,
    Wsl { distro: String },
}

/// Classify a tool workdir. UNC `\\wsl.localhost\<d>\…` and legacy
/// `\\wsl$\<d>\…` map to `Wsl` (case-insensitive prefix, either slash
/// direction); Windows drive paths and other UNC shares map to
/// `WindowsNative`; everything else follows the host OS.
pub fn classify(workdir: &Path) -> WorkspaceKind {
    match parse_wsl(workdir) {
        Some((distro, _)) => WorkspaceKind::Wsl { distro },
        None => {
            if is_windows_drive(workdir) || is_unc(workdir) || cfg!(windows) {
                WorkspaceKind::WindowsNative
            } else {
                WorkspaceKind::Unix
            }
        }
    }
}

/// Linux path inside the distro for a WSL UNC path: separators normalized
/// to `/`, the distro segment replaced by the leading `/`. Accepts the
/// `\\?\UNC\…` device form Windows canonicalize can return. `None` for
/// non-WSL paths.
pub fn to_inner(path: &Path) -> Option<String> {
    parse_wsl(path).map(|(_, inner)| inner)
}

/// Splits a WSL UNC path into `(distro, inner Linux path)`. String-level on
/// purpose: the same literal must classify the same way on Windows hosts
/// (where it is a real UNC `Path`) and on Linux (where it is a plain
/// backslash string, so unit tests can run here).
fn parse_wsl(path: &Path) -> Option<(String, String)> {
    let mut norm = path.to_string_lossy().replace('\\', "/");
    // Device-form UNC (`\\?\UNC\wsl.localhost\…`) — canonicalize on Windows
    // can produce it; treat it as the plain `\\` form.
    if norm.len() >= 8 && norm[..8].eq_ignore_ascii_case("//?/unc/") {
        norm = format!("//{}", &norm[8..]);
    }
    let low = norm.to_ascii_lowercase();
    const P_STD: &str = "//wsl.localhost/";
    const P_LEGACY: &str = "//wsl$/";
    let after = if low.starts_with(P_STD) {
        P_STD.len()
    } else if low.starts_with(P_LEGACY) {
        P_LEGACY.len()
    } else {
        return None;
    };
    let mut parts = norm[after..].split('/').filter(|p| !p.is_empty());
    let distro = parts.next()?;
    let inner = format!("/{}", parts.collect::<Vec<_>>().join("/"));
    Some((distro.to_string(), inner))
}

/// Windows drive path (`C:`, `C:\…`) — Windows-shaped regardless of host OS.
fn is_windows_drive(path: &Path) -> bool {
    let s = path.to_string_lossy();
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// UNC share (`\\server\share`, either slash direction, with or without the
/// `\\?\` device prefix).
fn is_unc(path: &Path) -> bool {
    path.to_string_lossy().replace('\\', "/").starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wsl(distro: &str) -> WorkspaceKind {
        WorkspaceKind::Wsl {
            distro: distro.to_string(),
        }
    }

    #[test]
    fn classify_wsl_unc_both_spellings_and_slash_directions() {
        assert_eq!(
            classify(Path::new(r"\\wsl.localhost\Ubuntu\home\me\proj")),
            wsl("Ubuntu")
        );
        assert_eq!(
            classify(Path::new(r"\\wsl$\Ubuntu\home\me\proj")),
            wsl("Ubuntu")
        );
        assert_eq!(
            classify(Path::new(r"\\WSL.LOCALHOST\archlinux\root\work")),
            wsl("archlinux")
        );
        assert_eq!(
            classify(Path::new(r"\\Wsl$\Debian\home\x")),
            wsl("Debian")
        );
        assert_eq!(
            classify(Path::new("//wsl.localhost/debian/home/x")),
            wsl("debian")
        );
        assert_eq!(
            classify(Path::new("//wsl$/fedora/home/x")),
            wsl("fedora")
        );
        assert_eq!(
            classify(Path::new(r"\\wsl.localhost\Ubuntu-22.04\home\me")),
            wsl("Ubuntu-22.04")
        );
    }

    #[test]
    fn classify_non_wsl() {
        assert_eq!(
            classify(Path::new(r"C:\Users\me\proj")),
            WorkspaceKind::WindowsNative
        );
        assert_eq!(
            classify(Path::new("D:/data/proj")),
            WorkspaceKind::WindowsNative
        );
        assert_eq!(
            classify(Path::new(r"\\fileserver\share\proj")),
            WorkspaceKind::WindowsNative
        );
        assert_eq!(classify(Path::new("/home/me/proj")), WorkspaceKind::Unix);
        assert_eq!(classify(Path::new("relative/dir")), WorkspaceKind::Unix);
    }

    #[test]
    fn classify_wsl_prefixes_must_be_exact() {
        // Near-miss prefixes stay non-WSL.
        assert_eq!(
            classify(Path::new(r"\\wsl.localhostx\Ubuntu\home")),
            WorkspaceKind::WindowsNative
        );
        assert_eq!(
            classify(Path::new(r"\\wsl\Ubuntu\home")),
            WorkspaceKind::WindowsNative
        );
        // No distro segment → not a WSL workspace.
        assert_eq!(
            classify(Path::new(r"\\wsl.localhost")),
            WorkspaceKind::WindowsNative
        );
    }

    #[test]
    fn to_inner_converts_and_normalizes() {
        assert_eq!(
            to_inner(Path::new(r"\\wsl.localhost\Ubuntu\home\me\proj")),
            Some("/home/me/proj".to_string())
        );
        assert_eq!(
            to_inner(Path::new(r"\\wsl$\Ubuntu\home\a b\c'd")),
            Some("/home/a b/c'd".to_string())
        );
        assert_eq!(
            to_inner(Path::new("//wsl.localhost/debian/home/x")),
            Some("/home/x".to_string())
        );
        // Distro root (no path beyond the distro) maps to the filesystem root.
        assert_eq!(to_inner(Path::new(r"\\wsl.localhost\Ubuntu")), Some("/".to_string()));
        // Mixed separators and doubled separators collapse cleanly.
        assert_eq!(
            to_inner(Path::new(r"\\wsl$\Ubuntu\/home//x/y")),
            Some("/home/x/y".to_string())
        );
        assert_eq!(to_inner(Path::new(r"C:\Users\me")), None);
        assert_eq!(to_inner(Path::new("/home/me")), None);
    }

    #[test]
    fn to_inner_accepts_device_form_from_canonicalize() {
        let p = Path::new(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\proj");
        assert_eq!(classify(p), wsl("Ubuntu"));
        assert_eq!(to_inner(p), Some("/home/me/proj".to_string()));
    }
}
