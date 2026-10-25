lane:       srv-platform
read:       27 files, all read in full (none unreadable)
model:      13 concepts added, 26 attaches, 1 no_concept, 0 types_no_concept
gaps:       none added — every new concept declares translations for all of its roles
findings:   6 mechanical, 11 design

Note: `python3 scripts/coherence/check.py check` fails on `loc` (+39) from
other sessions' uncommitted edits in the same tree, not from this lane.
`check.py model` is clean. `unmapped_files` fell 215 → 180.

```
FINDING:  The org-KV key strings are declared twice: once by the writer, once by the reader. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/http/admin.ts:24,26 and apps/server/src/harness/extension.ts:16, apps/server/src/harness/approvals.ts:40
COST:     A reader must learn that the admin prompt route writes a key that a different module reads through its own private copy. If one literal changes, the admin writes a prompt that nothing reads, with no error.
OPTION A: Keep the constants in the harness (extension.ts, approvals.ts) - admin.ts imports both, deletes its two copies; no behaviour change, effort S.
OPTION B: Keep the constants in a platform settings module - both harness and admin import it; moves two files, effort S.
ASK:      Which module owns the org-KV key vocabulary?
```

```
FINDING:  The built-in approval policy prompt exists as two identical constants, and one cites a Rust file that does not exist. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/http/admin.ts:31-37 and apps/server/src/harness/approvals.ts:44
COST:     A reader must diff two 5-line prompts to learn they are the same text. The admin GET returns its copy as `default`; the gate runs the other copy. Edit one and the admin preview stops describing the real gate. The comment at admin.ts:31-32 points to crates/server/src/worker/restate.rs, which is gone.
OPTION A: Keep approvals.ts as the home - admin.ts imports DEFAULT_APPROVAL_POLICY_PROMPT; fixes the stale comment, effort S.
OPTION B: Keep both, declare a seam - no, the two texts must never differ.
ASK:      None - this one has one right answer.
```

```
FINDING:  PluginSecretSource is declared twice with the same three members. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/integrations/plugins.ts:18-24 and apps/server/src/platform/integrations/execute.ts:73-79
COST:     A reader must compare two interfaces to learn they are structurally identical, then decide which one a new caller should import. The comments are near-verbatim copies too.
OPTION A: Keep the declaration in plugins.ts - execute.ts imports the type; both already import each other's module, effort S.
OPTION B: Keep it in execute.ts - plugins.ts imports it; same effort, reverses the dependency direction.
ASK:      Which module owns the secret-resolution contract?
```

```
FINDING:  The v2 manifest secret-name rule is written twice, body for body. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/integrations/plugins.ts:172-185 (manifestSecretNames) and apps/server/src/platform/http/admin.ts:481-495 (declaredV2SecretNames)
COST:     A reader must learn that "settings secret fields, else auth.secret_names" is one rule kept in two files. admin.ts also reads `auth.secret_names` inline a third time at admin.ts:399-405.
OPTION A: Keep manifestSecretNames - admin.ts imports it and deletes its copy; the inline read at 401-405 collapses into the same call, effort S.
OPTION B: Keep both - accept that the save gate and the turn snapshot may derive different secret lists.
ASK:      None - one rule, one function.
```

```
FINDING:  Every vendor's base-URL resolution is implemented twice, and the GitLab pair disagrees. [design]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/integrations/connectors.ts:86-114 and the same functions in vendors/github.ts:9-12, vendors/gitlab.ts:8-18, vendors/hubspot.ts:6-8, vendors/langfuse.ts:6-14, vendors/slack.ts:6-8, vendors/firecrawl.ts:6-9
COST:     The save gate probes one URL; the tool call uses another. For GitLab the two rules differ: connectors.ts:90-92 defaults to https://gitlab.com/api/v4 and only trims, so base_url "https://gitlab.example.com" probes /user; vendors/gitlab.ts:15-17 appends /api/v4 for a bare host and calls /api/v4/user. A self-hosted GitLab row can pass or fail the save test on the wrong URL. The firecrawl default base is written three times (connectors.ts:84, vendors/shared.ts:29, integration-catalog.ts:52).
OPTION A: Keep the vendor modules as the home - connectors.ts imports each vendor's base-URL helper and drops its own; the GitLab save probe then matches the call, effort M.
OPTION B: Keep the save-gate copies - then declare them as the probe contract and fix the GitLab divergence by hand, effort S.
ASK:      Which URL does a save probe test: the vendor's resolved API base, or a separate probe URL?
```

