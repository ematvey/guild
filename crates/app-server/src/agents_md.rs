//! AGENTS.md discovery and instruction assembly — Codex semantics
//! (codex-rs `core/src/agents_md.rs`, to the letter):
//!
//! 1. Global scope: `{config_dir}/AGENTS.override.md` when present, else
//!    `{config_dir}/AGENTS.md` — the first non-empty file wins (Codex reads
//!    `~/.codex/AGENTS.override.md` → `~/.codex/AGENTS.md`).
//! 2. Project scope: the project root is the nearest ancestor of the
//!    working directory containing `.git` (the default project root
//!    marker); with no marker found only the working directory itself is
//!    considered — traversal never goes past the project root. Every
//!    directory from the project root down to the working directory
//!    (inclusive) contributes at most one file: `AGENTS.override.md` when
//!    present, else `AGENTS.md`. Empty files are skipped.
//! 3. Contents concatenate root → working directory (deeper files sit
//!    later in the prompt, so closer guidance overrides higher guidance),
//!    under one shared byte budget (Codex's `project_doc_max_bytes`
//!    default, 32 KiB) — a file exceeding the remaining budget is
//!    truncated to fit.
//!
//! The assembled text rides the additive `agents_md` request field; the
//! server renders it with Codex's user-instructions markers into the
//! server-owned system prompt.

use std::path::{Path, PathBuf};

/// Default filename scanned for AGENTS.md instructions.
pub const AGENTS_MD_FILENAME: &str = "AGENTS.md";
/// Preferred local override for AGENTS.md instructions.
pub const AGENTS_OVERRIDE_FILENAME: &str = "AGENTS.override.md";
/// Codex's `project_doc_max_bytes` default.
pub const PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;
/// When both user (global) and project docs are present, they concatenate
/// with this separator (Codex's `AGENTS_MD_SEPARATOR`).
const PROJECT_DOC_SEPARATOR: &str = "\n\n--- project-doc ---\n\n";

/// One discovered instruction file: its path and (budget-truncated) text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocEntry {
    pub path: PathBuf,
    pub contents: String,
}

/// The global (config-dir) instructions: `AGENTS.override.md` when present,
/// else `AGENTS.md` — the first non-empty file wins. Unreadable or empty →
/// `None` (the global file is optional; Codex treats absence the same way).
pub fn load_global(config_dir: &Path) -> Option<DocEntry> {
    for name in [AGENTS_OVERRIDE_FILENAME, AGENTS_MD_FILENAME] {
        let path = config_dir.join(name);
        if !path.is_file() {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if !text.trim().is_empty() {
                return Some(DocEntry { path, contents: text });
            }
        }
    }
    None
}

