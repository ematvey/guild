// The signed-in member's own account (role, name, avatar, onboarding flag).
// The member socket pushes it on connect and whenever an admin or the
// member changes it; the login and me responses only seed it.

import type { UserInfo } from "@guild/wire/rest";
import { createStore } from "./store";

const profile = createStore<UserInfo | null>(null);

/** The pushed profile, or null until the first push. */
export const useMemberProfile = (): UserInfo | null => profile.use();

/** Replaces the profile (the `member_profile` frame). */
export function applyMemberProfile(next: UserInfo): void {
  profile.set(next);
}
