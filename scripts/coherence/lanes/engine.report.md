lane:       engine
read:       26 files, all read in full
model:      1 concept added, 11 attaches, 5 no_concept added (1 entry moved out), 0 types_no_concept
gaps:       none added — `exec-policy` declares domain/db/report with 2 translations
findings:   4 mechanical, 6 design

Model fixes applied in this fragment:

- `session` claimed the type `Pair`; `Pair` is `crates/app-server/src/daemon.rs:56`
  (the duplex connection). Moved to `daemon`.
- `skill-sync` claimed `SkillEntry` and `SkillProvenance` with canonical
  `skill_sync.rs`, but both types are defined in
  `crates/app-server/src/registry_client.rs:291` and `:305`. `skill_sync.rs`
  only imports them (`:12`). Added `registry_client.rs` as the `db`
  representation and removed it from `no_concept`.
- `crates/protocol/build.rs` feeds `BUILD_ID` in `crates/protocol/src/rpc.rs:15`.
  It is a build script, so it is `infrastructure`.

---

FINDING:  Two complete exec-policy engines exist; the Rust one has no importer and the TS one runs in production
PATTERN:  duplicate
WHERE:    crates/codex-execpolicy/src/policy.rs:1 and apps/server/src/execpolicy/matcher.ts:1
COST:     A reader who opens the Rust crate learns a design that nothing links. No
          Cargo.toml in the workspace depends on `codex-execpolicy` or on
          `codex-utils-absolute-path`. The live gate is the TS port, which repeats the
          same types under new names (`Decision` vs `DecisionKind`, `RuleMatch` vs
          `PrefixRuleSpec`) and ignores `network_rule` and `host_executable`
          (`rule-parser.ts:9-11`). Two places to change for one behaviour.
OPTION A: keep the TS gate - delete both vendored crates (3965 LOC) or move them
          out of the workspace; nothing breaks, the TS tests and
          `exec_policy_base.rules` stay the source; small effort.
OPTION B: keep the Rust gate - make the server or the engine call it and delete the
          TS port; breaks the server's dependency on a static-asset-only rule load and
          needs a process bridge; large effort.
ASK:      Is the exec gate meant to run in Rust or in the TS server?

FINDING:  One permission noun has three vocabularies with different third members
PATTERN:  alias-collision
WHERE:    crates/guild-core/src/tools/mod.rs:19-22 and crates/codex-execpolicy/src/decision.rs:11-15
          and apps/server/src/execpolicy/matcher.ts:12-15
COST:     `Approval {Allow, Ask, Never}`, `Decision {Allow, Prompt, Forbidden}` and
          `ExecPolicyDecision {allow | deny | prompt}` all answer "may this command
          run?". `Never` and `Forbidden` mean the same thing under different words;
          `Ask` and `Prompt` likewise; the TS form spells the deny case `deny` while
          its own parser spells it `forbidden` (`rule-parser.ts:13`). A reader must
          learn three tables and two orderings (`matcher.ts:18` ranks `allow < prompt
          < forbidden`; `policy.rs` relies on the Rust `Ord` derive).
OPTION A: keep `Approval` - map `Decision` onto it at the one boundary that needs it
          (there is none today) and fix the TS `deny`/`forbidden` split; no break, small
          effort.
OPTION B: keep `Decision` - rename `Approval` to it and delete `ExecPolicyDecision`;
          breaks the engine protocol field `agent.policy.set` values and the persisted
          policy JSON; medium effort.
ASK:      Is "never run this" a third value of the approval enum, or a separate
          block decision?

FINDING:  `session` names the stored login token, the engine's shared state, and the server's login row
PATTERN:  alias-collision
WHERE:    crates/app-server/src/session_store.rs:10 and crates/app-server/src/jsonrpc_loop.rs:26
          and crates/app-server/src/auth_state.rs:45
