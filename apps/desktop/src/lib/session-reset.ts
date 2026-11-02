// What sign-out clears: every module-level cache of one session's data
// registers its reset here, and sign-out runs them all, so one user's
// state never leaks into the next session on the same browser profile.

const resets = new Set<() => void>();

/** Registers one cache's reset with sign-out. */
export function registerSessionReset(reset: () => void): void {
  resets.add(reset);
}

/** Runs every registered reset; sign-out calls it once. */
export function resetSessionState(): void {
  for (const reset of resets) reset();
}
