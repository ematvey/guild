// Projects: a named folder bound to a machine (spec §1/§2).

import type { Project } from "../../../../../crates/protocol/bindings/Project";
import type { CreateProjectRequest } from "../../../../../crates/protocol/bindings/CreateProjectRequest";

import { apiUrl, getToken } from "../session";

// ---- Projects (spec §1/§2: a named folder bound to a machine) ----

export type { Project, CreateProjectRequest };

/** The signed-in user's projects (admin: all org projects). */
export async function listProjects(): Promise<Project[] | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/projects"), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.projects ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


/** Lists the caller's archived projects (the sidebar's Archived section).
 *  Null on failure, same contract as `listProjects`. */
export async function listArchivedProjects(): Promise<Project[] | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/projects?archived=1"), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v.projects ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}


/** Creates a project; throws with the API message (409 = name taken). */
export async function createProject(req: CreateProjectRequest): Promise<Project> {
  const res = await fetch(apiUrl("/api/v1/projects"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(req),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return v as Project;
}

/** Renames/re-binds a project (PUT /projects/{id}); no UI surface yet. */
export async function updateProject(
  id: string,
  patch: { name?: string; folder?: string; machine_id?: string; archived?: boolean },
): Promise<Project> {
  const res = await fetch(apiUrl(`/api/v1/projects/${id}`), {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(patch),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return v as Project;
}

