//! Bounded instruction/skill discovery on the project's executor. Only known
//! context filenames are read through the same allowlist as the local bridge.
use crate::fs_bridge::{self, Allowlist};
use protocol::ws::MachineContext;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const DOC_BUDGET: usize = 32 * 1024;
const INDEX_BUDGET: usize = 8000;
const MENTION_BUDGET: usize = 64 * 1024;
const SCAN_BUDGET: usize = 2 * 1024 * 1024;
const MAX_SKILLS: usize = 512;
const SEPARATOR: &str = "\n\n--- project-doc ---\n\n";

fn clip(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}
fn append(out: &mut String, text: &str, cap: usize) {
    out.push_str(clip(text, cap.saturating_sub(out.len())));
}

struct Reader {
    allow: Allowlist,
    remaining: usize,
}
impl Reader {
    fn read(&mut self, path: &Path) -> Option<String> {
        if self.remaining == 0 {
            return None;
        }
        let body = fs_bridge::read_text_limited_with(
            &self.allow,
            &path.to_string_lossy(),
            self.remaining.min(MENTION_BUDGET),
        )
        .ok()?;
        self.remaining = self.remaining.saturating_sub(body.len().max(1));
        Some(body)
    }
}
#[derive(Clone)]
struct Skill {
    name: String,
    description: String,
    path: PathBuf,
}

pub fn prepare(project: &Path, prompt: &str) -> Result<MachineContext, String> {
    prepare_with(
        project,
        prompt,
        &fs_bridge::guild_config_dir(),
        &fs_bridge::home_dir(),
    )
}

pub(crate) fn prepare_with(
    project: &Path,
    prompt: &str,
    config: &Path,
    home: &Path,
) -> Result<MachineContext, String> {
    assemble_with(project, prompt, config, home).map(|(context, _)| context)
}

pub fn skill_read_roots(project: &Path) -> Vec<PathBuf> {
    assemble_with(
        project,
        "",
        &fs_bridge::guild_config_dir(),
        &fs_bridge::home_dir(),
    )
    .map(|(_, roots)| roots)
    .unwrap_or_default()
}

