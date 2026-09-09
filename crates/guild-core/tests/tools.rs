use guild_core::tools::{fs::*, git::GitTool, shell::RunCommand, Approval, Tool, ToolRegistry};
use protocol::api::ToolSpec;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "guild-tools-{}-{}-{}",
        tag,
        std::process::id(),
        AtomicU64::new(0).fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn read_file_happy_and_missing() {
    let dir = scratch("read");
    std::fs::write(dir.join("a.txt"), "hello world").unwrap();
    let out = ReadFile.run(&dir, json!({"path": "a.txt"})).await.unwrap();
    assert_eq!(out.output_for_model, "hello world");
    assert!(ReadFile
        .run(&dir, json!({"path": "nope.txt"}))
        .await
        .is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn write_file_creates_with_diff() {
    let dir = scratch("write");
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    let out = WriteFile
        .run(&dir, json!({"path": "a.txt", "content": "one\ntwo\n"}))
        .await
        .unwrap();
    let diff = out.diff.unwrap();
    assert!(diff.contains("+two"));
    let out = WriteFile
        .run(&dir, json!({"path": "nested/b.txt", "content": "x"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("nested/b.txt"));
    assert!(dir.join("nested/b.txt").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn edit_file_uniqueness_rules() {
    let dir = scratch("edit");
    std::fs::write(dir.join("a.txt"), "alpha\nbeta\nalpha\n").unwrap();
    // not found
    let err = EditFile
        .run(&dir, json!({"path": "a.txt", "old": "zzz", "new": "q"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not found"));
    // ambiguous
    let err = EditFile
        .run(&dir, json!({"path": "a.txt", "old": "alpha", "new": "q"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("2 times"));
    // success
    let out = EditFile
        .run(
            &dir,
            json!({"path": "a.txt", "old": "beta", "new": "gamma"}),
        )
        .await
        .unwrap();
    assert!(out.diff.unwrap().contains("+gamma"));
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap(),
        "alpha\ngamma\nalpha\n"
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn glob_respects_gitignore() {
    let dir = scratch("glob");
    std::fs::write(dir.join("visible.txt"), "").unwrap();
    std::fs::write(dir.join("ignored.txt"), "").unwrap();
    std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
    let out = GlobTool
        .run(&dir, json!({"pattern": "*.txt"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("visible.txt"));
    assert!(!out.output_for_model.contains("ignored.txt"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn grep_finds_matches() {
    let dir = scratch("grep");
    std::fs::write(dir.join("a.txt"), "the quick brown fox\nlazy dog\n").unwrap();
    let out = GrepTool
        .run(&dir, json!({"pattern": "quick"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("a.txt:1:"));
    let out = GrepTool
        .run(&dir, json!({"pattern": "nonexistent-string-xyz"}))
        .await
        .unwrap();
    assert_eq!(out.output_for_model, "no matches");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn run_command_captures_and_times_out() {
    let dir = scratch("shell");
    let out = RunCommand
        .run(&dir, json!({"command": "echo hi"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("exit code: 0") && out.output_for_model.contains("hi"));

    let out = RunCommand
        .run(&dir, json!({"command": "false"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("exit code: 1"));

    let err = RunCommand
        .run(&dir, json!({"command": "sleep 5", "timeout_ms": 200}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"));

    let err = RunCommand
        .run(&dir, json!({"command": "true", "cwd": ".."}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("escapes"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn git_readonly_in_real_repo() {
    let dir = scratch("git");
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&dir)
        .status()
        .unwrap();
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    let out = GitTool
        .run(&dir, json!({"subcommand": "status"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("f.txt"));
    let err = GitTool
        .run(&dir, json!({"subcommand": "push"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not read-only"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn registry_validates_schema_before_running() {
    let dir = scratch("registry");
    let reg = ToolRegistry::builtins();
    let err = reg
        .run("read_file", &dir, json!({"wrong": "shape"}))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("failed validation"), "{err}");
    let err = reg.run("mystery_tool", &dir, json!({})).await.unwrap_err();
    assert!(err.to_string().contains("unknown tool"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn default_policies_match_spec() {
    let reg = ToolRegistry::builtins();
    let dp = |name: &str| -> Approval { reg.get(name).unwrap().default_policy() };
    assert_eq!(dp("read_file"), Approval::Allow);
    assert_eq!(dp("glob"), Approval::Allow);
    assert_eq!(dp("grep"), Approval::Allow);
    assert_eq!(dp("git"), Approval::Allow);
    assert_eq!(dp("write_file"), Approval::Ask);
    assert_eq!(dp("edit_file"), Approval::Ask);
    assert_eq!(dp("run_command"), Approval::Ask);
    // specs are complete and well-formed
    let specs: Vec<ToolSpec> = reg.specs();
    assert_eq!(specs.len(), reg.names().len());
    assert!(specs.iter().all(|s| !s.description.is_empty()));
}

#[tokio::test]
async fn escape_rejection_consistent_across_fs_tools() {
    let dir = scratch("escape");
    for (tool, args) in [
        ("read_file", json!({"path": "../../etc/passwd"})),
        ("write_file", json!({"path": "../../etc/x", "content": "x"})),
        ("edit_file", json!({"path": "../x", "old": "a", "new": "b"})),
    ] {
        let err = ToolRegistry::builtins()
            .run(tool, &dir, args)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("escapes"), "{tool}: {err}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}
