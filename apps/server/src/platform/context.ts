// Platform context: the per-process Postgres pool, object store, and typed
// store facades shared by the native route handlers.

import type { Config } from "../config.js";
import { createPlatformPool, type PlatformPool } from "./db.js";
import { ObjectStore } from "./s3.js";
import { IdentityStore } from "./store/identity.js";
import { PairingStore } from "./store/pairing.js";
import { EventStore } from "./store/events.js";
import { AttachmentStore } from "./store/attachments.js";
import { OrgStore } from "./store/orgs.js";
import { OidcStore } from "./store/oidc.js";

export class PlatformContext {
  readonly pool: PlatformPool;
  readonly objects: ObjectStore;
  readonly identity: IdentityStore;
  readonly pairing: PairingStore;
  readonly events: EventStore;
  readonly attachments: AttachmentStore;
  readonly orgs: OrgStore;
  readonly oidc: OidcStore;

  constructor(readonly config: Config) {
    this.pool = createPlatformPool(config.databaseUrl);
    this.objects = new ObjectStore(config);
    this.identity = new IdentityStore(this.pool);
    this.pairing = new PairingStore(this.pool);
    this.events = new EventStore(this.pool);
    this.attachments = new AttachmentStore(this.pool);
    this.orgs = new OrgStore(this.pool);
    this.oidc = new OidcStore(this.pool);
  }

  masterKey(): Buffer {
    const key = Buffer.from(this.config.masterKeyHex, "hex");
    if (key.length !== 32) throw new Error("GUILD_MASTER_KEY_HEX must decode to 32 bytes");
    return key;
  }

  async close(): Promise<void> {
    this.objects.destroy();
    await this.pool.end();
  }
}
