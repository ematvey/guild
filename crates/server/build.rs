//! Build-time exec-policy compilation: the vendored `codex-execpolicy`
//! Starlark parser runs HERE, not at runtime — `starlark` enables
//! `serde_json/arbitrary_precision`, a cargo-global feature that breaks
//! internally-tagged serde deserialization (every `StreamEvent` frame in the
//! server) wherever it links. The build script parses the embedded rules and
//! emits plain JSON the runtime reconstructs into a `Policy` without
//! starlark in the graph.
//!
//! The repo ships NO local rules layer. Deployment-local exec rules are a
//! deployment artifact, not a repo artifact: a deployment that wants them
//! drops an `exec_policy_local.rules` next to the base file in its own build
//! environment, and the build picks it up only if that file exists. An
//! absent file is the normal base-only build; a present-but-unparseable file
//! degrades to base-only with a build warning. Whatever a deployment puts in
//! that file is linted by the same rules as the base layer.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let base = manifest.join("assets/exec_policy_base.rules");
    let local = manifest.join("assets/exec_policy_local.rules");
    println!("cargo:rerun-if-changed={}", base.display());
    println!("cargo:rerun-if-changed={}", local.display());

    let base_src = std::fs::read_to_string(&base).expect("base rules exist");
    match std::fs::read_to_string(&local) {
        Ok(local_src) => {
            let mut parser = codex_execpolicy::PolicyParser::new();
            parser
                .parse("guild-base", &base_src)
                .expect("embedded base exec policy rules parse");
            match parser.parse("guild-local", &local_src) {
                Ok(()) => emit(&parser.build()),
                Err(e) => {
                    // A broken local layer degrades to base-only: the same
                    // fallback the runtime loader would apply to a
                    // hand-edited file.
                    println!(
                        "cargo:warning=local exec policy rules do not parse, building with base rules only: {e}"
                    );
                    let mut parser = codex_execpolicy::PolicyParser::new();
                    parser
                        .parse("guild-base", &base_src)
                        .expect("embedded base exec policy rules parse");
                    emit(&parser.build());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No deployment-local layer: base-only build.
            let mut parser = codex_execpolicy::PolicyParser::new();
            parser
                .parse("guild-base", &base_src)
                .expect("embedded base exec policy rules parse");
            emit(&parser.build());
        }
        Err(e) => panic!("local exec policy rules unreadable: {e}"),
    }
}

#[derive(serde::Serialize)]
#[serde(untagged)]
enum RestToken {
    Single(String),
    Alts(Vec<String>),
}

#[derive(serde::Serialize)]
struct RuleSpec {
    first: String,
    rest: Vec<RestToken>,
    decision: String,
    justification: Option<String>,
}

/// Shell interpreters whose `-c`-style flag turns any argument string into
/// arbitrary code — an allow rule may not be (or end at) such an invocation,
/// since prefix matching leaves every token after the pattern unconstrained.
const SHELL_INTERPRETERS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "ksh", "ash", "cmd", "powershell", "pwsh",
];
const SHELL_C_FLAGS: &[&str] = &[
    "-c", "-lc", "-ic", "-ec", "-cl", "/c", "/k", "-command", "-encodedcommand",
];
/// Single-token allow patterns that hand an unconstrained argument list to
/// an arbitrary-execution primitive.
const BARE_EXEC_PRIMITIVES: &[&str] = &["docker", "ssh", "systemd-run", "sudo", "curl"];

fn token_is_shell_c_flag(token: &str) -> bool {
    SHELL_C_FLAGS.contains(&token.to_ascii_lowercase().as_str())
}

/// Build fails when an `allow` rule is itself an arbitrary-execution
/// primitive: a shell-interpreter prefix (`zsh -lc …`, `cmd /c …`) or a bare
/// `docker` / `ssh` / `systemd-run` / `sudo` / `curl` with no fully-specified
/// argument list. `forbidden` rules are exempt — denying is the point.
fn lint_allow_rule(first: &str, rest: &[RestToken]) {
    let basename = first
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(first)
        .to_ascii_lowercase();
    let violation = if SHELL_INTERPRETERS.contains(&basename.as_str()) {
        rest.is_empty()
            || rest.iter().any(|t| match t {
                RestToken::Single(s) => token_is_shell_c_flag(s),
                RestToken::Alts(alts) => alts.iter().any(|a| token_is_shell_c_flag(a)),
            })
    } else {
        rest.is_empty() && BARE_EXEC_PRIMITIVES.contains(&basename.as_str())
    };
    if violation {
        panic!(
            "exec policy lint: allow rule for {first:?} is an arbitrary-execution \
             primitive (shell-interpreter prefix, or bare docker/ssh/systemd-run/\
             sudo/curl with no fully-specified argument list); restrict or remove it"
        );
    }
}

/// Serializes every parsed prefix rule (pattern structure + justification)
/// into `{OUT_DIR}/exec_policy_rules.json` for the runtime loader.
fn emit(policy: &codex_execpolicy::Policy) {
    let mut specs: Vec<RuleSpec> = Vec::new();
    for (_program, rules) in policy.rules().iter_all() {
        for rule in rules {
            let Some(prefix) = rule.as_any().downcast_ref::<codex_execpolicy::PrefixRule>() else {
                continue; // host-executable metadata etc. — evaluation-only
            };
            let rest: Vec<RestToken> = prefix
                .pattern
                .rest
                .iter()
                .map(|token| match token {
                    codex_execpolicy::PatternToken::Single(s) => RestToken::Single(s.clone()),
                    codex_execpolicy::PatternToken::Alts(alts) => {
                        RestToken::Alts(alts.to_vec())
                    }
                })
                .collect();
            let decision = serde_json::to_value(prefix.decision)
                .unwrap()
                .as_str()
                .unwrap_or("prompt")
                .to_string();
            if decision == "allow" {
                lint_allow_rule(&prefix.pattern.first, &rest);
            }
            specs.push(RuleSpec {
                first: prefix.pattern.first.to_string(),
                rest,
                decision,
                justification: prefix.justification.clone(),
            });
        }
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("exec_policy_rules.json");
    std::fs::write(&out, serde_json::to_string(&specs).unwrap()).expect("write parsed rules");
}
