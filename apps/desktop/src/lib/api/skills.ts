// The org-skills HTTP surface the client-side context assembly consumes
// (spec §2.3), and the turn preparation built on it.

import { IS_TAURI, apiUrl, getToken } from "../session";
import { rpcCall } from "../machine-rpc";
import { browserFs, daemonFs } from "../fs-bridge";
import type { OrgSkillsApi } from "../skills";
import { prepareTurn as assembleTurn } from "../turn-context";

function orgSkillsApi(): OrgSkillsApi {
  const get = async (path: string): Promise<unknown | null> => {
    const token = getToken();
    if (token === null) return null; // not signed in — no org installs
    try {
      const res = await fetch(apiUrl(path), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  };
  return {
    installs: async () => {
      const v = (await get("/api/v1/skills/installs")) as { installs?: unknown } | null;
      const rows = Array.isArray(v?.installs) ? v!.installs : [];
      return rows.filter(
        (r): r is { slug: string; pinned_version: string | null } =>
          typeof (r as any)?.slug === "string" &&
          ((r as any)?.pinned_version == null || typeof (r as any)?.pinned_version === "string"),
      );
    },
    skillBody: async (slug, version) => {
      const q = typeof version === "string" && version !== "" ? `?version=${encodeURIComponent(version)}` : "";
      const v = (await get(`/api/v1/skills/${encodeURIComponent(slug)}/source${q}`)) as
        | { skill_md?: unknown }
        | null;
      return typeof v?.skill_md === "string" ? v.skill_md : null;
    },
  };
}
export { orgSkillsApi };

/// Expands `/name` skill mentions in a turn prompt against the local skill
/// discovery, renders the skills index, and assembles the AGENTS.md
/// instructions (global config-dir file + the bound project's chain, Codex
/// semantics) — app-process RPC; browser mode has no local files and passes
/// the prompt through untouched.
export async function prepareTurn(
  prompt: string,
  projectDir?: string,
): Promise<{ prompt: string; index: string; instructions?: string }> {
  // Context assembly moved to the client (lib/context.ts) over the fs
  // bridge; browser mode has no local files and passes through untouched.
  const fs = IS_TAURI ? daemonFs(rpcCall) : browserFs;
  const scopes = await fs.scopes();
  return assembleTurn(fs, scopes, prompt, projectDir, orgSkillsApi());
}

/// In-flight mirror catch-up from the app process (single-process spec):
/// everything the fan-out bus delivered for this chat so far. `seq` is the
/// watermark — frames with seq ≤ it are already reflected in the frames.
