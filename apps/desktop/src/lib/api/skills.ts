// The org-skills HTTP surface the client-side context assembly consumes
// (spec §2.3), and the turn preparation built on it.

import { HAS_ENGINE } from "../session";
import { rpcCall } from "../machine-rpc";
import { browserFs, daemonFs } from "../fs-bridge";
import type { OrgSkillsApi } from "../skills";
import { assembleTurnContext } from "../turn-context";
import { fetchInstalls, skillsSource } from "../../views/skills/skills-api";

function orgSkillsApi(): OrgSkillsApi {
  return {
    // The context assembly reads a failed request as "no org skills".
    installs: async () => {
      const rows = await fetchInstalls().catch(() => null);
      if (rows === null) return null;
      return rows.map((row) => ({
        slug: row.slug,
        pinned_version: row.pinned_version,
      }));
    },
    skillBody: async (slug, version) => {
      const source = await skillsSource(slug, version).catch(() => null);
      return source?.skill_md ?? null;
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
  // Context assembly lives in the client (lib/turn-context.ts) over the fs
  // bridge; browser mode has no local files and passes through untouched.
  const fs = HAS_ENGINE ? daemonFs(rpcCall) : browserFs;
  const scopes = await fs.scopes();
  return assembleTurnContext(fs, scopes, prompt, projectDir, orgSkillsApi());
}

/// In-flight mirror catch-up from the app process (single-process spec):
/// everything the fan-out bus delivered for this chat so far. `seq` is the
/// watermark — frames with seq ≤ it are already reflected in the frames.