/// The project root: the nearest ancestor of `start` (inclusive) holding a
/// `.git` entry — Codex's default project root marker. With no marker
/// anywhere up the tree, only `start` itself is in scope.
fn project_root(start: &Path) -> PathBuf {
    let mut cursor = Some(start.to_path_buf());
    while let Some(dir) = cursor {
        if dir.join(".git").exists() {
            return dir;
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
    start.to_path_buf()
}

/// The directories from the project root down to `cwd` (inclusive), in
/// that order — Codex's `search_dirs`.
fn search_dirs(cwd: &Path) -> Vec<PathBuf> {
    let root = project_root(cwd);
    let mut dirs = Vec::new();
    let mut cursor = Some(cwd.to_path_buf());
    while let Some(dir) = cursor {
        dirs.push(dir.clone());
        if dir == root {
            break;
        }
        cursor = dir.parent().map(Path::to_path_buf);
    }
    dirs.reverse();
    dirs
}

/// Discovers the project AGENTS.md chain: at most one file per directory
/// (`AGENTS.override.md` beats `AGENTS.md`), root → cwd, empty files
/// skipped, contents truncated against the shared `max_bytes` budget.
/// Unreadable files (another machine's volume, permissions) are skipped —
/// a missing doc never blocks a turn.
pub fn project_docs(cwd: &Path, max_bytes: usize) -> Vec<DocEntry> {
    let mut out = Vec::new();
    let mut remaining = max_bytes;
    for dir in search_dirs(cwd) {
        if remaining == 0 {
            break;
        }
        for name in [AGENTS_OVERRIDE_FILENAME, AGENTS_MD_FILENAME] {
            let path = dir.join(name);
            if !path.is_file() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if text.trim().is_empty() {
                    break; // the dir contributed an (empty) file — stop here
                }
                // Over budget: truncate to the remaining bytes (Codex's
                // `data.truncate(remaining)`), never past it.
                let truncated: String = if text.len() > remaining {
                    let mut cut = remaining;
                    while !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text[..cut].to_string()
                } else {
                    text
                };
                remaining = remaining.saturating_sub(truncated.len());
                out.push(DocEntry {
                    path,
                    contents: truncated,
                });
            }
            break; // one file per directory: the first existing candidate wins
        }
    }
    out
}

/// Global instructions + the project chain, concatenated the way Codex's
/// `LoadedAgentsMd::legacy_text()` does: global first, then the
/// `--- project-doc ---` separator at the transition to project docs, then
/// the project entries joined with blank lines. `None` when nothing was
/// found anywhere.
pub fn assemble(config_dir: &Path, cwd: &Path) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(global) = load_global(config_dir) {
        parts.push(global.contents);
    }
    let docs = project_docs(cwd, PROJECT_DOC_MAX_BYTES);
    if !docs.is_empty() {
        if !parts.is_empty() {
            parts.push(PROJECT_DOC_SEPARATOR.trim().to_string());
        }
        for d in docs {
            parts.push(d.contents);
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("guild-agentsmd-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn global_prefers_override_and_skips_empty() {
        let base = tmp("global");
        let cfg = base.join("cfg");
        // Empty AGENTS.override.md falls through to AGENTS.md.
        write(&cfg.join("AGENTS.override.md"), "   \n");
        write(&cfg.join("AGENTS.md"), "global rules");
        let g = load_global(&cfg).unwrap();
        assert!(g.contents.contains("global rules"));
        // A non-empty override wins.
        write(&cfg.join("AGENTS.override.md"), "override rules");
        assert!(load_global(&cfg).unwrap().contents.contains("override"));
        // Neither file → None.
        let empty_cfg = base.join("cfg2");
        std::fs::create_dir_all(&empty_cfg).unwrap();
        assert!(load_global(&empty_cfg).is_none());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn project_chain_walks_root_to_cwd_with_override_precedence() {
        let base = tmp("chain");
        let repo = base.join("repo");
        let sub = repo.join("sub/deeper");
        std::fs::create_dir_all(&repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        write(&repo.join("AGENTS.md"), "root rules");
        write(&repo.join("sub/AGENTS.override.md"), "sub override");
        write(&repo.join("sub/AGENTS.md"), "sub plain");
        write(&repo.join("sub/deeper/AGENTS.md"), "deep rules");

        let docs = project_docs(&sub, PROJECT_DOC_MAX_BYTES);
        let texts: Vec<&str> = docs.iter().map(|d| d.contents.as_str()).collect();
        // Root → cwd order; one file per dir with the override winning.
        assert_eq!(texts, vec!["root rules", "sub override", "deep rules"]);
        // Every doc sits between the project root and the cwd.
        assert!(docs.iter().all(|d| d.path.starts_with(&repo)));

        // Outside any git root: only the cwd itself is considered.
        let outside = base.join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();
        write(&base.join("AGENTS.md"), "above");
        assert!(project_docs(&outside, PROJECT_DOC_MAX_BYTES).is_empty());
        write(&outside.join("AGENTS.md"), "here");
        assert_eq!(project_docs(&outside, PROJECT_DOC_MAX_BYTES).len(), 1);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn empty_files_are_skipped_but_still_claim_their_dir() {
        let base = tmp("empty");
        let repo = base.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        // An empty root AGENTS.override.md claims the dir: the plain
        // AGENTS.md beside it must NOT be picked up (first candidate wins).
        write(&repo.join("AGENTS.override.md"), "");
        write(&sub.join("AGENTS.md"), "sub rules");
        let docs = project_docs(&sub, PROJECT_DOC_MAX_BYTES);
        assert_eq!(docs.len(), 1);
        assert!(docs[0].contents.contains("sub rules"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn budget_truncates_and_stops() {
        let base = tmp("budget");
        let repo = base.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        let big = "a".repeat(3000);
        write(&repo.join("AGENTS.md"), &big);
        write(&sub.join("AGENTS.md"), "tiny");
        // A 2100-byte budget truncates the root doc to exactly the budget
        // and stops — the deep file is dropped entirely.
        let docs = project_docs(&sub, 2100);
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].contents.len(), 2100);
        // A generous budget keeps both.
        assert_eq!(project_docs(&sub, 10_000).len(), 2);
        // A tight budget stops before the first file.
        assert!(project_docs(&sub, 0).is_empty());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn assemble_orders_global_then_project_with_the_separator() {
        let base = tmp("assemble");
        let cfg = base.join("cfg");
        let repo = base.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();

        // Nothing anywhere → None.
        assert!(assemble(&cfg, &sub).is_none());

        // Global + project chain: separator only at the transition.
        write(&cfg.join("AGENTS.md"), "global rules");
        write(&repo.join("AGENTS.md"), "root rules");
        write(&sub.join("AGENTS.md"), "sub rules");
        let text = assemble(&cfg, &sub).unwrap();
        let idx = text.find("--- project-doc ---").unwrap();
        assert!(text.find("global rules").unwrap() < idx);
        assert!(text.find("root rules").unwrap() > idx);
        assert!(text.find("root rules").unwrap() < text.find("sub rules").unwrap());
        assert_eq!(text.matches("--- project-doc ---").count(), 1);

        // Global alone → no separator.
        let solo = base.join("solo");
        std::fs::create_dir_all(&solo).unwrap();
        let text = assemble(&cfg, &solo).unwrap();
        assert_eq!(text, "global rules");

        std::fs::remove_dir_all(&base).unwrap();
    }
}
