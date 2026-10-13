// Skills API (GET /api/v1/skills) for the Skills panel.

import { apiUrl, getToken } from "../../transport";
import type { SkillItem } from "./SkillsPanel";

/** The org skill catalog; null on any failure (the panel shows its empty
 *  state). `q` narrows server-side; the panel filters client-side too. */
export async function skillsList(q?: string): Promise<SkillItem[] | null> {
  const path = q === undefined ? "/api/v1/skills" : `/api/v1/skills?q=${encodeURIComponent(q)}`;
  const res = await fetch(apiUrl(path), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as { items?: SkillItem[] } | null;
  return v?.items ?? null;
}
