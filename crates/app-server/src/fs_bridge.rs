//! The file bridge: primitive, allowlisted filesystem operations the
//! webview calls over the RPC channel (unification spec §3 item 2). The
//! discovery *logic* (skills index, AGENTS.md chain, `/name` expansion)
//! lives in TS (`apps/desktop/src/lib/context.ts`); Rust only touches
//! bytes — reads/writes/existence/listing inside the allowlist.
//!
//! Read roots: the bound project folder, its ancestor chain up to and
//! including the git root (Codex semantics — the AGENTS.md chain and repo
//! `.agents/skills` live there), the Guild config dir, and the user's
//! shared `~/.agents`. Existence probes additionally walk above the git
//! root (that is how the root is *found*); reads never do. Write roots:
//! the config dir and the project folder.

use anyhow::Context as _;
use std::path::{Path, PathBuf};

/// What one fs.* call may touch, resolved fresh per call from the
/// session's bound project (cheap: a handful of metadata probes).
pub struct Allowlist {
    pub read: Vec<PathBuf>,
    pub exists: Vec<PathBuf>,
    pub write: Vec<PathBuf>,
    /// The bound project (relative request paths anchor here).
    pub project: Option<PathBuf>,
    /// Ancestors of the project (the `.git`-probe walk only).
    walk_ancestors: Vec<PathBuf>,
}

/// The Guild config dir (settings.json, global AGENTS.md, legacy skills).
pub fn guild_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join("guild")
}

/// The platform home (user skill scope `~/.agents` lives here).
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

impl Allowlist {
    /// Roots for a session bound to `project_dir` (None → config + user
    /// scopes only; the webview passes the project dir explicitly per
    /// call, and unbound sessions have no workspace to expose).
    pub fn for_project(project_dir: Option<&Path>) -> Allowlist {
        Self::for_project_with(project_dir, &guild_config_dir(), &home_dir())
    }

    /// Injectable roots (tests isolate the config/home dirs — the env-based
    /// defaults race with parallel tests that set XDG_CONFIG_HOME).
    pub fn for_project_with(project_dir: Option<&Path>, config: &Path, home: &Path) -> Allowlist {
        // Roots and request paths must be in the same form: requests are
        // canonicalized (symlinks resolved, `\\?\` verbatim form on
        // Windows), so a raw root never matches once any component is a
        // symlink — every access would be denied.
        let root = |path: &Path| canonical_root(path);
        let config = root(config);
        let user_skills = root(&home.join(".agents"));
        let home = root(home);
        let mut read = vec![config.clone(), user_skills.clone()];
        let exists = vec![config.clone(), user_skills.clone(), home.clone()];
        let mut write = vec![config];
        let mut walk_ancestors = Vec::new();
        if let Some(project) = project_dir {
            let project = root(project);
            read.push(project.clone());
            write.push(project.clone());
            // Find the git root first (Codex semantics: the default project
            // root marker). Without one, ancestors stay out of the READ
            // roots — only the project itself is readable; the existence
            // walk above is what *finds* the root.
            let mut cursor = Some(project.clone());
            let mut root: Option<PathBuf> = None;
            while let Some(dir) = cursor {
                if dir.join(".git").exists() {
                    root = Some(dir);
                    break;
                }
                cursor = dir.parent().map(Path::to_path_buf);
            }
            if let Some(root) = root {
                let mut chain = Vec::new();
                let mut cursor = Some(project.clone());
                while let Some(dir) = cursor {
                    chain.push(dir.clone());
                    if dir == root {
                        break;
                    }
                    cursor = dir.parent().map(Path::to_path_buf);
                }
                read.extend(chain);
            }
            // The existence walk may probe every ancestor for `.git` only
            // (that is how the root is found) — never other paths above the
            // read roots.
            let mut cursor = project.parent().map(Path::to_path_buf);
            while let Some(dir) = cursor {
                walk_ancestors.push(canonical_root(&dir));
                cursor = dir.parent().map(Path::to_path_buf);
            }
        }
        Allowlist {
            read,
            exists,
            write,
            project: project_dir.map(canonical_root),
            walk_ancestors,
        }
    }

    /// Absolute form of a request path: relative paths anchor at the bound
    /// project (the webview works in project-relative terms).
    fn resolve(&self, raw_path: &str) -> anyhow::Result<PathBuf> {
        let raw = Path::new(raw_path);
        if raw.is_relative() {
            match &self.project {
                Some(project) => return normalize(&project.join(raw)),
                None => {
                    return normalize(&self.read.first().cloned().unwrap_or_default().join(raw))
                }
            }
        }
        normalize(raw)
    }

