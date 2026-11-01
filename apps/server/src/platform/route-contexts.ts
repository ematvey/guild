// Narrow route contexts: the slices route registration hands to each route
// group. PlatformContext (the composition root, built once in app.ts)
// satisfies every slice structurally; a route file typed to a slice can
// reach only that slice's collaborators, so layering is enforced by the
// compiler instead of convention.
//
//   Infra      — process-level infrastructure, frozen and shared by reference
//   IdentityCtx — identity/org/auth-facing stores plus what auth needs
//   ChatsCtx   — the chat/thread/hub world (stores, runtime, live hub, seams)
//   GatewayCtx — the gateway/registry/integration stores + LLM credential wiring
//
// A store used by exactly one group lives only in that group; a store used
// across groups attaches to the group it belongs to and the other groups
// receive it as an explicit parameter, never as a wider context.

import type { Config } from "../config.js";
import type { PlatformPool } from "./db.js";
import type { ObjectStore } from "./s3.js";
import type { ClickhouseClient } from "./clickhouse.js";
import type { UsageSink } from "./usage.js";
import type { TraceStore } from "./trace.js";
import type { UserRow } from "./store/identity.js";
import type { IdentityStore } from "./store/identity.js";
import type { PairingStore } from "./store/pairing.js";
import type { EventStore } from "./store/events.js";
import type { AttachmentStore } from "./store/attachments.js";
import type { OrgStore } from "./store/orgs.js";
import type { OidcStore } from "./store/oidc.js";
import type { ApiKeyStore } from "./store/api_keys.js";
import type { MachineStore } from "./store/machines.js";
import type { SkillReadSink } from "./skillReads.js";
import type { RegistryStore } from "./store/registry.js";
import type { ReleaseStore } from "./store/releases.js";
import type { ProjectStore } from "./store/projects.js";
import type { TeamStore } from "./store/teams.js";
import type { OrgKvStore, KvStore } from "./store/org_kv.js";
import type { PushStore } from "./store/push.js";
import type { VapidKeys } from "../push/vapid.js";
import type { IntegrationStore, IntegrationSecretStore } from "./store/integrations.js";
import type { UserMcpStore } from "./store/userMcp.js";
import type { ChatStore } from "./store/chats.js";
import type { ThreadStore } from "./store/thread.js";
import type { TurnCommandStore } from "./store/turn_commands.js";
import type { ToolArtifactStore } from "./store/toolArtifacts.js";
import type { LiveHub, LiveMember } from "../hub/live.js";
import type { TicketStore } from "../hub/tickets.js";
import type { SocketSink } from "../hub/sink.js";
import type { WsServerMsg } from "../hub/protocol.js";
import type { NotifyHub } from "./notify.js";
import type { GuildRuntime } from "../harness/runtime.js";
import type { FeedForwarder } from "../hub/feed.js";
import type { MachineDispatch } from "../machines/dispatch.js";
import type { GatewayContext, GatewayCredential } from "./llm-gateway.js";

/** Process-level infrastructure (pool, object store, ClickHouse, usage
 *  sink). Frozen: shared by reference, never rebuilt. */
export interface InfraContext {
  readonly pool: PlatformPool;
  readonly config: Config;
  readonly objects: ObjectStore;
  readonly clickhouse: ClickhouseClient;
  readonly usage: UsageSink;
  readonly trace: TraceStore;
  masterKey(): Buffer;
}

/** Identity and org administration (auth, users, orgs, OIDC, API keys,
 *  pairing, teams, KV) plus what auth needs: the config (JWT secrets,
 *  URLs), the master key, the org event store, and the attachment store. */
export interface IdentityCtx {
  readonly identity: IdentityStore;
  readonly orgs: OrgStore;
  readonly oidc: OidcStore;
  readonly apiKeys: ApiKeyStore;
  readonly pairing: PairingStore;
  readonly teams: TeamStore;
  readonly orgKv: OrgKvStore;
  readonly kv: KvStore;
  readonly events: EventStore;
  /** User-owned MCP server rows (the user_mcp settings surface + runtime). */
  readonly userMcp: UserMcpStore;
  readonly attachments: AttachmentStore;
  /** Web Push device registry (the notifications settings surface). */
  readonly push: PushStore;
  readonly config: Config;
  masterKey(): Buffer;
  /** The server's VAPID pair, minted on first use. */
  pushKeys(): Promise<VapidKeys>;
}

/** The chats lane: chat/thread stores, the turn-command journal, the agent
 *  runtime, the live hub (member/machine sockets), the notify fan-in, the
 *  feed forwarder, the machine registry and its tool dispatch, and the
 *  socket seams the lanes wire at startup. */
export interface ChatsCtx {
  readonly chats: ChatStore;
  readonly threads: ThreadStore;
  readonly turnCommands: TurnCommandStore;
  readonly runtime: GuildRuntime;
  readonly hub: LiveHub;
  readonly notify: NotifyHub;
  readonly feed: FeedForwarder;
  readonly toolArtifacts: ToolArtifactStore;
  readonly machineDispatch: MachineDispatch;
  readonly machines: MachineStore;
  readonly wsTickets: TicketStore;
  /** The chats lane's state-sync capture, called inside the socket reader's
   *  sync bracket (SyncBegin … SyncDone). */
  wsSync?: (args: { chatId: string; user: UserRow; sink: SocketSink }) => Promise<WsServerMsg | null>;
  /** The chat's thread subtree, sent inside the same sync bracket so a
   *  (re)connect never waits for a poll to show the running tree. */
  wsSubagentTree?: (args: { chatId: string; user: UserRow; sink: SocketSink }) => Promise<WsServerMsg | null>;
  /** The dispatch lane's tool-result completion (owns_pending_tool + turn
   *  completion). */
  wsToolResult?: (args: { member: LiveMember; user: UserRow; frame: { type: "tool_result"; chat_id: string; call_id: string; content: string; is_error: boolean; meta: unknown; images: string[] } }) => Promise<void>;
  /** The dispatch lane's uncertain-execution sweep at machine connect. */
  wsMachineReconcile?: (machineId: string, connId: string) => Promise<void>;
  /** Trace sink for the socket supervisor (the server log). */
  wsLog?: (message: string) => void;
}

/** The gateway/registry lane: the provider route table, the registry and
 *  release stores, projects, and the integration stores — plus
 *  the LLM pipeline's needs (master key, usage sink, and the credential
 *  extractor the /openai and /anthropic surfaces meter against). */
export interface GatewayCtx extends GatewayContext {
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  readonly registry: RegistryStore;
  readonly releases: ReleaseStore;
  readonly projects: ProjectStore;
  /** The ClickHouse skill-read sink: spec §3's detail-page usage stats
   *  (read analytics; writes ride the read_skill tool). */
  readonly skillReads: SkillReadSink;
  /** Resolves a gateway bearer token (gk_… key or the config-minted
   *  internal key) to the credential the LLM gateway endpoints meter
   *  against. */
  gatewayCredential(req: { headers: Record<string, unknown> }): Promise<GatewayCredential>;
}