```
FINDING:  The Google service-account token mint exists twice, and the two copies already differ. [design]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/integrations/connectors.ts:118-181 and apps/server/src/platform/integrations/vendors/google-workspace.ts:65-117
COST:     Two JWT builders, two service_account_json parsers, two admin_email resolutions. The runtime copy has a token cache (google-workspace.ts:26,68-72) and a clamps expires_in; the save-gate copy has neither and only proves the token endpoint answers. The scope string is also copied (connectors.ts:79-83, google-workspace.ts:7-11).
OPTION A: Keep the runtime copy - connectors.ts calls googleAccessToken with a throwaway cache, deletes its own; the save gate then tests the exact path a call uses, effort M.
OPTION B: Keep the save-gate copy - accept two implementations of one credential rule.
ASK:      Should the save gate mint a token the same way a real call does, or is a cheaper probe acceptable?
```

```
FINDING:  The same integration kinds are catalogued three times. [design]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/integration-catalog.ts:52, apps/server/src/platform/integrations/connectors.ts:183-852, apps/server/src/platform/integrations/execute.ts:29-43
COST:     One connector needs an entry in three lists: metadata (categories, fields, identity_key), tool declarations plus the save test, and the dispatch switch. Adding it to two of three fails silently - the admin lists it but a call says "unknown integration" (execute.ts:58) or resolvePlugins skips it (plugins.ts:243). integration-catalog.ts:5-8 still says tool declarations "stay Rust-side".
OPTION A: Keep connectors.ts as the home - it absorbs categories, fields and identity_key from the catalog; execute.ts dispatches through a map built from BUILTIN_CONNECTORS, effort M.
OPTION B: Keep the metadata catalog - connectors.ts and execute.ts derive from it; needs the tool declarations to move, effort L.
ASK:      Does one integration kind have one declaration file, and which?
```

```
FINDING:  The admin save path reads an approved manifest without the bundle-hash check that the turn path enforces. [design]
PATTERN:  unowned-seam
WHERE:    apps/server/src/platform/http/admin.ts:199-211 and apps/server/src/platform/integrations/plugins.ts:157-168
COST:     Two readers of the same approval. plugins.ts rejects a stored bundle whose sha256 no longer matches the approved one (plugins.ts:164-166); admin.ts reads the version and returns its manifest with no check. An admin who edits a stored bundle sees it in the admin UI, while turns refuse it.
OPTION A: Keep registryManifest as the only reader - admin.ts calls it and maps the error to a 400; the save path then enforces the same rule as a turn, effort S.
OPTION B: Keep the admin read - accept that the admin view shows content that turns will not run.
ASK:      Must an admin see only manifests that a turn would accept?
```

```
FINDING:  The noun `llm_calls` names a table that no code creates or writes. [design]
PATTERN:  dead-code
WHERE:    apps/server/src/platform/http/llm.ts:24-25, apps/server/src/platform/http/openai.ts:317,322, apps/server/src/platform/http/activity.ts:63-64, apps/server/src/platform/trace.ts:289-330
COST:     Five files describe "the llm_calls row", one comment says ClickHouse "never saw the DDL", and TraceStore.record actually writes an `llm` span into agent_spans (trace.ts:182). A reader must decide which of the two names is real. The same comment keeps an UNKNOWN_TABLE fallback path (activity.ts:65-68) alive for a table that never exists.
OPTION A: Keep `span` as the only noun - reword the five comments, delete the UNKNOWN_TABLE excuse only after confirming no deployment has the old table, effort S.
OPTION B: Keep llm_calls as a view - create it and make it the read path; larger change, effort L.
ASK:      Was llm_calls ever a real table, and does any deployment still have it?
```

