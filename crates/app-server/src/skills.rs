//! Local skills: SKILL.md files discovered from shared harness directories
//! (`.agents/skills`, codex/pi compatible) plus Guild's legacy dirs, and
//! rendered into the system-prompt index (skills design, 2026-09-16).
//! Registry install/uninstall + provenance live in `registry_client`.

use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    /// Directory holding SKILL.md (the agent reads it with read_file).
    pub path: PathBuf,
}

fn parse_frontmatter(body: &str, fallback_name: &str) -> (String, String) {
    guild_core::registry::parse_frontmatter(body, fallback_name)
}

/// Scans `<dir>/skills/*/SKILL.md` and `<dir>/skills/<file>.md`.
fn scan_dir(root: &Path) -> Vec<SkillEntry> {
    let skills_dir = root.join("skills");
    let Ok(entries) = std::fs::read_dir(&skills_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut dirs: Vec<_> = entries.flatten().collect();
    dirs.sort_by_key(|e| e.file_name());
    for entry in dirs {
        let path = entry.path();
        let skill_md = if path.is_dir() {
            path.join("SKILL.md")
        } else {
            path
        };
        if !skill_md.is_file() {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&skill_md) else {
            continue;
        };
        let fallback = skill_md
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "skill".into());
        let (name, description) = parse_frontmatter(&body, &fallback);
        out.push(SkillEntry {
            name,
            description,
            path: skill_md,
        });
    }
    out
}

/// Repo-level `.agents/skills` dirs from `start` up to and including the
/// git root (Codex's repo scope). Without a `.git` anywhere, only `start`
/// itself is considered.
fn repo_roots(start: &Path) -> Vec<PathBuf> {
    let mut levels: Vec<PathBuf> = Vec::new();
    let mut at_git = false;
    let mut cur = Some(start.to_path_buf());
    while let Some(dir) = cur {
        levels.push(dir.clone());
        if dir.join(".git").exists() {
            at_git = true;
            break;
        }
        cur = dir.parent().map(Path::to_path_buf);
    }
    if !at_git {
        levels.truncate(1);
    }
    levels
        .into_iter()
        .rev() // outermost first; nearer dirs win the name merge below
        .map(|dir| dir.join(".agents"))
        .collect()
}

/// Skills visible to a session, lowest precedence first (later entries win
/// a name collision): legacy config dir, the user's shared `~/.agents/skills`
/// (same dir codex and pi read), repo `.agents/skills` from the git root
/// down to the project, the project's own `.agents/skills`, and finally the
/// legacy `.guild/skills` install target.
pub fn discover_with_home(project_dir: &Path, config_dir: &Path, home: &Path) -> Vec<SkillEntry> {
    let mut out = scan_dir(config_dir);
    // user scope: ~/.agents/skills
    for e in scan_dir(&home.join(".agents")) {
        merge(&mut out, e);
    }
    // repo scope: cwd → git root
    for root in repo_roots(project_dir) {
        for e in scan_dir(&root) {
            merge(&mut out, e);
        }
    }
    // legacy Guild scopes
    for project_skill in scan_dir(&project_dir.join(".guild")) {
        merge(&mut out, project_skill);
    }
    out
}

fn merge(out: &mut Vec<SkillEntry>, e: SkillEntry) {
    if let Some(existing) = out.iter_mut().find(|x| x.name == e.name) {
        *existing = e;
    } else {
        out.push(e);
    }
}

/// Same with the platform home dir.
pub fn discover(project_dir: &Path, config_dir: &Path) -> Vec<SkillEntry> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    discover_with_home(project_dir, config_dir, &home)
}