COST:     Three nouns, one word, one crate. `StoredSession` is one persisted workspace
          row. `Session` is the engine's mutable state (auth, model, chat, policy,
          pending approvals). `AuthState`
          is the in-memory login. The model keeps two separate records with the id
          `session` (`engine.json`, `server-core.json`), so the check sees no collision.
          A reader cannot tell which "session" a comment means.
OPTION A: keep `session` for the login only - rename `jsonrpc_loop::Session` to
          `EngineState`; breaks every test that builds `Session { .. }`; small effort.
OPTION B: keep `Session` as the engine state - rename the stored one to
          `WorkspaceSession` and the concept id to `login-session`; breaks the model
          record and the sidecar field names; medium effort.
ASK:      Does "session" in the engine mean "a logged-in workspace" or "the engine's
          live state"?

FINDING:  Production code branches on four env vars that exist only so tests can redirect it
PATTERN:  seam
WHERE:    crates/app-server/src/daemon.rs:17 and crates/app-server/src/daemon.rs:41
          and crates/app-server/src/session_store.rs:48 and crates/app-server/src/machine_link.rs:38
COST:     `GUILD_DAEMON_SOCKET`, `GUILD_TOKEN_PATH`, `GUILD_LINK_HEARTBEAT_SECS` and
          `GUILD_LINK_IDLE_SECS` are read at runtime, so tests mutate process-global
          state and must serialize on a mutex (`tests/daemon.rs:26`). The check reports
          zero declared seams. A reader cannot see which override is a test hook and
          which is a real deployment knob. The socket override is written twice, once
          per cfg branch.
OPTION A: keep the env overrides - declare each as a `coherence:seam` with an owner
          and a delete date, and read the socket override once above the cfg split;
          no behaviour change, small effort.
OPTION B: replace them with an explicit config struct passed to `socket_path`,
          `store_watch_path` and `run`; removes the test mutex and the duplicate read;
          touches every daemon and link caller; medium effort.
ASK:      Are these env vars a supported operator knob or a test-only hook?

FINDING:  The same loopback-listener helper is copied into three test files, and all three comments point at a file that no longer exists
PATTERN:  duplicate
WHERE:    crates/app-server/tests/machine_link_dispatch.rs:19-45 and
          crates/app-server/tests/machine_link_idle.rs:20-42 and
          crates/app-server/tests/machine_link_reconnect.rs:16-38
COST:     Three copies of a 25-line `/proc/net/tcp` scan, already drifted
          (`if let Some(p)` vs `if let Ok(p)`). Each comment says "see
          tests/agent_rpc.rs"; `crates/app-server/tests/` has no such file. A reader
          who changes the port-collision rule must find all three, and the comment
          sends them to a dead end.
OPTION A: keep the copies - delete the stale comments and accept three copies;
          trivial effort, drift stays.
OPTION B: keep one - add `crates/app-server/tests/common/mod.rs` with the helper and
          import it from all three; removes the drift and the dead pointer; small
          effort.
ASK:      Should shared test helpers live in a `tests/common` module here?

FINDING:  The migration re-parses rule lines by string prefix, next to a parser that parses them properly, and nothing calls it
PATTERN:  duplicate
WHERE:    crates/codex-execpolicy/src/sandbox_migration.rs:102-116 and
          crates/codex-execpolicy/src/parser.rs:349-460
COST:     `should_remove_rule` rebuilds the rule grammar with `strip_prefix("prefix_rule(pattern=")`
          and a JSON decode of the pattern. It accepts only the exact one-line form
          `amend.rs` writes, so a rule with `justification`, extra spaces, or a
          multi-line call is silently kept. `prefix_rule_migration` has no caller in the
          tree, and its marker file `.sandbox_migration` is named nowhere else.
OPTION A: keep it - give it a caller and a seam marker, and parse with `PolicyParser`
          instead of string surgery; no behaviour break; small effort.
OPTION B: keep the parser - delete `sandbox_migration.rs` and its test module; nothing
          imports them; trivial effort.
