//! Bounded skill discovery on the project's executor: the extra read roots
//! a dispatched `read_file` may reach (the skill dirs the server's skills
//! index advertises). Only known context filenames are read, through the
//! same allowlist as the local bridge.
use crate::fs_bridge::{self, Allowlist};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const FILE_BUDGET: usize = 64 * 1024;
const SCAN_BUDGET: usize = 2 * 1024 * 1024;
const MAX_SKILLS: usize = 512;

struct Reader {
    allow: Allowlist,
    remaining: usize,
}
impl Reader {
    /// Reads through the allowlist with a containment rule: the resolved
    /// file must stay inside the tree its lexical path started in. A
    /// repo-committed `SKILL.md -> ~/.config/guild/token.json` symlink
    /// resolves into the config root and is rejected here.
    fn read(&mut self, root: &Path, path: &Path) -> Option<String> {
        if self.remaining == 0 {
            return None;
        }
        let root = fs_bridge::canonical_root(root);
        let resolved = fs_bridge::resolve_allowed(&self.allow, &path.to_string_lossy()).ok()?;
        if !resolved.starts_with(&root) {
            return None;
        }
        let body =
            fs_bridge::read_resolved_limited(&resolved, self.remaining.min(FILE_BUDGET)).ok()?;
        self.remaining = self.remaining.saturating_sub(body.len().max(1));
        Some(body)
    }
}

/// The dirs of the project's enabled skills.
pub fn skill_read_roots(project: &Path) -> Vec<PathBuf> {
    skill_read_roots_with(
        project,
        &fs_bridge::guild_config_dir(),
        &fs_bridge::home_dir(),
    )
}

