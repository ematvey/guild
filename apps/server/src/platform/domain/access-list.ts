// The access wire contract (docs/domain/002-access.md, "Access"): one list
// per item of who may reach it and how. `read` sees and uses the item; `edit`
// manages it. The org entry is always `read`, because sharing with everyone
// never hands out management.

import { ApiError } from "../errors.js";
import { isUuid } from "../time.js";
import type {
  AccessInput,
  AccessKind,
  AccessLevel,
  AccessSubjectKind,
} from "../store/access.js";

const KINDS = new Set<AccessKind>(["agent", "app"]);
const SUBJECTS = new Set<AccessSubjectKind>(["org", "team", "user"]);
const LEVELS = new Set<AccessLevel>(["read", "edit"]);

export function parseAccessKind(value: string | undefined): AccessKind {
  if (value === undefined || !KINDS.has(value as AccessKind)) {
    throw ApiError.badRequest("kind must be agent or app");
  }
  return value as AccessKind;
}

/** The `entries` body of a PUT: every entry checked before any is written. */
export function parseAccessInput(body: unknown): AccessInput[] {
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries))
    throw ApiError.badRequest("entries must be an array");
  return entries.map((raw): AccessInput => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const subjectKind = entry["subject_kind"];
    const level = entry["level"];
    if (
      typeof subjectKind !== "string" ||
      !SUBJECTS.has(subjectKind as AccessSubjectKind)
    ) {
      throw ApiError.badRequest("subject_kind must be org, team or user");
    }
    if (typeof level !== "string" || !LEVELS.has(level as AccessLevel)) {
      throw ApiError.badRequest("level must be read or edit");
    }
    if (subjectKind === "org") {
      if (level !== "read")
        throw ApiError.badRequest("everyone in the org may read, not edit");
      return { subject_kind: "org", subject_id: null, level: "read" };
    }
    const subjectId = entry["subject_id"];
    if (typeof subjectId !== "string" || !isUuid(subjectId)) {
      throw ApiError.badRequest(`${subjectKind} entries need a subject_id`);
    }
    return {
      subject_kind: subjectKind as "team" | "user",
      subject_id: subjectId,
      level: level as AccessLevel,
    };
  });
}