    fn allowed(&self, roots: &[PathBuf], path: &Path) -> bool {
        roots.iter().any(|root| path.starts_with(root))
    }

    pub fn can_read(&self, path: &Path) -> bool {
        self.allowed(&self.read, path)
    }

    pub fn can_probe(&self, path: &Path) -> bool {
        if self.allowed(&self.exists, path) || self.can_read(path) {
            return true;
        }
        // Above the read roots, existence is only exposed for `.git` probes
        // (the git-root discovery walk) — never for other paths.
        path.file_name().is_some_and(|n| n == ".git")
            && self.walk_ancestors.iter().any(|a| path.starts_with(a))
    }

    pub fn can_write(&self, path: &Path) -> bool {
        self.allowed(&self.write, path)
    }
}

/// The allowlist root form: canonicalized when the path exists (symlink
/// components resolved, verbatim form on Windows), raw otherwise — the same
/// resolution requests go through, so roots and requests always compare.
fn canonical_root(path: &Path) -> PathBuf {
    normalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Canonicalizes as far as the filesystem allows: the existing prefix is
/// resolved through symlinks component by component (so link-based escapes
/// land on their real target and fail the root check), the nonexistent
/// tail is kept lexically with `..` popped. Symlink targets that dangle
/// are resolved too — a write through a link must not escape the roots.
fn normalize(path: &Path) -> anyhow::Result<PathBuf> {
    let mut links = 0;
    let mut stack: Vec<std::ffi::OsString> = path
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    stack.reverse();
    let mut out = PathBuf::new();
    while let Some(comp) = stack.pop() {
        match comp.to_str() {
            Some("..") => {
                out.pop();
            }
            Some(".") => {}
            _ => {
                out.push(&comp);
                if let Ok(meta) = std::fs::symlink_metadata(&out) {
                    if meta.file_type().is_symlink() {
                        links += 1;
                        anyhow::ensure!(links <= 40, "too many symbolic links in path");
                        let target = std::fs::read_link(&out).unwrap_or_default();
                        out.pop(); // the link component is replaced by its target
                        let tcomps: Vec<_> = Path::new(&target)
                            .components()
                            .map(|c| c.as_os_str().to_owned())
                            .collect();
                        if Path::new(&target).is_absolute() {
                            out = PathBuf::new();
                        }
                        for c in tcomps.into_iter().rev() {
                            stack.push(c);
                        }
                    }
                }
            }
        }
    }
    Ok(out.canonicalize().unwrap_or(out))
}

/// fs.read_text: the file's text, gated by the read roots.
pub fn read_text(project_dir: Option<&Path>, raw_path: &str) -> anyhow::Result<String> {
    read_text_with(&Allowlist::for_project(project_dir), raw_path)
}

pub fn read_text_with(allow: &Allowlist, raw_path: &str) -> anyhow::Result<String> {
    let path = allow.resolve(raw_path)?;
    anyhow::ensure!(allow.can_read(&path), "path is outside the allowed roots");
    std::fs::read_to_string(&path).context("read failed")
}

/// Bounded context reads reject devices/pipes and preserve UTF-8 boundaries.
pub fn read_text_limited_with(
    allow: &Allowlist,
    raw_path: &str,
    limit: usize,
) -> anyhow::Result<String> {
    use std::io::Read;
    let path = allow.resolve(raw_path)?;
    anyhow::ensure!(allow.can_read(&path), "path is outside the allowed roots");
    anyhow::ensure!(
        std::fs::metadata(&path)?.is_file(),
        "context path is not a regular file"
    );
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(limit as u64)
        .read_to_end(&mut bytes)?;
    match std::str::from_utf8(&bytes) {
        Ok(text) => Ok(text.to_string()),
        Err(error) if error.error_len().is_none() => {
            Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])?.to_string())
        }
        Err(error) => Err(error.into()),
    }
}

/// One directory entry for fs.list_dir (sorted by name — scan order).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    /// dir | file | other
    pub kind: String,
}

/// fs.list_dir: sorted entries, gated by the read roots.
pub fn list_dir(project_dir: Option<&Path>, raw_path: &str) -> anyhow::Result<Vec<DirEntry>> {
    list_dir_with(&Allowlist::for_project(project_dir), raw_path)
}

pub fn list_dir_with(allow: &Allowlist, raw_path: &str) -> anyhow::Result<Vec<DirEntry>> {
    list_dir_limited_with(allow, raw_path, usize::MAX)
}

