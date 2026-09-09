//! Local skills: SKILL.md files discovered in project + user dirs (spec §3.2).
//! Registry install lands in milestone 3; the on-disk format is identical.

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

/// Skills visible to a session: user config dir first, then the project's
/// `.guild` dir (project entries win on name collision).
pub fn discover(project_dir: &Path, config_dir: &Path) -> Vec<SkillEntry> {
    let mut out = scan_dir(config_dir);
    for project_skill in scan_dir(&project_dir.join(".guild")) {
        if let Some(existing) = out.iter_mut().find(|e| e.name == project_skill.name) {
            *existing = project_skill;
        } else {
            out.push(project_skill);
        }
    }
    out
}

/// The skills index injected into the agent's system prompt.
pub fn prompt_index(skills: &[SkillEntry]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n\n# Available skills\n\
        When a task matches a skill, read its SKILL.md with read_file and follow it.\n",
    );
    for e in skills {
        s.push_str(&format!(
            "- {}: {} ({})\n",
            e.name,
            e.description,
            e.path.display()
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let found = discover(&proj, &cfg);
        let names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        // user-dir skills first (sorted), then project additions
        assert_eq!(names, vec!["shared", "user-only", "proj-only"]);
        let shared = found.iter().find(|e| e.name == "shared").unwrap();
        assert_eq!(shared.description, "project version");

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
}
