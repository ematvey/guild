# Assistant memory and concurrent workers

This research note concerns the existing Agent Workspace and Thread concepts. [Domain](domain/001-domain.md) and [Execution](domain/003-execution.md) define their current rules. Design recommendations below are proposals, not implemented behavior. The note introduces no runtime concept, type or dependency.

## Current Guild behavior

An Agent has one Workspace. [Workspace resolution](../apps/server/src/agents/workspace.ts) keys its sandbox and directory by Org and Agent, not Thread. Two Threads using the same Agent therefore reach the same files. [Spawn](../apps/server/src/agents/subagents.ts) creates a child Thread in the parent Agent’s Workspace. The worker shares that Agent’s permissions and has its own transcript.

[Workspace configuration](../apps/server/src/agents/workspace-config.ts) reads `AGENTS.md` and `MEMORY.md` from that directory, and [Turn tool composition](../apps/server/src/harness/turn-tools.ts) loads them for the Thread’s Agent. File and shell tools can write the Workspace when allowed. A worker is not inherently restricted to read-only memory.

The [conflict journal](../apps/server/src/agents/conflict.ts) records observed writes and warns overlapping concurrent Turns to re-read. Its hook never blocks a write, and shell-path detection is best-effort. It is a coordination aid, not locking, isolated copies, compare-and-swap or prevention of lost updates. Sharing a directory does not establish safe concurrent editing.

## Primary-source comparisons

- **Dot:** [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory.md) says delegated tasks have their own conversations and receive selected instructions and context. Background agents report findings to Dot, which maintains saved notes. This establishes separate task context and report-based coordination, not whether workers can directly mutate a common memory filesystem. The public page does not specify that concurrency mechanism.
- **DeepSeek:** [Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md) gives each Ticket an Executor Session and directory, with a prepare command that can create a worktree. A retry reuses the Ticket's Session and directory. This is task-local working state; the document does not establish a shared semantic-memory consolidation design. Directory defaults are also not an OS security boundary.
- **Letta:** [MemFS](https://docs.letta.com/concepts/memfs) is an Agent-owned Git-backed memory repository. Memory subagents use worktrees for concurrent updates. The [context-repositories article](https://www.letta.com/blog/context-repositories/) describes isolated worktrees whose changes merge back through Git conflict resolution. [Shared memory](https://docs.letta.com/concepts/shared-memory) likewise describes separate checkouts with commit, push and pull. The current [memory repair subagent](https://raw.githubusercontent.com/letta-ai/letta-code/main/src/agent/subagents/builtin/memory.md) has filesystem write tools, but specifically repairs reported Git conflicts or invalid committed trees and commits without pushing. It is not evidence that every general worker freely edits the live main checkout.

## Proposed direction

Separate the ability to write files from the ownership of durable memory. Workers need writable task state; the coordinator needs a coherent long-term record. Possible designs include worker reports consolidated by one writer, or concurrent isolated changes reconciled before publication. Letta demonstrates the latter mechanism; Dot's public behavior is compatible with report-based consolidation but does not confirm its internals.

The choice remains open. General workers sharing the coordinator's live `MEMORY.md` would inherit Guild's current write-conflict risks. A policy saying only the coordinator edits that file is advisory unless tools enforce it. A filesystem concurrency mechanism also cannot by itself reconcile contradictory facts or decisions; consolidation still needs context and provenance.
