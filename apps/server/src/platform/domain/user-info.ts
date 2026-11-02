// The signed-in account as the wire carries it: the login, me and pairing
// responses and the pushed `member_profile` frame.

import type { UserInfo } from "@guild/wire/rest";
import type { UserRow } from "../store/identity.js";

export function userInfo(u: UserRow): UserInfo {
  return {
    id: u.id,
    email: u.email,
    org_id: u.org_id,
    role: u.role,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    onboarded: u.onboarded_at != null,
  };
}
