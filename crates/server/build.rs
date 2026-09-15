//! Build-time exec-policy compilation: the vendored `codex-execpolicy`
//! Starlark parser runs HERE, not at runtime — `starlark` enables
//! `serde_json/arbitrary_precision`, a cargo-global feature that breaks
//! internally-tagged serde deserialization (every `StreamEvent` frame in the
//! server) wherever it links. The build script parses the embedded rules and
//! emits plain JSON the runtime reconstructs into a `Policy` without
//! starlark in the graph.

use codex_execpolicy::Rule;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let base = manifest.join("assets/exec_policy_base.rules");
    let local = manifest.join("assets/exec_policy_local.rules");
    println!("cargo:rerun-if-changed={}", base.display());
    println!("cargo:rerun-if-changed={}", local.display());

    let mut parser = codex_execpolicy::PolicyParser::new();
    parser
        .parse(
            "guild-base",
            &std::fs::read_to_string(&base).expect("base rules exist"),
        )
        .expect("embedded base exec policy rules parse");
    match parser.parse(
        "guild-local",
        &std::fs::read_to_string(&local).expect("local rules exist"),
    ) {
        Ok(()) => emit(&parser.build()),
        Err(e) => {
            // A broken local layer degrades to base-only: the same fallback
            // the runtime loader would apply to a hand-edited file.
            println!(
                "cargo:warning=local exec policy rules do not parse, building with base rules only: {e}"
            );
            let mut parser = codex_execpolicy::PolicyParser::new();
            parser
                .parse("guild-base", &std::fs::read_to_string(&base).unwrap())
                .expect("embedded base exec policy rules parse");
            emit(&parser.build());
        }
    }
}

/// Serializes every parsed prefix rule (pattern structure + justification)
/// into `{OUT_DIR}/exec_policy_rules.json` for the runtime loader.
fn emit(policy: &codex_execpolicy::Policy) {
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

    let mut specs: Vec<RuleSpec> = Vec::new();
    for (_program, rules) in policy.rules().iter_all() {
        for rule in rules {
            let Some(prefix) = rule.as_any().downcast_ref::<codex_execpolicy::PrefixRule>()
            else {
                continue; // host-executable metadata etc. — evaluation-only
            };
            specs.push(RuleSpec {
                first: prefix.pattern.first.to_string(),
                rest: prefix
                    .pattern
                    .rest
                    .iter()
                    .map(|token| match token {
                        codex_execpolicy::PatternToken::Single(s) => RestToken::Single(s.clone()),
                        codex_execpolicy::PatternToken::Alts(alts) => {
                            RestToken::Alts(alts.to_vec())
                        }
                    })
                    .collect(),
                decision: serde_json::to_value(prefix.decision)
                    .unwrap()
                    .as_str()
                    .unwrap_or("prompt")
                    .to_string(),
                justification: prefix.justification.clone(),
            });
        }
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("exec_policy_rules.json");
    std::fs::write(&out, serde_json::to_string(&specs).unwrap()).expect("write parsed rules");
}