pub fn list_dir_limited_with(
    allow: &Allowlist,
    raw_path: &str,
    limit: usize,
) -> anyhow::Result<Vec<DirEntry>> {
    let path = allow.resolve(raw_path)?;
    anyhow::ensure!(allow.can_read(&path), "path is outside the allowed roots");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path)
        .context("list_dir failed")?
        .take(limit)
        .flatten()
    {
        let kind = if entry.path().is_dir() { "dir" } else { "file" };
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.into(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// fs.exists: existence probe, gated by the probe roots (the walk that
/// finds the git root may look above the read roots).
pub fn exists(project_dir: Option<&Path>, raw_path: &str) -> bool {
    exists_with(&Allowlist::for_project(project_dir), raw_path)
}

pub fn exists_with(allow: &Allowlist, raw_path: &str) -> bool {
    let Ok(path) = allow.resolve(raw_path) else {
        return false;
    };
    allow.can_probe(&path) && path.exists()
}

/// fs.write_text: creates parents, gated by the write roots.
pub fn write_text(project_dir: Option<&Path>, raw_path: &str, body: &str) -> anyhow::Result<()> {
    write_text_with(&Allowlist::for_project(project_dir), raw_path, body)
}

pub fn write_text_with(allow: &Allowlist, raw_path: &str, body: &str) -> anyhow::Result<()> {
    let path = allow.resolve(raw_path)?;
    anyhow::ensure!(allow.can_write(&path), "path is outside the allowed roots");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create parent dir failed")?;
    }
    std::fs::write(&path, body).context("write failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, rel: &str, body: &str) -> PathBuf {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    /// Isolated roots under one temp root (env-free — parallel tests may
    /// set XDG_CONFIG_HOME process-wide at any moment).
    fn isolated(tag: &str) -> (PathBuf, Allowlist) {
        let tmp = std::env::temp_dir().join(format!("guild-fs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cfg = tmp.join("config").join("guild");
        let home = tmp.join("home");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let allow = Allowlist::for_project_with(None, &cfg, &home);
        (tmp, allow)
    }

    #[cfg(unix)]
    #[test]
    fn cyclic_symlinks_fail_without_blocking_reads_writes_or_probes() {
        let (tmp, allow) = isolated("symlink-cycle");
        let path = tmp.join("config/guild/loop");
        std::os::unix::fs::symlink("loop", &path).unwrap();
        assert!(read_text_with(&allow, path.to_str().unwrap())
            .unwrap_err()
            .to_string()
            .contains("symbolic links"));
        assert!(write_text_with(&allow, path.to_str().unwrap(), "x").is_err());
        assert!(!exists_with(&allow, path.to_str().unwrap()));
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn reads_inside_the_project_and_roots_pass_outside_fail() {
        let (tmp, mut allow) = isolated("read");
        let project = tmp.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        allow = Allowlist::for_project_with(
            Some(&project),
            &tmp.join("config/guild"),
            &tmp.join("home"),
        );
        let inside = touch(&project, "README.md", "hello");
        let outside = touch(&tmp.join("elsewhere"), "secret.txt", "nope");
        let user_skill = touch(&tmp.join("home/.agents"), "skills/x/SKILL.md", "skill body");
        let cfg_file = touch(&tmp.join("config/guild"), "settings.json", "{}");

        assert_eq!(
            read_text_with(&allow, inside.to_str().unwrap()).unwrap(),
            "hello"
        );
        assert_eq!(
            read_text_with(&allow, user_skill.to_str().unwrap()).unwrap(),
            "skill body"
        );
        assert_eq!(
            read_text_with(&allow, cfg_file.to_str().unwrap()).unwrap(),
            "{}"
        );
        assert!(read_text_with(&allow, outside.to_str().unwrap()).is_err());
        // No project bound: the project file is unreachable.
        let unbound =
            Allowlist::for_project_with(None, &tmp.join("config/guild"), &tmp.join("home"));
        assert!(read_text_with(&unbound, inside.to_str().unwrap()).is_err());
        // The ancestor walk probes .git only — other paths above (even
        // system files) report nothing.
        assert!(!exists_with(&allow, "/etc/shadow"));
    }

    #[test]
    fn the_git_root_chain_is_readable_but_nothing_above_it() {
        let (tmp, _) = isolated("git");
        let repo = tmp.join("repo");
        let sub = repo.join("deep").join("workdir");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let allow =
            Allowlist::for_project_with(Some(&sub), &tmp.join("config/guild"), &tmp.join("home"));
        let root_doc = touch(&repo, "AGENTS.md", "root instructions");
        let mid_doc = touch(&repo, "deep/AGENTS.md", "mid instructions");
        let above = touch(&tmp, "AGENTS.md", "above the repo");

        assert_eq!(
            read_text_with(&allow, root_doc.to_str().unwrap()).unwrap(),
            "root instructions"
        );
        assert_eq!(
            read_text_with(&allow, mid_doc.to_str().unwrap()).unwrap(),
            "mid instructions"
        );
        assert!(read_text_with(&allow, above.to_str().unwrap()).is_err());
        // …but the walk that FINDS the git root may probe `.git` above the
        // read roots — other paths above stay invisible.
        std::fs::create_dir_all(tmp.join(".git")).unwrap();
        touch(&tmp, "probe-marker", "");
        assert!(exists_with(&allow, repo.join(".git").to_str().unwrap()));
        assert!(exists_with(&allow, tmp.join(".git").to_str().unwrap()));
        assert!(!exists_with(
            &allow,
            tmp.join("probe-marker").to_str().unwrap()
        ));
    }

    #[test]
    fn traversal_and_writes_are_bounded() {
        let (tmp, _) = isolated("write");
        let project = tmp.join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let allow = Allowlist::for_project_with(
            Some(&project),
            &tmp.join("config/guild"),
            &tmp.join("home"),
        );
        let elsewhere = tmp.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();

        // `..` escape via lexical path → normalized out of the roots.
        let escape = format!("{}/../elsewhere/evil.txt", project.display());
        assert!(write_text_with(&allow, &escape, "no").is_err());
        assert!(read_text_with(&allow, &escape).is_err());

        // Writes inside the project and the config dir pass.
        write_text_with(&allow, "notes/x.txt", "written").unwrap();
        assert_eq!(
            std::fs::read_to_string(project.join("notes/x.txt")).unwrap(),
            "written"
        );
        let cfg = tmp.join("config/guild/settings.json");
        write_text_with(&allow, cfg.to_str().unwrap(), "{}").unwrap();

        // list_dir is sorted and kinds are right.
        touch(&project, "b.txt", "b");
        touch(&project, "a_dir/.keep", "");
        let entries = list_dir_with(&allow, project.to_str().unwrap()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "b.txt", "notes"]);
        assert_eq!(entries[0].kind, "dir");
        assert_eq!(entries[1].kind, "file");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_and_config_roots_still_match_canonical_requests() {
        let (tmp, _) = isolated("root-sym");
        let real_project = tmp.join("real-proj");
        std::fs::create_dir_all(&real_project).unwrap();
        let real_cfg = tmp.join("config").join("guild");
        std::fs::create_dir_all(&real_cfg).unwrap();
        std::os::unix::fs::symlink(&real_project, tmp.join("linked-proj")).unwrap();
        std::os::unix::fs::symlink(&real_cfg, tmp.join("linked-cfg")).unwrap();
        // Roots are bound via symlinked paths; requests resolve to the real
        // targets (or vice versa) — both forms must be allowed.
        let allow = Allowlist::for_project_with(
            Some(&tmp.join("linked-proj")),
            &real_cfg,
            &tmp.join("home"),
        );
        let doc = touch(&real_project, "AGENTS.md", "hello");
        assert_eq!(
            read_text_with(&allow, doc.to_str().unwrap()).unwrap(),
            "hello"
        );
        assert_eq!(read_text_with(&allow, "AGENTS.md").unwrap(), "hello");
        write_text_with(&allow, "notes/x.txt", "written").unwrap();
        assert_eq!(
            std::fs::read_to_string(real_project.join("notes/x.txt")).unwrap(),
            "written"
        );
        let cfg_allow = Allowlist::for_project_with(
            Some(&real_project),
            &tmp.join("linked-cfg"),
            &tmp.join("home"),
        );
        let cfg_file = touch(&real_cfg, "settings.json", "{}");
        assert_eq!(
            read_text_with(&cfg_allow, cfg_file.to_str().unwrap()).unwrap(),
            "{}"
        );
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn normalize_resolves_through_symlinks() {
        let (tmp, _) = isolated("sym");
        let project = tmp.join("proj");
        let real = tmp.join("real");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        let allow = Allowlist::for_project_with(
            Some(&project),
            &tmp.join("config/guild"),
            &tmp.join("home"),
        );
        touch(&real, "secret.txt", "nope");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, project.join("link")).unwrap();
            let via_link = format!("{}/link/secret.txt", project.display());
            assert!(read_text_with(&allow, &via_link).is_err());
            // A dangling link whose target is outside the roots must not
            // become a write path either.
            std::os::unix::fs::symlink(&tmp.join("no-such-dir"), project.join("dangling")).unwrap();
            assert!(write_text_with(
                &allow,
                &format!("{}/dangling/x.txt", project.display()),
                "no"
            )
            .is_err());
        }
    }
}
