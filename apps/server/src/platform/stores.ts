// The typed store facades over one platform pool, built once per process:
// the server's composition root and each forked worker take their stores
// from here, so neither constructs a store of its own.

import type { PlatformPool } from "./db.js";
import { AccessStore } from "./store/access.js";
import { ApiKeyStore } from "./store/api-keys.js";
import { AppStore } from "./store/apps.js";
import { AttachmentStore } from "./store/attachments.js";
import { ChatStore } from "./store/chats.js";
import { ConversationHistoryStore } from "./store/conversation-history.js";
import { ConversationMapStore } from "./store/conversations.js";
import { EventStore } from "./store/events.js";
import { GatewayStore } from "./store/gateway.js";
import { IdentityStore } from "./store/identity.js";
import {
  IntegrationSecretStore,
  IntegrationStore,
} from "./store/integrations.js";
import { MachineStore } from "./store/machines.js";
import { OidcStore } from "./store/oidc.js";
import { KvStore, OrgKvStore } from "./store/org-kv.js";
import { OrgStore } from "./store/orgs.js";
import { PairingStore } from "./store/pairing.js";
import { ProjectStore } from "./store/projects.js";
import { PushStore } from "./store/push.js";
import { RegistryStore } from "./store/registry.js";
import { SkillStore } from "./store/skills.js";
import { TeamStore } from "./store/teams.js";
import { ThreadStore } from "./store/thread.js";
import { ToolArtifactStore } from "./store/tool-artifacts.js";
import { TurnCommandStore } from "./store/turn-commands.js";
import { UserMcpStore } from "./store/user-mcp.js";

export interface PlatformStores {
  readonly identity: IdentityStore;
  readonly pairing: PairingStore;
  readonly events: EventStore;
  readonly attachments: AttachmentStore;
  readonly orgs: OrgStore;
  readonly oidc: OidcStore;
  readonly apiKeys: ApiKeyStore;
  readonly gatewayStore: GatewayStore;
  readonly machines: MachineStore;
  /** Registry, projects, teams, admin settings, integration
   *  config rows. */
  readonly registry: RegistryStore;
  readonly skills: SkillStore;
  readonly projects: ProjectStore;
  readonly teams: TeamStore;
  readonly orgKv: OrgKvStore;
  readonly kv: KvStore;
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  /** User-owned MCP server rows (the user_mcp settings surface + runtime). */
  readonly userMcp: UserMcpStore;
  readonly push: PushStore;
  readonly chats: ChatStore;
  readonly threads: ThreadStore;
  readonly turnCommands: TurnCommandStore;
  /** The tool-artifact spill store. */
  readonly toolArtifacts: ToolArtifactStore;
  /** The chat ↔ durable-conversation mapping rows. */
  readonly conversations: ConversationMapStore;
  /** The conversation-history read model behind the Activity surface. */
  readonly conversationHistory: ConversationHistoryStore;
  /** Apps and their published versions. */
  readonly apps: AppStore;
  /** Who may reach an Agent or an App, and how. */
  readonly access: AccessStore;
}

export function createStores(pool: PlatformPool): PlatformStores {
  const events = new EventStore(pool);
  return {
    identity: new IdentityStore(pool, (orgId, kind, payload) =>
      events.emit(orgId, kind, payload),
    ),
    pairing: new PairingStore(pool),
    events,
    attachments: new AttachmentStore(pool),
    orgs: new OrgStore(pool),
    oidc: new OidcStore(pool),
    apiKeys: new ApiKeyStore(pool),
    gatewayStore: new GatewayStore(pool),
    machines: new MachineStore(pool),
    registry: new RegistryStore(pool),
    skills: new SkillStore(pool),
    projects: new ProjectStore(pool),
    teams: new TeamStore(pool),
    orgKv: new OrgKvStore(pool),
    kv: new KvStore(pool),
    integrations: new IntegrationStore(pool),
    integrationSecrets: new IntegrationSecretStore(pool),
    userMcp: new UserMcpStore(pool),
    push: new PushStore(pool),
    chats: new ChatStore(pool),
    threads: new ThreadStore(pool),
    turnCommands: new TurnCommandStore(pool),
    toolArtifacts: new ToolArtifactStore(pool),
    conversations: new ConversationMapStore(pool),
    conversationHistory: new ConversationHistoryStore(pool),
    apps: new AppStore(pool),
    access: new AccessStore(pool),
  };
}
