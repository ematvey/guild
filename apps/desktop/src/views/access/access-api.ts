// The access REST calls: one item's list of who may reach it and how, and the
// org's people for the picker. Agents and Apps share them.

import { request } from "../../lib/api/request";
import type { AccessEntry, AccessList, AccessPerson } from "@guild/wire/rest";

/** The item kinds whose access list this panel edits. */
export type AccessKind = "agent" | "app";

const base = (kind: AccessKind, id: string) =>
  `/api/v1/access/${kind}/${encodeURIComponent(id)}`;

export const getAccess = (kind: AccessKind, id: string) =>
  request<AccessList>("GET", base(kind, id));

export const putAccess = (
  kind: AccessKind,
  id: string,
  entries: AccessEntry[],
) =>
  request<AccessList>("PUT", base(kind, id), {
    entries: entries.map((entry) => ({
      subject_kind: entry.subject_kind,
      subject_id: entry.subject_id,
      level: entry.level,
    })),
  });

export async function listAccessPeople(): Promise<AccessPerson[]> {
  const body = await request<{ people: AccessPerson[] }>(
    "GET",
    "/api/v1/access/people",
  );
  return body.people;
}