ASK:      Is the one-shot sandbox rule migration still part of the shipped engine?

FINDING:  The stdio interop test hand-writes the RPC envelope with a literal protocol number
PATTERN:  boundary
WHERE:    crates/app-server/tests/engine_stdio.rs:71-74 and crates/app-server/tests/daemon.rs:43
COST:     One test builds `{"jsonrpc":"2.0","id":..,"protocol":1,..}` by hand; the other
          calls `Request::new`, which stamps `PROTOCOL_VERSION`. If the version moves,
          the hand-written test keeps passing against the old number and the failure
          looks like a server bug. The hand-written form also drops `Request::is_valid`.
OPTION A: keep the literal - add a comment that the literal is deliberate; the drift
          risk stays; trivial effort.
OPTION B: keep `Request::new` - build the envelope from `protocol::rpc::Request`;
          no break, trivial effort.
ASK:      Must this test pin protocol 1 on purpose?

FINDING:  Three link tests set the auth fields directly, bypassing the declared single mutation path
PATTERN:  boundary
WHERE:    crates/app-server/tests/auth_state.rs:6 and crates/app-server/tests/machine_link_dispatch.rs:213
          (also machine_link_idle.rs:95, machine_link_reconnect.rs:91)
COST:     The auth-state test file states that `AuthState::transition` is the only
          mutation path. The three link tests call `AuthState::from_parts(..)` with four
          positional options and write `session.auth` themselves. A change to what
          `transition` publishes — for example the parked-link rule that the auth test
          pins — will not be exercised by any link test.
OPTION A: keep `from_parts` - document it as the test-only constructor and keep the
          four positional arguments; small effort, the bypass stays.
OPTION B: keep `transition` - build the link fixtures with
          `AuthState::default()` plus `transition`, as `auth_state.rs` does; the link
          tests then cover the real path; small effort.
ASK:      May tests construct auth state directly, or must they go through `transition`?

FINDING:  Eight concept ids exist in two or three fragments at once, and the check cannot see it
PATTERN:  duplicate
WHERE:    scripts/coherence/models/engine.json (session, approval) and
          scripts/coherence/models/server-core.json (session, approval, chat, machine,
          project, skill, agent, thread-event)
COST:     `chat`, `machine`, `project`, `skill`, `agent`, `thread-event`, `session` and
          `approval` each have one record per layer, with the same id, the same alias
          and no translation between the records. `approval` has three. The model says
          one concept has one canonical home; here eight concepts have two or three.
          `check.py:327` compares an alias against `alias_owner` and skips the case
          where the owner equals the id, so a repeated id never reports a collision.
          The stated rule "no two concepts share an id" is not enforced.
OPTION A: keep per-layer records - give each one a distinct id (`session-wire`,
          `session-db`) and declare the translations; the model grows but the check
          works; medium effort, touches four fragments.
OPTION B: keep one record per concept - fold the layer records into one record with
          representations and translations; the model shrinks and the translation gaps
          become visible; medium effort, touches four fragments.
ASK:      Is one concept one record, or one record per layer?

FINDING:  The model attributed two registry types to `skill_sync.rs`, which only imports them
PATTERN:  no-home
WHERE:    scripts/coherence/models/engine.json (skill-sync types) and
          crates/app-server/src/registry_client.rs:291,305
COST:     `SkillEntry` and `SkillProvenance` are defined in `registry_client.rs`.
          `skill_sync.rs:12` imports `SkillProvenance` and never names `SkillEntry`.
          A reader following the model looks in the wrong file. Same class of error as
          `Pair`, which the model gave to `session` while `daemon.rs:56` defines it.
OPTION A: keep the types where they are - record `registry_client.rs` as the `db`
          representation of `skill-sync` (done in this fragment); no code change.
OPTION B: keep the canonical in `skill_sync.rs` - move the two types there and
          re-export them; breaks `registry_client` callers; small effort.
ASK:      Is the skill provenance sidecar owned by skill sync or by the registry client?
