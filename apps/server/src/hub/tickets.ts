// Single-use, short-TTL connect tickets (TicketStore): tickets are
// worthless after a restart, so they live in
// memory only; clients mint a fresh one on every connect. Format and TTL
// must stay byte-compatible with shipped daemons: `gst_<uuid-v7-simple>`.

import { uuidv7 } from "../platform/time.js";
import type { UserRow } from "../platform/store/identity.js";

export const TICKET_TTL_MS = 30_000;

export interface TicketIdentity {
  user: UserRow;
  session_hash: string;
  expires_at: Date;
}

interface StoredTicket extends TicketIdentity {
  at: number;
}

export class TicketStore {
  private tickets = new Map<string, StoredTicket>();

  mint(identity: TicketIdentity): string {
    this.retain();
    const ticket = `gst_${uuidv7().replaceAll("-", "")}`;
    this.tickets.set(ticket, { ...identity, at: Date.now() });
    return ticket;
  }

  consume(ticket: string): TicketIdentity | null {
    const stored = this.tickets.get(ticket);
    if (!stored) return null;
    this.tickets.delete(ticket);
    if (Date.now() - stored.at >= TICKET_TTL_MS) return null;
    const { at: _at, ...identity } = stored;
    return identity;
  }

  private retain(): void {
    const cutoff = Date.now() - TICKET_TTL_MS;
    for (const [key, stored] of this.tickets) {
      if (stored.at < cutoff) this.tickets.delete(key);
    }
  }
}