```
FINDING:  The word `session` means three different things, and one trace row carries two of them under one key. [design]
PATTERN:  alias-collision
WHERE:    apps/server/src/platform/trace.ts:299-300 and apps/server/src/platform/trace.ts:325, apps/server/src/platform/http/llm.ts:69-71, apps/server/src/platform/http/activity.ts:152
COST:     `session` is a login session (server-core, store/identity.ts). In a trace, session_id is the chat id (trace.ts:299) and the activity API calls the chat a "session" (activity.ts:152). In a usage event, session_id is the API key id (llm.ts:69-71). TraceStore.record writes session_id=chat_id as the column and session_id=key-id inside attributes on the same row (trace.ts:300 and 325). A reader who joins usage rows to spans on session_id joins a key id to a chat id.
OPTION A: Keep `session` for the login session - rename the trace column to chat_id (it already exists beside it), rename the activity route to chats, and rename the usage field to api_key_id; effort M plus a ClickHouse migration.
OPTION B: Keep session_id as the analytics bucket - define it once ("the id that groups one run's records") and document that its value differs per table; effort S, keeps the trap.
ASK:      Which meaning of `session` survives, and can the ClickHouse columns be renamed?
```

```
FINDING:  One concept has three words: integration, connector, plugin; and the plugin executor kind is called "rust" although the code is TypeScript. [design]
PATTERN:  alias-collision
WHERE:    apps/server/src/platform/store/integrations.ts (aliases "connector"), apps/server/src/platform/integrations/plugins.ts:39-57, apps/server/src/platform/integrations/connectors.ts:22, apps/server/src/platform/integrations/execute.ts:95
COST:     A reader must learn that BuiltinConnector, PluginTurn and the integrations row are one thing. The stored snapshot says executor "rust" (plugins.ts:40) and execute.ts:95 branches on it, but the executor is the TypeScript connector in connectors.ts. A reader looking for the Rust dispatcher finds nothing.
OPTION A: Keep `integration` as the noun and `connector` for the compiled-in kind - rename Plugin* to Integration*, rename executor "rust" to "builtin"; the wire snapshot changes, so both writers and readers move together, effort M.
OPTION B: Keep `plugin` for the registry-v2 MCP case and `connector` for compiled-in kinds - declare both as legitimate kinds of integration and fix only the "rust" label, effort S.
ASK:      Is a plugin a kind of integration, or the general name for one?
```

```
FINDING:  The tool risk class has no single home, and the repo has two class vocabularies. [design]
PATTERN:  no-home
WHERE:    apps/server/src/platform/integrations/connectors.ts:860-879, apps/server/src/platform/integrations/plugins.ts:106-127, apps/server/src/platform/http/admin.ts:506-531, apps/server/src/harness/approvals.ts:64-82
COST:     The same rule ("declared class, else read") is written for a compiled-in connector and for a manifest (connectors.ts:860 and 868). The policy rank read<write<admin is in plugins.ts:106-127. The vocabulary is re-validated as string literals in admin.ts:517-528. A different class vocabulary (read_file, execute, write_file, edit_file) lives in approvals.ts:64-82 for the same word "class". A reader cannot tell which class set governs one tool call.
OPTION A: Keep one module for class + rank + vocabulary - connectors.ts and admin.ts import it; approvals.ts maps its names into it, effort M.
OPTION B: Keep the two vocabularies - declare them as different concepts (integration tool class vs client tool class) and name them differently, effort S.
ASK:      Are the integration tool class and the client tool class the same concept or two?
```

