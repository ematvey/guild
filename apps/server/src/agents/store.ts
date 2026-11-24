// AgentStore: the agent lane's data access over one platform pool. The
// agent rows and the authorization check are its own methods (AgentCatalog);
// the thread index, the delegation tree, runs, the inbox, the deletion
// lifecycle and the bulk visibility reads are its sub-stores. Transcripts
// live in the chat journal; every agent thread owns one chats row
// (agent_threads.chat_id).

import type { PlatformPool } from "../platform/db.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { TraceStore } from "../platform/trace.js";
import { AccessStore } from "../platform/store/access.js";
import { AgentGrants } from "./store/access.js";
import { AgentCatalog } from "./store/catalog.js";
import { AgentLifecycleStore } from "./store/lifecycle.js";
import { AgentNoticeStore } from "./store/notices.js";
import { AgentRunStore } from "./store/runs.js";
import { AgentTreeStore } from "./store/subtree.js";
import { AgentThreadStore } from "./store/threads.js";
import { agentWorkspaceDir, seedAgentWorkspace } from "./workspace-config.js";

export { AgentGrants } from "./store/access.js";
export {
  DEFAULT_AGENT_RESOURCES,
  type AgentListOptions,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "./store/catalog.js";
export { refuseDeletingAgent, AgentLifecycleStore } from "./store/lifecycle.js";
export { AgentNoticeStore, type CreateNoticeInput } from "./store/notices.js";
export {
  AgentRunStore,
  type ActivityFilters,
  type CreateRunInput,
  type RunFilters,
  type RunTraceContext,
  type UpdateRunInput,
} from "./store/runs.js";
export { AgentTreeStore, type ChildThreadSummary } from "./store/subtree.js";
export {
  AgentThreadStore,
  ChildLimitReached,
  deriveTitleFromMessage,
  MAX_THREAD_PAGE,
  type ListedThread,
  type ThreadListOptions,
  type ThreadPage,
  type ThreadSort,
  wireThread,
} from "./store/threads.js";

export interface AgentStoreDeps {
  pool: PlatformPool;
  /** The chat journal rows agent threads own. */
  chats: Pick<ChatStore, "createChatOn">;
  /** Mirrors run lifecycle rows into ClickHouse (agent_traces). */
  trace?: TraceStore;
  /** The server-writable workspace root; absent: no config files seeded. */
  workspaceRoot?: string;
}

export class AgentStore extends AgentCatalog {
  /** Visibility and grant reads beyond the single-agent check. */
  readonly grants: AgentGrants;
  readonly threads: AgentThreadStore;
  readonly tree: AgentTreeStore;
  readonly runs: AgentRunStore;
  readonly notices: AgentNoticeStore;
  readonly lifecycle: AgentLifecycleStore;

  constructor(deps: AgentStoreDeps) {
    const grants = new AgentGrants(deps.pool, new AccessStore(deps.pool));
    const root = deps.workspaceRoot;
    super(
      deps.pool,
      deps.chats,
      grants,
      root === undefined
        ? undefined
        : (agent) =>
            seedAgentWorkspace(agentWorkspaceDir(root, agent.org_id, agent.id)),
    );
    this.grants = grants;
    this.threads = new AgentThreadStore(deps.pool, deps.chats, (agentId) =>
      this.fetchAgent(agentId),
    );
    this.tree = new AgentTreeStore(deps.pool);
    this.runs = new AgentRunStore(deps.pool, deps.trace);
    this.notices = new AgentNoticeStore(deps.pool);
    this.lifecycle = new AgentLifecycleStore(
      deps.pool,
      this,
      this.threads,
      this.runs,
    );
  }
}
