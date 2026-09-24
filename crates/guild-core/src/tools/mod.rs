//! Built-in tools and the tool registry (spec §3.2). Tools are the agent's
//! hands: scoped to the project dir, schema-validated, approval-gated.

pub mod artifacts;
pub mod fs;
pub mod shell;
pub mod workspace;

use async_trait::async_trait;
use protocol::api::ToolSpec;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Per-tool approval default (spec §3.2: always / never / ask).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Allow,
    Ask,
    Never,
}

/// What a successful tool run leaves behind.
#[derive(Debug, Clone)]
pub struct ToolOutcome {
    /// What the model sees on the next turn.
    pub output_for_model: String,
    /// One-line summary for the UI transcript.
    pub ui_summary: Option<String>,
    /// Unified diff for file edits (UI rendering).
    pub diff: Option<String>,
    /// Widget payload for the UI (spec C.2): card kind + tool-owned render
    /// hints, persisted with the tool_result event. Opaque to the loop.
    pub meta: Option<serde_json::Value>,
    /// Image parts (data URIs) attached to the tool result for vision-capable
    /// models — e.g. read_file on an image attaches it for direct viewing.
    pub images: Vec<String>,
    /// Binary payload the tool hands the model as a spilled artifact (tool
    /// artifacts design): the worker stores the bytes in object storage and
    /// replaces the tool result text with a pointer to the materialized
    /// file. Carrying a payload always spills, regardless of size.
    pub artifact: Option<ToolArtifact>,
}

/// Binary payload a tool returns for spill-through: the worker persists it
/// as a `tool_artifacts` row + object-storage bytes and gives the model a
/// pointer path instead of the raw content.
#[derive(Debug, Clone)]
pub struct ToolArtifact {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum ToolFailure {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("execution failed: {0}")]
    Execution(String),
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn default_policy(&self) -> Approval;
    async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    order: Vec<String>,
    /// Materialization hooks consulted before a tool runs: spilled
    /// tool-result artifacts are pulled on first touch (tool-artifacts
    /// spec). Absent → tools run without artifact handling.
    artifacts: Option<Arc<artifacts::ArtifactHooks>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            order: Vec::new(),
            artifacts: None,
        }
    }

    /// Installs artifact materialization hooks (shared index + fetch
    /// source) for the engine's runs of one process.
    pub fn with_artifacts(mut self, hooks: Arc<artifacts::ArtifactHooks>) -> Self {
        self.artifacts = Some(hooks);
        self
    }

    pub fn builtins() -> Self {
        let mut r = Self::new();
        r.add(Arc::new(fs::ReadFile::default()));
        r.add(Arc::new(fs::WriteFile));
        r.add(Arc::new(fs::EditFile));
        r.add(Arc::new(shell::RunCommand));
        r
    }

    /// Built-ins whose read_file may also read the given roots — used for
    /// skill dirs discovered outside the workspace (skills design §3).
    pub fn builtins_with_read_roots(roots: Vec<std::path::PathBuf>) -> Self {
        let mut r = Self::new();
        r.add(Arc::new(fs::ReadFile {
            extra_read_roots: roots,
            ..Default::default()
        }));
        r.add(Arc::new(fs::WriteFile));
        r.add(Arc::new(fs::EditFile));
        r.add(Arc::new(shell::RunCommand));
        r
    }

    pub fn add(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.spec().name;
        if !self.tools.contains_key(&name) {
            self.order.push(name.clone());
        }
        self.tools.insert(name, tool);
    }

    pub fn specs(&self) -> Vec<ToolSpec> {
        self.order.iter().map(|n| self.tools[n].spec()).collect()
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn names(&self) -> &[String] {
        &self.order
    }

    /// Validates args against the tool's JSON Schema, then runs it.
    pub async fn run(
        &self,
        name: &str,
        workdir: &Path,
        args: Value,
    ) -> Result<ToolOutcome, ToolFailure> {
        self.run_with_artifacts(name, workdir, args, self.artifacts.as_deref())
            .await
    }

    /// Per-call authenticated artifact source for a shared builtin registry.
    pub async fn run_with_artifacts(
        &self,
        name: &str,
        workdir: &Path,
        args: Value,
        hooks: Option<&artifacts::ArtifactHooks>,
    ) -> Result<ToolOutcome, ToolFailure> {
        let tool = self
            .get(name)
            .ok_or_else(|| ToolFailure::InvalidInput(format!("unknown tool {name}")))?;
        let spec = tool.spec();
        let compiled = jsonschema::validator_for(&spec.parameters)
            .map_err(|e| ToolFailure::InvalidInput(format!("bad tool schema: {e}")))?;
        if let Err(first) = compiled.validate(&args) {
            return Err(ToolFailure::InvalidInput(format!(
                "arguments for {name} failed validation: {first}"
            )));
        }
        if let Some(hooks) = hooks {
            artifacts::prepare(hooks, name, workdir, &args).await?;
        }
        tool.run(workdir, args).await
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolves `path` under `workdir` and rejects escapes. Absolute paths must
/// already be inside the workdir.
pub fn resolve_scoped(workdir: &Path, path_str: &str) -> Result<PathBuf, ToolFailure> {
    resolve_scoped_in(workdir, &[], path_str)
}

/// Same, with additional allowed read roots (e.g. discovered skill dirs
/// living outside the workspace, like `~/.agents/skills`). A path that
/// canonicalizes under one of the roots is accepted.
pub fn resolve_scoped_in(
    workdir: &Path,
    extra_roots: &[std::path::PathBuf],
    path_str: &str,
) -> Result<PathBuf, ToolFailure> {
    let raw = Path::new(path_str);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workdir.join(raw)
    };
    let base = workdir
        .canonicalize()
        .map_err(|e| ToolFailure::InvalidInput(format!("bad workdir: {e}")))?;
    let resolved = match joined.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Target may not exist yet (write_file): canonicalize the
            // nearest existing ancestor, then walk the missing tail
            // component by component. A missing component may be a
            // dangling symlink whose target would carry the write
            // outside the workspace, so lexical rejoining is not enough.
            let mut missing: Vec<std::ffi::OsString> = vec![];
            let mut probe: &Path = &joined;
            let existing = loop {
                match probe.canonicalize() {
                    Ok(p) => break p,
                    Err(_) => match probe.parent() {
                        Some(p) => {
                            if let Some(name) = probe.file_name() {
                                missing.push(name.to_os_string());
                            }
                            probe = p;
                        }
                        None => {
                            return Err(ToolFailure::InvalidInput(format!(
                                "path not found: {path_str}"
                            )))
                        }
                    },
                }
            };
            let mut resolved = existing;
            for part in missing.into_iter().rev() {
                let candidate = resolved.join(&part);
                let is_link = std::fs::symlink_metadata(&candidate)
                    .ok()
                    .is_some_and(|md| md.file_type().is_symlink());
                if is_link {
                    let target = std::fs::read_link(&candidate).map_err(|e| {
                        ToolFailure::InvalidInput(format!("path resolution failed: {e}"))
                    })?;
                    resolved = if target.is_absolute() {
                        target
                    } else {
                        resolved.join(target)
                    };
                    if let Ok(real) = resolved.canonicalize() {
                        resolved = real;
                    }
                } else {
                    resolved = candidate;
                }
            }
            resolved
        }
        Err(e) => {
            return Err(ToolFailure::InvalidInput(format!(
                "path resolution failed: {e}"
            )))
        }
    };
    if resolved.starts_with(&base) {
        return Ok(resolved);
    }
    for root in extra_roots {
        if let Ok(root_canon) = root.canonicalize() {
            if resolved.starts_with(&root_canon) {
                return Ok(resolved);
            }
        }
    }
    Err(ToolFailure::InvalidInput(format!(
        "path escapes the project directory: {path_str}"
    )))
}