```
FINDING:  sse.ts carries two unrelated designs: the SSE frame decoder and the serde_json text renderer. [design]
PATTERN:  boundary
WHERE:    apps/server/src/platform/provider/sse.ts:1-103 and apps/server/src/platform/provider/sse.ts:105-143
COST:     Every HTTP module that needs a JSON body imports the SSE module: activity.ts:9, admin.ts:11, openai.ts:26, anthropic.ts:26. A reader who opens sse.ts for the stream decoder finds float formatting. rust-json is a concept with a canonical home inside a transport module.
OPTION A: Keep one file, rename it - provider/rust-json.ts holds the renderer, the decoder moves to provider/sse.ts; imports change in about eight files, effort S.
OPTION B: Keep both in sse.ts - the model declares the shared canonical, and the reader keeps the detour.
ASK:      None - the renderer is not SSE.
```

```
FINDING:  Two execute entry points for the same connector, with different secret handling. [design]
PATTERN:  unowned-seam
WHERE:    apps/server/src/platform/integrations/execute.ts:47-60 (executeConnectorTool) and apps/server/src/platform/integrations/execute.ts:85-129 (callPlugin)
COST:     callPlugin re-resolves every stored secret by name and passes the acting identity. executeConnectorTool takes a secrets array from its caller and ignores the turn snapshot. A new caller must learn which one enforces the "values never ride the snapshot" rule (execute.ts:62-63). Nothing states that the raw path is test-only.
OPTION A: Keep callPlugin as the only public path - export executeConnectorTool from a test helper module; effort S.
OPTION B: Keep both - document that executeConnectorTool is the raw connector surface and who may call it, effort S.
ASK:      Is the raw connector surface part of the product, or only a test seam?
```

```
FINDING:  The skill-read sink repeats the usage sink: same team-attribution SQL, same ensure-once, same catch-and-drop. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/skillReads.ts:30-71 and apps/server/src/platform/usage.ts:48-58
COST:     The "earliest team is primary" query is written twice, character for character (skillReads.ts:50-54, usage.ts:57-58). Two ClickHouse sinks also keep two copies of the ensure-once + defensive-log shape. A change to team attribution must be made in both.
OPTION A: Keep one attribution helper - usage.ts exports it, skillReads.ts calls it; effort S.
OPTION B: Keep both - accept that two analytics sinks may attribute to different teams.
ASK:      Does one attribution rule govern every analytics row?
```

```
FINDING:  The Serde-style 422 body is built twice, and both copies read the raw body through a symbol cast. [mechanical]
PATTERN:  duplicate
WHERE:    apps/server/src/platform/http/openai.ts:218-242 and apps/server/src/platform/http/anthropic.ts:321-332
COST:     Three hand-built `missing field` strings and one `invalid type` builder carry the axum/serde error contract. The `(req as never as Record<symbol, string>)[RAW_BODY]` cast appears in four places. A change to the contract needs edits in both files, in a shape no type checks.
OPTION A: Keep one builder in http/error.ts - both gateway surfaces import it; effort S.
OPTION B: Keep both - each wire shape keeps its own rejection text.
ASK:      None - the two bodies are byte-identical today.
```

```
FINDING:  plugins.ts is the canonical home of two concepts: the call envelope and the tool-class policy. [design]
PATTERN:  boundary
WHERE:    apps/server/src/platform/integrations/plugins.ts:88-103,190-208 and apps/server/src/platform/integrations/plugins.ts:106-139
COST:     The file resolves a turn snapshot (envelopeHeaders, resolvePlugins) and also owns the role/class gate (classRank, allowedClasses, toolAllowed). The model must declare the file as a shared canonical, which is the finding: one file, two designs, two readers.
OPTION A: Keep both, split by section - move the policy gate to integrations/policy.ts; effort S, and the shared_canonical entry goes away.
OPTION B: Keep one file - declare shared_canonical and accept that a reader of the envelope must also read the gate.
ASK:      Should the policy gate live beside the resolver or in its own module?
```

Out of lane, for the orchestrator (not fixed here): `apps/server/src/hub/protocol.ts`
and `apps/server/src/platform/store/integrations.ts` hold the second and third
copies of the integration-secret and tool-curation rules; those files belong to
other lanes.
