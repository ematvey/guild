use guild_core::tools::{fs::*, shell::RunCommand, Approval, Tool, ToolRegistry};
use protocol::api::ToolSpec;
use serde_json::json;
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
    let out = ReadFile::default()
        .run(&dir, json!({"path": "a.txt"}))
        .await
        .unwrap();
    assert_eq!(out.output_for_model, "hello world");
    assert!(ReadFile::default()
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
        .run(
            &dir,
            json!({"path": "a.txt", "oldText": "zzz", "newText": "q"}),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not found"));
    // ambiguous
    let err = EditFile
        .run(
            &dir,
            json!({"path": "a.txt", "oldText": "alpha", "newText": "q"}),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("2 times"));
    // success
    let out = EditFile
        .run(
            &dir,
            json!({"path": "a.txt", "oldText": "beta", "newText": "gamma"}),
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
async fn execute_captures_and_times_out() {
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
    assert_eq!(dp("write_file"), Approval::Ask);
    assert_eq!(dp("edit_file"), Approval::Ask);
    assert_eq!(dp("execute"), Approval::Ask);
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
        (
            "edit_file",
            json!({"path": "../x", "oldText": "a", "newText": "b"}),
        ),
    ] {
        let err = ToolRegistry::builtins()
            .run(tool, &dir, args)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("escapes"), "{tool}: {err}");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn read_file_attaches_images_as_data_uris() {
    let dir = scratch("image");
    // 1x1 png
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    std::fs::write(dir.join("pic.png"), png).unwrap();
    let out = ReadFile::default()
        .run(&dir, json!({"path": "pic.png"}))
        .await
        .unwrap();
    assert!(out.output_for_model.contains("attached"));
    assert_eq!(out.images.len(), 1);
    assert!(out.images[0].starts_with("data:image/png;base64,"));

    // binary non-image → explanatory text, no image parts
    std::fs::write(dir.join("clip.mp4"), [0xFFu8, 0xFE, 0x00, 0x01]).unwrap();
    let out = ReadFile::default()
        .run(&dir, json!({"path": "clip.mp4"}))
        .await
        .unwrap();
    assert!(
        out.output_for_model.contains("binary file"),
        "{}",
        out.output_for_model
    );
    assert!(out.images.is_empty());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn read_file_offset_limit_paging() {
    let dir = scratch("paging");
    let body: String = (1..=50).map(|i| format!("line {i}\n")).collect();
    std::fs::write(dir.join("a.txt"), &body).unwrap();
    let out = ReadFile::default()
        .run(&dir, json!({"path": "a.txt", "offset": 10, "limit": 5}))
        .await
        .unwrap();
    assert_eq!(
        out.output_for_model,
        "line 10\nline 11\nline 12\nline 13\nline 14"
    );
    let meta = out.meta.unwrap();
    assert_eq!(meta["offset"], 10);
    assert_eq!(meta["limit"], 5);
    assert_eq!(meta["total_lines"], 50);
    // offset past the end yields empty output
    let out = ReadFile::default()
        .run(&dir, json!({"path": "a.txt", "offset": 60}))
        .await
        .unwrap();
    assert_eq!(out.output_for_model, "");
    // defaults: no offset/limit reads everything
    let out = ReadFile::default()
        .run(&dir, json!({"path": "a.txt"}))
        .await
        .unwrap();
    assert!(out.output_for_model.starts_with("line 1\n"));
    assert!(out.output_for_model.ends_with("line 50"));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The protocol's client-tool declaration is the single source of truth: the
/// registry must re-export it verbatim so what the model sees matches what
/// the executor validates.
#[test]
fn registry_specs_match_client_tool_specs() {
    let declared = protocol::api::client_tool_specs();
    let reg = ToolRegistry::builtins();
    let actual = reg.specs();
    assert_eq!(
        actual, declared,
        "registry specs drifted from protocol declaration"
    );
    for s in &declared {
        assert!(
            reg.get(&s.name).is_some(),
            "registry missing tool {}",
            s.name
        );
    }
}

/// A timed-out command must not survive as an orphan process: the child is
/// killed when the wait future is dropped (kill_on_drop).
#[tokio::test]
async fn execute_timeout_kills_the_child() {
    let dir = scratch("shell-kill");
    let marker = format!("guild-test-marker-{}", std::process::id());
    let err = RunCommand
        .run(
            &dir,
            json!({"command": format!("sleep 30 #{marker}"), "timeout_ms": 150}),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let probe = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(format!("ps -eo args | grep '{marker}' || true"))
        .output()
        .await
        .unwrap();
    let out = String::from_utf8_lossy(&probe.stdout).to_string();
    assert!(!out.contains("sleep 30"), "orphan survived: {out}");
    std::fs::remove_dir_all(&dir).unwrap();
}
