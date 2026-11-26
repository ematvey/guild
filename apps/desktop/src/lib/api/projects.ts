// Projects: a named folder bound to a machine (spec §1/§2).

import type { CreateProjectRequest, Project, UpdateProjectRequest } from "@guild/wire/rest";

import { request } from "./request";

// ---- Projects (spec §1/§2: a named folder bound to a machine) ----

export type { Project, CreateProjectRequest };

/** The signed-in user's projects (admin: all org projects). */
export async function listProjects(): Promise<Project[] | null> {
  try {
    const v = await request<{ projects?: Project[] }>("GET", "/api/v1/projects");
    return v?.projects ?? [];
  } catch {
    // null = the list could not be read (distinct from an empty list).
    return null;
  }
}

/** Creates a project; throws with the API message (409 = name taken). */
export function createProject(req: CreateProjectRequest): Promise<Project> {
  return request<Project>("POST", "/api/v1/projects", req);
}

/** Renames/re-binds a project (PUT /projects/{id}). */
export function updateProject(id: string, patch: UpdateProjectRequest): Promise<Project> {
  return request<Project>("PUT", `/api/v1/projects/${encodeURIComponent(id)}`, patch);
}
