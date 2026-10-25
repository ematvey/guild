// The composer's approval-mode selector (per chat, migration 0043). The
// mode sets the chat's tool-approval DEFAULT; per-tool exceptions from
// Settings apply only while the chat is on the account default.
import { Hand, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ApprovalPolicy, ChatApprovalMode } from "../../lib/api/approvals";

export const APPROVAL_MODES: Record<
  ChatApprovalMode,
  { label: string; hint: string; icon: LucideIcon; iconCls?: string }
> = {
  ask: {
    label: "Ask for approval",
    hint: "Ask before any potentially unsafe actions.",
    icon: Hand,
  },
  approve_for_me: {
    label: "Approve for me",
    hint: "Let a separate AI determine if an action is potentially unsafe",
    icon: ShieldCheck,
  },
  full_access: {
    label: "Full access",
    hint: "Unrestricted, except for organization policy overrides.",
    icon: TriangleAlert,
    iconCls: "text-orange-500",
  },
};

/** The one policy→chat mapping. The account policy and the chat mode are
 *  separate vocabularies: an unset policy is the AI judge, "never" has no
 *  chat equivalent (deny-all is policy-only), and "allow" is full access. */
export function policyChatMode(p: ApprovalPolicy | null): ChatApprovalMode | null {
  if (p?.default === "ask") return "ask";
  if (p?.default === "allow") return "full_access";
  if (p?.default === "never") return null;
  return "approve_for_me";
}

/// Label for an unset chat (the account default applies). "Deny all" is an
/// account policy with no chat mode, so it keeps its own label.
export function accountDefaultLabel(p: ApprovalPolicy | null): string {
  if (p?.default === "never") return "Deny all";
  const mode = policyChatMode(p) ?? "approve_for_me";
  return APPROVAL_MODES[mode].label;
}
