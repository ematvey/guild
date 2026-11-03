// Activity-driven IdP revalidation. A login proves the account exists at the
// IdP; nothing after it does. So an OIDC user's stored refresh token is
// replayed against the org's token endpoint — at most once per interval, and
// only when the user is active. A refused replay (invalid_grant) means the
// account is suspended, deleted, or has revoked the app, so every credential
// of that user is revoked and the next request fails as unauthorized.
//
// The recheck never blocks the request that triggered it: it runs in the
// background and the revocation lands before the client's next call. A
// transport failure or an IdP 5xx is not evidence against the user, so it
// changes nothing and the next interval retries.

import { decryptSecret } from "./crypto.js";
import type { Config } from "../config.js";
import type { IdentityStore, UserRow } from "./store/identity.js";
import type { OidcStore } from "./store/oidc.js";

/** A refresh call that hangs must not hold a worker; the interval retries. */
const RECHECK_TIMEOUT_MS = 10_000;

export interface IdpRecheckDeps {
  readonly oidc: OidcStore;
  readonly identity: IdentityStore;
  readonly config: Pick<Config, "idpRecheckSeconds">;
  masterKey(): Buffer;
  log?(message: string): void;
}

/** True when the token endpoint refused the grant itself (as opposed to a
 *  transport or server failure): the IdP is saying the account is gone. */
function grantRefused(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error === "invalid_grant";
  } catch {
    // Not JSON — some IdPs answer form-encoded. Fall through.
  }
  return body.includes("invalid_grant");
}

export class IdpRecheck {
  /** Per-user next-attempt time, so a request burst costs one memory read
   *  and the store's claim is touched at most once per interval. */
  private readonly nextAttempt = new Map<string, number>();

  constructor(private readonly deps: IdpRecheckDeps) {}

  /** Notes that the user is active. Cheap and non-blocking: it only
   *  schedules a recheck when the interval has passed. */
  noteActivity(user: UserRow): void {
    const interval = this.deps.config.idpRecheckSeconds;
    if (interval <= 0 || user.identity_type !== "oidc") return;
    const now = Date.now();
    const due = this.nextAttempt.get(user.id);
    if (due !== undefined && due > now) return;
    this.nextAttempt.set(user.id, now + interval * 1000);
    void this.check(user).catch((error: unknown) => {
      this.deps.log?.(`idp recheck failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** One recheck, subject to the interval claim. Public so tests can drive
   *  it without a request. */
  async check(user: UserRow): Promise<void> {
    const interval = this.deps.config.idpRecheckSeconds;
    if (interval <= 0 || user.identity_type !== "oidc") return;
    const link = await this.deps.oidc.identity(user.id);
    if (link === null) return;
    const org = await this.deps.oidc.get(user.org_id);
    if (org === null) return;
    if (!(await this.deps.oidc.claimRecheck(user.id, interval))) return;

    const key = this.deps.masterKey();
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(key, link.encrypted_refresh_token),
      client_id: org.client_id,
      client_secret: decryptSecret(key, org.encrypted_client_secret),
    });
    let res: Response;
    try {
      res = await fetch(link.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(RECHECK_TIMEOUT_MS),
      });
    } catch (error) {
      this.deps.log?.(
        `idp recheck unreachable for ${user.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (res.ok) return;
    const text = await res.text().catch(() => "");
    if (!grantRefused(text)) {
      this.deps.log?.(`idp recheck for ${user.email} failed: ${res.status} ${text.slice(0, 200)}`);
      return;
    }
    await this.deps.identity.revokeAllCredentials(user.id);
    this.nextAttempt.delete(user.id);
    this.deps.log?.(`idp recheck: the identity provider no longer accepts ${user.email}; credentials revoked`);
  }
}
