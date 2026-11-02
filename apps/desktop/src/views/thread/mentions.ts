// The composer's `/` autocomplete: built-in commands plus the skill pool.
// Pure for tests.

/// One row of the composer's /-autocomplete pool: a builtin command, a
/// local skill, or an installed org skill (spec §2.3 — uninstalled org
/// skills are the agent's discovery surface and never mentionable).
export interface ComposerSkill {
  name: string;
  description: string;
  disabled: boolean;
  /** true for an installed org skill (from the installs endpoint). */
  org?: boolean;
}

/// The composer's skill pool (spec §2.3): the local rows plus the
/// installed org skills; a slug the local list already holds folds into
/// its local row. Pure for tests.
export function composerSkills(
  local: ComposerSkill[] | null,
  installs: Array<{ slug: string; pinned_version?: string | null }> | null,
): ComposerSkill[] {
  const out = [...(local ?? [])];
  const names = new Set(out.map((s) => s.name));
  for (const install of installs ?? []) {
    if (names.has(install.slug)) continue;
    out.push({ name: install.slug, description: "", disabled: false, org: true });
  }
  return out;
}

/// Built-in composer commands — shown in the `/` autocomplete ahead of
/// skills, with a help comment each.
export const BUILTIN_COMMANDS: { name: string; description: string }[] = [
  {
    name: "compact",
    description: "Compact this thread — summarize older messages to free context",
  },
];

/// Events per older-page fetch when the reader scrolls to the top. Matches
/// the server's ThreadState tail window, so one page doubles the view.
export const EARLIER_PAGE_SIZE = 120;

/// The `/` autocomplete pool: built-in commands first, then enabled skills;
/// prefix-matched on the typed fragment. Pure for tests.
export function mentionCandidates(
  builtins: { name: string; description: string }[],
  skills: ComposerSkill[] | null,
  query: string,
): { name: string; description: string; builtin: boolean; org: boolean }[] {
  const pool: { name: string; description: string; builtin: boolean; org: boolean }[] = [
    ...builtins.map((c) => ({ ...c, builtin: true, org: false })),
    ...(skills ?? [])
      .filter((s) => !s.disabled)
      .map((s) => ({ name: s.name, description: s.description, builtin: false, org: s.org === true })),
  ];
  return pool.filter((c) => query === "" || c.name.startsWith(query)).slice(0, 6);
}
