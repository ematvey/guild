# Worker tool discovery

This research note concerns the existing Tool and Integration concepts. Their canonical behavior is documented in [Capabilities](domain/004-capabilities.md). The recommendations below are proposals for an assistant harness, not implemented behavior. No runtime concept, type or dependency is introduced by this note.

## Evidence

[ToolRet](https://arxiv.org/html/2503.01763) benchmarks retrieval across approximately 7,600 tasks and 43,000 tools. Its downstream evaluation replaces an oracle tool set with retrieved tools and observes worse task completion. This establishes that tool availability is a task-success bottleneck; it does not compare coordinator-selected permissions against worker-selected permissions. The benchmark combines existing tool-use datasets and evaluates retrieval and task completion, not account authorization.

[Dynamic Tool Dependency Retrieval](https://arxiv.org/html/2512.17052) conditions tool retrieval on both the original query and the evolving tool-call history. Its results favor adapting retrieval as execution unfolds over static retrieval baselines. Its setting emphasizes lightweight function-calling models and demonstration-derived dependencies. The limitations identify unseen dependencies and unusual tool vocabularies as failure cases, and suggest passing all tools to the model when retrieval confidence is low. That means broadening the presented tool set, not granting new account access. The paper does not establish a permission-delegation model.

[Advanced tool use](https://www.anthropic.com/research/advanced-tool-use) documents deferred loading: a model searches a tool catalog and loads relevant definitions on demand while the full configured library remains available. This is first-party engineering evidence rather than an independent comparative study. Search adds latency and depends on useful descriptions; on-demand discovery is not a guarantee that every required tool is found.

## Existing Guild foundation

[Capabilities](domain/004-capabilities.md) already describes a compact Integration index, deferred Integration tool definitions, per-Integration `<slug>_list_tools`, and optional guides. Tool visibility remains subject to Agent reach and curation; tool calls pass execution-time approval checks. The proposal should extend these owners rather than create another discovery system.

## Proposed design

Separate three decisions:

1. **Effective authority:** existing Org, Member, Agent and task restrictions define the tools the worker may use. Tool discovery never widens this authority.
2. **Delegation:** the coordinator supplies the goal, context, constraints and optional starting hints. It does not have to predict an exhaustive list of Integration tools.
3. **Discovery during execution:** the worker explores the available Integration index, schemas and guides, and revisits discovery when results expose another dependency. A first search result is a starting point rather than a permanent whitelist.

A general worker can therefore discover across the Agent's authorized Integration catalog by default. Explicit task restrictions can narrow it. The coordinator's own direct tool access remains limited to workspace, conversation, memory and coordination operations; its inability to call an Integration directly does not imply that its workers must lack it.

When a required capability is outside effective authority, the worker reports the concrete blocker or follows the configured approval process. When it is merely undiscovered, it continues searching without involving the user. These are different failure conditions.

The synthesis is an architectural recommendation from retrieval evidence. The cited sources support dynamic discovery and warn about missing tools; they do not prove the best default permission envelope for Guild. Verification should include tasks whose required second Integration becomes apparent only after the first tool result, together with explicit restrictions that discovery cannot bypass.
