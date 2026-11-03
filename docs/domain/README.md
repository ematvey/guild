# Guild domain

What Guild is made of and the rules it keeps. Read the numbered documents in order; each builds only on the ones before it and links only to them.

| Document | Covers |
| --- | --- |
| [000 Principles](000-principles.md) | What Guild is for, and what that asks of the product and the design |
| [001 Domain model](001-domain.md) | The concepts, the rules each keeps, what was rejected, and the glossary |
| [002 Access](002-access.md) | Who may see and do what, and who a Run acts for |
| [003 Execution](003-execution.md) | How a Turn runs, where its Tools run, the agent tree, Routines, and recovery |
| [004 Capabilities](004-capabilities.md) | Models, Tools, Integrations and Skills: what an Agent can use |
| [005 Live state](005-live-state.md) | How state reaches clients: the member socket, frames, push and addresses |

The documents describe the code as it is. A change to a concept or a rule updates the document in the same commit; `PLAN.md` records why it changed. Terms follow the glossary in 001; the coherence model (`scripts/coherence/models/`) maps each concept to its places in the code.