fn assemble_with(
    project: &Path,
    prompt: &str,
    config: &Path,
    home: &Path,
) -> Result<(MachineContext, Vec<PathBuf>), String> {
    if !project.is_absolute() || !project.is_dir() {
        return Err("context requires an absolute project directory".into());
    }
    let project = project.canonicalize().map_err(|e| e.to_string())?;
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
    let mut instructions = String::new();
    for name in ["AGENTS.override.md", "AGENTS.md"] {
        if let Some(body) = reader
            .read(&config.join(name))
            .filter(|s| !s.trim().is_empty())
        {
            append(&mut instructions, &body, DOC_BUDGET);
            break;
        }
    }
    for dir in &chain {
        if instructions.len() >= DOC_BUDGET {
            break;
        }
        for name in ["AGENTS.override.md", "AGENTS.md"] {
            if let Some(body) = reader.read(&dir.join(name)) {
                if !body.trim().is_empty() {
                    if !instructions.is_empty() {
                        append(&mut instructions, SEPARATOR, DOC_BUDGET);
                    }
                    append(&mut instructions, &body, DOC_BUDGET);
                }
                break;
            }
        }
    }
    let disabled = reader
        .read(&config.join("settings.json"))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("skillsDisabled").cloned())
        .unwrap_or_default();
    let mut roots = vec![
        project.join(".guild"),
        config.to_path_buf(),
        home.join(".agents"),
    ];
    roots.extend(chain.iter().map(|p| p.join(".agents")));
    let mut skills = BTreeMap::<String, Skill>::new();
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
            examined += 1;
            let path = if entry.kind == "dir" {
                dir.join(&entry.name).join("SKILL.md")
            } else if entry.name.ends_with(".md") {
                dir.join(&entry.name)
            } else {
                continue;
            };
            let Some(body) = reader.read(&path) else {
                continue;
            };
            let fallback = entry.name.trim_end_matches(".md");
            let (name, description) = guild_core::registry::parse_frontmatter(&body, fallback);
            skills.entry(name.clone()).or_insert(Skill {
                name,
                description,
                path,
            });
        }
    }
    let enabled: Vec<_> = skills
        .into_values()
        .filter(|s| {
            !disabled.as_object().is_some_and(|map| {
                map.iter().any(|(path, value)| {
                    let expanded = path
                        .strip_prefix("~/")
                        .map(|p| home.join(p))
                        .unwrap_or_else(|| PathBuf::from(path));
                    value == &serde_json::Value::Bool(false) && expanded == s.path
                })
            })
        })
        .collect();
    let mut index = String::new();
    if !enabled.is_empty() {
        index.push_str("\n# Available skills\nWhen a task matches a skill, read its SKILL.md with read_file and follow it.\n");
        for (i, skill) in enabled.iter().enumerate() {
            let line = format!(
                "- {}: {} ({})\n",
                skill.name,
                clip(&skill.description, 120),
                skill.path.display()
            );
            if index.len() + line.len() + 64 > INDEX_BUDGET {
                append(
                    &mut index,
                    &format!(
                        "({} skills omitted — index over budget)\n",
                        enabled.len() - i
                    ),
                    INDEX_BUDGET,
                );
                break;
            }
            index.push_str(&line);
        }
    }
    let mentions: Vec<String> = prompt
        .split_whitespace()
        .filter_map(|word| word.strip_prefix('/'))
        .map(|word| {
            word.chars()
                .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-')
                .collect()
        })
        .collect();
    let mut expansions = String::new();
    for skill in &enabled {
        if !mentions.contains(&skill.name) || expansions.len() >= MENTION_BUDGET {
            continue;
        }
        let Some(body) = reader.read(&skill.path) else {
            continue;
        };
        if expansions.is_empty() {
            expansions.push_str("\nInvoked skills (follow their instructions):\n");
        }
        append(
            &mut expansions,
            &format!("\n### Skill: {} ({})\n", skill.name, skill.path.display()),
            MENTION_BUDGET,
        );
        append(&mut expansions, &body, MENTION_BUDGET);
        append(&mut expansions, "\n", MENTION_BUDGET);
    }
    let roots = enabled
        .iter()
        .filter_map(|skill| skill.path.parent().map(Path::to_path_buf))
        .collect();
    Ok((
        MachineContext {
            instructions: (!instructions.is_empty()).then_some(instructions),
            skills_index: index,
            skill_expansions: expansions,
        },
        roots,
    ))
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
    fn executor_context_obeys_hierarchy_disabled_paths_and_explicit_mentions() {
        let temp =
            std::env::temp_dir().join(format!("guild-remote-context-{}", uuid::Uuid::now_v7()));
        let config = temp.join("config");
        let home = temp.join("home");
        let repo = temp.join("repo");
        put(&config, "AGENTS.md", "GLOBAL-PLAIN");
        put(&config, "AGENTS.override.md", "GLOBAL-OVERRIDE");
        put(&repo, ".git", "gitdir: elsewhere");
        put(&repo, "AGENTS.md", "ROOT");
        put(&repo, "child/AGENTS.override.md", "CHILD");
        put(&repo, "child/AGENTS.md", "WRONG-CHILD");
        put(&repo, "child/leaf/AGENTS.override.md", "");
        put(&repo, "child/leaf/AGENTS.md", "SUPPRESSED");
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
        put(&config, "settings.json", &serde_json::json!({"skillsDisabled": {repo.join("child/.agents/skills/off/SKILL.md").to_string_lossy().to_string():false}}).to_string());
        let ctx = prepare_with(&repo.join("child/leaf"), "/demo, /off", &config, &home).unwrap();
        assert_eq!(
            ctx.instructions.unwrap(),
            format!("GLOBAL-OVERRIDE{SEPARATOR}ROOT{SEPARATOR}CHILD")
        );
        assert!(ctx.skills_index.contains("demo: child"));
        assert!(!ctx.skills_index.contains("off:"));
        assert!(ctx.skill_expansions.contains("child-body"));
        assert!(!ctx.skill_expansions.contains("NEVER"));
        assert!(!ctx.skill_expansions.contains("repo-body"));
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn budgets_are_utf8_safe_and_without_git_ancestors_are_not_read() {
        let temp =
            std::env::temp_dir().join(format!("guild-remote-bounds-{}", uuid::Uuid::now_v7()));
        let config = temp.join("config");
        let home = temp.join("home");
        let cwd = temp.join("parent/child");
        put(&temp, "parent/AGENTS.md", "ANCESTOR-SECRET");
        put(&cwd, "AGENTS.md", &"界".repeat(DOC_BUDGET));
        put(
            &cwd,
            ".agents/skills/demo/SKILL.md",
            &format!("---\nname: demo\n---\n{}", "界".repeat(MENTION_BUDGET)),
        );
        let ctx = prepare_with(&cwd, "/demo", &config, &home).unwrap();
        assert!(ctx.instructions.as_ref().unwrap().len() <= DOC_BUDGET);
        assert!(!ctx.instructions.unwrap().contains("ANCESTOR-SECRET"));
        assert!(ctx.skill_expansions.len() <= MENTION_BUDGET);
        assert!(ctx.skill_expansions.contains("Skill: demo"));
        assert!(ctx.skills_index.len() <= INDEX_BUDGET);
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_context_cannot_escape_read_roots() {
        let temp =
            std::env::temp_dir().join(format!("guild-remote-links-{}", uuid::Uuid::now_v7()));
        let cwd = temp.join("project");
        put(&temp, "secret", "DO-NOT-READ");
        std::fs::create_dir_all(&cwd).unwrap();
        std::os::unix::fs::symlink(temp.join("secret"), cwd.join("AGENTS.md")).unwrap();
        let ctx = prepare_with(&cwd, "", &temp.join("config"), &temp.join("home")).unwrap();
        assert!(ctx.instructions.is_none());
        std::fs::remove_dir_all(temp).unwrap();
    }
}