/// [`skill_read_roots`] over explicit config and home dirs (the test seam).
/// Skill roots, nearest first: the `.agents` dirs of the project and its
/// ancestors up to the git root, `~/.agents`, the config dir, the
/// project's `.guild`; a skill name found in a nearer root shadows the
/// farther ones,
/// and `settings.json` `skillsDisabled` entries drop a skill.
pub(crate) fn skill_read_roots_with(project: &Path, config: &Path, home: &Path) -> Vec<PathBuf> {
    if !project.is_absolute() || !project.is_dir() {
        return Vec::new();
    }
    let Ok(project) = project.canonicalize() else {
        return Vec::new();
    };
    let mut reader = Reader {
        allow: Allowlist::for_project_with(Some(&project), config, home),
        remaining: SCAN_BUDGET,
    };
    let mut chain: Vec<PathBuf> = project
        .ancestors()
        .take(128)
        .map(Path::to_path_buf)
        .collect();
    if let Some(root) = chain.iter().position(|p| p.join(".git").exists()) {
        chain.truncate(root + 1);
    } else {
        chain.truncate(1);
    }
    chain.reverse();
    let disabled = reader
        .read(config, &config.join("settings.json"))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("skillsDisabled").cloned())
        .unwrap_or_default();
    let mut roots = vec![
        project.join(".guild"),
        config.to_path_buf(),
        home.join(".agents"),
    ];
    roots.extend(chain.iter().map(|p| p.join(".agents")));
    let mut skills = BTreeMap::<String, PathBuf>::new();
    let mut examined = 0;
    for root in roots.into_iter().rev() {
        let dir = root.join("skills");
        let entries =
            fs_bridge::list_dir_limited_with(&reader.allow, &dir.to_string_lossy(), MAX_SKILLS)
                .unwrap_or_default();
        for entry in entries {
            if examined >= MAX_SKILLS {
                break;
            }
            // Dot-entries are never skills (install staging / backup dirs).
            if entry.name.starts_with('.') {
                continue;
            }
            examined += 1;
            let path = if entry.kind == "dir" {
                dir.join(&entry.name).join("SKILL.md")
            } else if entry.name.ends_with(".md") {
                dir.join(&entry.name)
            } else {
                continue;
            };
            let Some(body) = reader.read(&root, &path) else {
                continue;
            };
            let fallback = entry.name.trim_end_matches(".md");
            let (name, _) = guild_core::registry::parse_frontmatter(&body, fallback);
            skills.entry(name).or_insert(path);
        }
    }
    skills
        .into_values()
        .filter(|path| {
            !disabled.as_object().is_some_and(|map| {
                map.iter().any(|(entry, value)| {
                    let expanded = entry
                        .strip_prefix("~/")
                        .map(|p| home.join(p))
                        .unwrap_or_else(|| PathBuf::from(entry));
                    // Both sides canonicalize (the webview reports raw
                    // configured paths; skill paths are resolved reads):
                    // lexical comparison misses on Windows (\?\ prefix) and
                    // symlinked projects.
                    value == &serde_json::Value::Bool(false)
                        && fs_bridge::canonical_root(&expanded) == fs_bridge::canonical_root(path)
                })
            })
        })
        .filter_map(|path| path.parent().map(Path::to_path_buf))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn put(root: &Path, path: &str, body: &str) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, body).unwrap();
    }

    #[test]
    fn nearest_root_wins_and_disabled_and_dot_dirs_are_dropped() {
        let temp =
            std::env::temp_dir().join(format!("guild-remote-roots-{}", uuid::Uuid::now_v7()));
        let config = temp.join("config");
        let home = temp.join("home");
        let repo = temp.join("repo");
        put(&repo, ".git", "gitdir: elsewhere");
        for (root, value) in [
            (&config, "config"),
            (&home.join(".agents"), "user"),
            (&repo.join(".agents"), "repo"),
            (&repo.join("child/.agents"), "child"),
        ] {
            put(
                root,
                "skills/demo/SKILL.md",
                &format!("---\nname: demo\ndescription: {value}\n---\n{value}-body"),
            );
        }
        put(
            &repo,
            "child/.agents/skills/off/SKILL.md",
            "---\nname: off\n---\nNEVER",
        );
        put(
            &repo,
            "child/.agents/skills/.staged-1/SKILL.md",
            "---\nname: staged\n---\nSTAGED",
        );
        put(&config, "settings.json", &serde_json::json!({"skillsDisabled": {repo.join("child/.agents/skills/off/SKILL.md").to_string_lossy().to_string():false}}).to_string());
        std::fs::create_dir_all(repo.join("child/leaf")).unwrap();
        let roots = skill_read_roots_with(&repo.join("child/leaf"), &config, &home);
        let child = repo
            .join("child/.agents/skills/demo")
            .canonicalize()
            .unwrap();
        assert_eq!(roots, vec![child]);
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn a_relative_or_missing_project_has_no_roots() {
        let temp = std::env::temp_dir();
        assert!(skill_read_roots_with(Path::new("rel"), &temp, &temp).is_empty());
        assert!(skill_read_roots_with(&temp.join("guild-missing-x9"), &temp, &temp).is_empty());
    }

    /// A repo-committed symlink that points INTO another read root (the
    /// config dir, where the bearer token lives) is not a skill: the read
    /// must land in the tree its lexical path started in.
    #[cfg(unix)]
    #[test]
    fn symlinked_skill_cannot_reach_into_the_config_root() {
        let temp =
            std::env::temp_dir().join(format!("guild-remote-token-{}", uuid::Uuid::now_v7()));
        let config = temp.join("config");
        let home = temp.join("home");
        let repo = temp.join("repo");
        put(&config, "token.json", "{\"token\":\"SECRET-BEARER\"}");
        put(
            &config,
            "skills/legit/SKILL.md",
            "---\nname: legit\n---\nbody",
        );
        put(&repo, ".git", "gitdir: elsewhere");
        std::fs::create_dir_all(repo.join(".agents/skills")).unwrap();
        std::os::unix::fs::symlink(
            config.join("skills/legit/SKILL.md"),
            repo.join(".agents/skills/stolen.md"),
        )
        .unwrap();
        let roots = skill_read_roots_with(&repo, &config, &home);
        let legit = config.join("skills/legit").canonicalize().unwrap();
        assert_eq!(roots, vec![legit]);
        std::fs::remove_dir_all(temp).unwrap();
    }

    /// A skill disabled via a path that only lexically differs from the
    /// resolved skill path (symlinked project root; on Windows always the
    /// \\?\ verbatim prefix) must still be filtered — the comparison
    /// canonicalizes both sides.
    #[cfg(unix)]
    #[test]
    fn disabled_entries_match_symlinked_project_paths() {
        let temp = std::env::temp_dir().join(format!("guild-remote-off-{}", uuid::Uuid::now_v7()));
        let config = temp.join("config");
        let home = temp.join("home");
        let repo = temp.join("repo");
        put(&repo, ".git", "gitdir: elsewhere");
        put(
            &repo,
            ".agents/skills/off/SKILL.md",
            "---\nname: off\n---\nNEVER",
        );
        std::os::unix::fs::symlink(&repo, temp.join("link")).unwrap();
        let through_link = temp
            .join("link")
            .join(".agents/skills/off/SKILL.md")
            .to_string_lossy()
            .to_string();
        put(
            &config,
            "settings.json",
            &serde_json::json!({ "skillsDisabled": { through_link: false } }).to_string(),
        );
        assert!(skill_read_roots_with(&repo, &config, &home).is_empty());
        std::fs::remove_dir_all(temp).unwrap();
    }
}