pub fn diff_text(old: &str, new: &str, path: &Path) -> String {
    let d = similar::TextDiff::from_lines(old, new);
    d.unified_diff()
        .context_radius(3)
        .header(
            &format!("a/{}", path.display()),
            &format!("b/{}", path.display()),
        )
        .to_string()
}

const MAX_MODEL_OUTPUT: usize = 64 * 1024;

fn truncate(s: String) -> String {
    if s.len() > MAX_MODEL_OUTPUT {
        let mut cut = MAX_MODEL_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n[truncated]", &s[..cut])
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_scoped_rejects_escape() {
        let dir = std::env::temp_dir().join(format!("guild-scope-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        assert!(resolve_scoped(&dir, "sub/../file.txt").is_ok());
        assert!(resolve_scoped(&dir, "../outside.txt").is_err());
        assert!(resolve_scoped(&dir, "/etc/passwd").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn resolve_scoped_rejects_dangling_symlink_escapes() {
        let tag = format!("guild-scope3-{}", std::process::id());
        let base = std::env::temp_dir().join(&tag);
        let dir = base.join("project");
        let outside = base.join("outside");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Dangling link directly in the workspace: the write would create
        // the outside target.
        std::os::unix::fs::symlink(outside.join("new-file"), dir.join("link")).unwrap();
        assert!(resolve_scoped(&dir, "link").is_err());
        assert!(!outside.join("new-file").exists());
        // Dangling link as a missing-tail intermediate component.
        assert!(resolve_scoped(&dir, "link/deeper.txt").is_err());
        assert!(!outside.join("new-file").exists());
        // An existing symlink to an outside file stays rejected too.
        std::fs::write(outside.join("real"), "x").unwrap();
        std::os::unix::fs::symlink(outside.join("real"), dir.join("link2")).unwrap();
        assert!(resolve_scoped(&dir, "link2").is_err());
        // A missing file under a real workspace dir still resolves.
        assert!(resolve_scoped(&dir, "sub-new/file.txt").is_ok());
        // A relative dangling target that stays inside the workspace is
        // allowed and resolves to its target path.
        std::os::unix::fs::symlink("inner-target", dir.join("link3")).unwrap();
        assert_eq!(
            resolve_scoped(&dir, "link3").unwrap(),
            dir.join("inner-target")
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn resolve_scoped_in_allows_skill_roots_only() {
        let tag = format!("guild-scope2-{}", std::process::id());
        let base = std::env::temp_dir().join(&tag);
        // workdir (the project) and the "home" with skills are separate trees
        let dir = base.join("project");
        let skill_root = base.join("home/.agents/skills/deploy-check");
        std::fs::create_dir_all(&skill_root).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(skill_root.join("SKILL.md"), "body").unwrap();
        let roots = vec![skill_root.clone()];
        // inside an extra root: allowed
        let sk = format!("{}/SKILL.md", skill_root.display());
        assert!(resolve_scoped_in(&dir, &roots, &sk).is_ok());
        // elsewhere in the fake home: still rejected
        let other = format!("{}/secrets.txt", base.join("home").display());
        assert!(resolve_scoped_in(&dir, &roots, &other).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn diff_renders() {
        let d = diff_text("a\nb\n", "a\nc\n", Path::new("f.txt"));
        assert!(d.contains("-b") && d.contains("+c"));
    }

    #[test]
    fn truncate_handles_multibyte() {
        let s = "абвгд".repeat(20_000);
        let t = truncate(s);
        assert!(t.ends_with("[truncated]"));
    }
}
