// Skills/registry surfaces resolve against one project folder — the
// project of the most recent chat, else the first project. With the
// per-chat folder mechanism gone (projects design §5) this is the closest
// "the folder the user works in" rule.

import { listChats } from "../../lib/api/chats";
import { listProjects } from "../../lib/api/projects";

export async function resolveProjectDir(): Promise<string | null> {
  const projects = await listProjects();
  if (!projects || projects.length === 0) return null;
  const chats = await listChats();
  const recent = chats?.find(
    (c) => c.project_id && projects.some((p) => p.id === c.project_id),
  );
  const chosen = recent
    ? projects.find((p) => p.id === recent.project_id)!
    : projects[0];
  return chosen.folder;
}