/// Paths disabled in `{config_dir}/settings.json` under
/// `"skillsDisabled": { "<SKILL.md path>": false }`.
pub fn disabled_paths(config_dir: &Path) -> HashSet<PathBuf> {
    let Ok(body) = std::fs::read_to_string(config_dir.join("settings.json")) else {
        return HashSet::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) else {
        return HashSet::new();
    };
    v["skillsDisabled"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(_, on)| !on.as_bool().unwrap_or(true))
                .filter_map(|(p, _)| {
                    // Paths may be written with `~`; expand against home.
                    if let Some(rest) = p.strip_prefix("~/") {
                        dirs::home_dir().map(|h| h.join(rest))
                    } else {
                        Some(PathBuf::from(p))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Char budget for the rendered index (Codex's fallback budget).
const INDEX_BUDGET: usize = 8_000;

/// The skills index injected into the agent's system prompt. Over budget,
/// descriptions are shortened first, then entries are dropped from the end
/// with an omission notice.
pub fn prompt_index(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let header = "\n# Available skills\n\
        When a task matches a skill, read its SKILL.md with read_file and follow it.\n";
    for clip in [usize::MAX, 120, 60, 24] {
        let render = |clip: usize| -> String {
            let mut s = String::from(header);
            for e in skills {
                let desc = if clip == usize::MAX {
                    e.description.clone()
                } else {
                    let cut: String = e.description.chars().take(clip).collect();
                    if cut.chars().count() < e.description.chars().count() {
                        format!("{cut}…")
                    } else {
                        cut
                    }
                };
                s.push_str(&format!("- {}: {} ({})\n", e.name, desc, e.path.display()));
            }
            s
        };
        let s = render(clip);
        if s.len() <= INDEX_BUDGET {
            return s;
        }
    }
    // Still over budget: drop entries from the end until it fits.
    let mut kept: Vec<&SkillEntry> = skills.iter().collect();
    while !kept.is_empty() {
        kept.pop();
        let mut s = String::from(header);
        for e in &kept {
            s.push_str(&format!(
                "- {}: {} ({})\n",
                e.name,
                e.description.chars().take(24).collect::<String>(),
                e.path.display()
            ));
        }
        let omitted = skills.len() - kept.len();
        s.push_str(&format!("({omitted} skills omitted — index over budget)\n"));
        if s.len() <= INDEX_BUDGET {
            return s;
        }
    }
    header.to_string()
}

// ---------- provenance sidecar (agents/guild.yaml) ----------

/// Provenance for one installed/published skill dir. Guild metadata never
/// enters SKILL.md; this rides beside it where other harnesses ignore it.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SkillProvenance {
    /// registry | local
    pub source: String,
    pub slug: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub published_by_me: bool,
    #[serde(default)]
    pub review_status: String,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub bundle_hash: String,
}

/// Sidecar path relative to the skill dir.
pub const SIDECAR_REL: &str = "agents/guild.yaml";

/// Writes the flat sidecar as `key: value` YAML (all fields are plain
/// scalars; no nesting, no quoting needed).
pub fn write_sidecar(dir: &Path, p: &SkillProvenance) -> anyhow::Result<()> {
    let path = dir.join(SIDECAR_REL);
    std::fs::create_dir_all(path.parent().context("no sidecar parent")?)?;
    let body = format!(
        "source: {}\nslug: {}\nversion: {}\npublisher: {}\npublished_by_me: {}\nreview_status: {}\ninstalled_at: {}\nbundle_hash: {}\n",
        p.source, p.slug, p.version, p.publisher, p.published_by_me, p.review_status, p.installed_at, p.bundle_hash,
    );
    std::fs::write(path, body)?;
    Ok(())
}

/// Reads the sidecar; `None` when absent or unparsable (a dir without a
/// sidecar is a plain skill folder — never Guild-managed).
pub fn read_sidecar(dir: &Path) -> Option<SkillProvenance> {
    let body = std::fs::read_to_string(dir.join(SIDECAR_REL)).ok()?;
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    for line in body.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        map.insert(k.trim().to_string(), v.trim().to_string());
    }
    let get = |k: &str| map.get(k).cloned().unwrap_or_default();
    Some(SkillProvenance {
        source: get("source"),
        slug: get("slug"),
        version: get("version"),
        publisher: get("publisher"),
        published_by_me: get("published_by_me") == "true",
        review_status: get("review_status"),
        installed_at: get("installed_at"),
        bundle_hash: get("bundle_hash"),
    })
}

// ---------- /name explicit invocation ----------

/// `/name` mentions in `prompt` that match a discovered skill, with the
/// full SKILL.md body loaded. The trigger must start a word (text start or
/// after whitespace), so URLs (`https://…`) and paths (`a/b`) don't fire it.
/// Unknown `/<token>`s pass through untouched.
pub fn mention_expansions(prompt: &str, skills: &[SkillEntry]) -> Vec<(SkillEntry, String)> {
    let bytes = prompt.as_bytes();
    let mut names: HashSet<&str> = HashSet::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'/'
            && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t' || bytes[i - 1] == b'\n')
        {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len()
                && (bytes[end].is_ascii_lowercase()
                    || bytes[end].is_ascii_digit()
                    || bytes[end] == b'-')
            {
                end += 1;
            }
            if end > start {
                names.insert(&prompt[start..end]);
            }
            i = end;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for e in skills {
        if names.contains(e.name.as_str()) {
            if let Ok(body) = std::fs::read_to_string(&e.path) {
                out.push((e.clone(), body));
            }
        }
    }
    out
}

/// Renders the context block appended to the user prompt for `/name`
/// mentions. The system channel stays server-owned, so the full skill body
/// rides in the turn message after a clear delimiter.
pub fn mention_block(mentions: &[(SkillEntry, String)]) -> Option<String> {
    if mentions.is_empty() {
        return None;
    }
    let mut s = String::from("\n\n---\nInvoked skills (follow their instructions):\n");
    for (e, body) in mentions {
        s.push_str(&format!("\n### Skill: {} ({})\n{}\n", e.name, e.path.display(), body));
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(base: &Path, rel: &str, name: &str, desc: &str) {
        let dir = base.join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {desc}\n---\nbody of {name}"),
        )
        .unwrap();
    }

    #[test]
    fn frontmatter_parse() {
        let body =
            "---\nname: deploy-check\ndescription: Verify a deploy is healthy\n---\n\nSteps here.";
        let (name, desc) = parse_frontmatter(body, "fallback");
        assert_eq!(name, "deploy-check");
        assert_eq!(desc, "Verify a deploy is healthy");
    }

    #[test]
    fn discover_merges_project_over_user() {
        let base = std::env::temp_dir().join(format!("guild-skills-{}", std::process::id()));
        let cfg = base.join("cfg");
        let proj = base.join("proj");
        let home = base.join("home");
        std::fs::create_dir_all(cfg.join("skills/shared")).unwrap();
        std::fs::create_dir_all(cfg.join("skills/user-only")).unwrap();
        std::fs::create_dir_all(proj.join(".guild/skills/shared")).unwrap();
        std::fs::create_dir_all(proj.join(".guild/skills/proj-only")).unwrap();
        std::fs::write(
            cfg.join("skills/shared/SKILL.md"),
            "---\nname: shared\ndescription: user version\n---",
        )
        .unwrap();
        std::fs::write(
            cfg.join("skills/user-only/SKILL.md"),
            "---\nname: user-only\ndescription: u\n---",
        )
        .unwrap();
        std::fs::write(
            proj.join(".guild/skills/shared/SKILL.md"),
            "---\nname: shared\ndescription: project version\n---",
        )
        .unwrap();
        std::fs::write(
            proj.join(".guild/skills/proj-only/SKILL.md"),
            "---\nname: proj-only\ndescription: p\n---",
        )
        .unwrap();

        let found = discover_with_home(&proj, &cfg, &home);
        let names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        // user-dir skills first (sorted), then project additions
        assert_eq!(names, vec!["shared", "user-only", "proj-only"]);
        let shared = found.iter().find(|e| e.name == "shared").unwrap();
        assert_eq!(shared.description, "project version");

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn discover_reads_repo_and_home_agents_scopes() {
        let base = std::env::temp_dir().join(format!("guild-skills-ag-{}", std::process::id()));
        let cfg = base.join("cfg");
        let home = base.join("home");
        let repo = base.join("repo");
        let sub = repo.join("sub/deeper");
        std::fs::create_dir_all(&repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        write_skill(&home.join(".agents"), "skills/h-skills", "home-skill", "in home");
        write_skill(&repo.join(".agents"), "skills/repo-skill", "repo-skill", "at root");
        write_skill(&sub.join(".agents"), "skills/repo-skill", "repo-skill", "in subdir");
        write_skill(&sub.join(".agents"), "skills/local", "local-skill", "nearby");

        let found = discover_with_home(&sub, &cfg, &home);
        let mut names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["home-skill", "local-skill", "repo-skill"]);
        // deeper repo level beats the root on name collision
        let rs = found.iter().find(|e| e.name == "repo-skill").unwrap();
        assert!(rs.description == "in subdir");
        // outside the repo the shared dir is not scanned
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        let found2 = discover_with_home(&outside, &cfg, &home);
        assert!(found2.iter().all(|e| e.name != "repo-skill"));

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn disabled_paths_from_settings() {
        let base = std::env::temp_dir().join(format!("guild-skills-dis-{}", std::process::id()));
        let cfg = base.join("cfg");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(
            cfg.join("settings.json"),
            r#"{"skillsDisabled": {"/tmp/x/SKILL.md": false, "/tmp/y/SKILL.md": true}}"#,
        )
        .unwrap();
        let dis = disabled_paths(&cfg);
        assert_eq!(dis.len(), 1);
        assert!(dis.contains(Path::new("/tmp/x/SKILL.md")));
        // absent settings → empty
        assert!(disabled_paths(Path::new("/nonexistent-guild-cfg")).is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn prompt_index_lists_entries() {
        let idx = prompt_index(&[SkillEntry {
            name: "review".into(),
            description: "review code".into(),
            path: PathBuf::from("/x/SKILL.md"),
        }]);
        assert!(idx.contains("review"));
        assert!(idx.contains("review code"));
        assert!(prompt_index(&[]).is_empty());
    }

    #[test]
    fn prompt_index_shortens_descriptions_then_drops_entries() {
        let skills: Vec<SkillEntry> = (0..300)
            .map(|i| SkillEntry {
                name: format!("skill-{i:03}"),
                description: "d".repeat(400) + &format!(" unique-tail-{i}"),
                path: PathBuf::from(format!("/s/{i}/SKILL.md")),
            })
            .collect();
        let idx = prompt_index(&skills);
        assert!(idx.len() <= INDEX_BUDGET, "index {} over budget", idx.len());
        assert!(idx.contains("omitted"), "drops entries with a notice");
    }

    #[test]
    fn sidecar_roundtrip() {
        let base = std::env::temp_dir().join(format!("guild-skills-sc-{}", std::process::id()));
        let dir = base.join("deploy-check");
        std::fs::create_dir_all(&dir).unwrap();
        let p = SkillProvenance {
            source: "registry".into(),
            slug: "deploy-check".into(),
            version: "1.2.0".into(),
            publisher: "a@b.c".into(),
            published_by_me: true,
            review_status: "approved".into(),
            installed_at: "2026-09-16T12:00:00Z".into(),
            bundle_hash: "sha256:abc".into(),
        };
        write_sidecar(&dir, &p).unwrap();
        let back = read_sidecar(&dir).unwrap();
        assert_eq!(back, p);
        assert_eq!(back.installed_at, "2026-09-16T12:00:00Z");
        assert!(read_sidecar(&base.join("no-such-dir")).is_none());
        std::fs::remove_dir_all(&base).unwrap();
    }


    #[test]
    fn mention_expansions_match_exact_names_only() {
        let base = std::env::temp_dir().join(format!("guild-skills-mn-{}", std::process::id()));
        write_skill(&base, "skills/deploy-check", "deploy-check", "deploy");
        write_skill(&base, "skills/review", "review", "review");
        let skills = scan_dir(&base);
        let prompt = "use /deploy-check then /100 and /deploy-checkx and a/b stay literal";
        let m = mention_expansions(prompt, &skills);
        assert_eq!(m.len(), 1, "exact /name matches only");
        assert_eq!(m[0].0.name, "deploy-check");
        assert!(m[0].1.contains("body of deploy-check"));
        assert!(mention_block(&m).unwrap().contains("### Skill: deploy-check"));
        assert!(mention_block(&[]).is_none());
        // trigger must start a word: URLs and file paths don't fire it
        assert!(mention_expansions("see https://x/review page", &skills).is_empty());
        assert!(mention_expansions("mid-word/deploy-check stays literal", &skills).is_empty());
        assert_eq!(mention_expansions("/review", &skills).len(), 1);
        assert_eq!(mention_expansions("do it:\n/review", &skills).len(), 1);
        std::fs::remove_dir_all(&base).unwrap();
    }
}


