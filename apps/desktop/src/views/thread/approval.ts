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

export const APPROVAL_MODE_LABELS = Object.fromEntries(
  Object.entries(APPROVAL_MODES).map(([mode, entry]) => [mode, entry.label]),
) as Record<ChatApprovalMode, string>;

/// Label for an unset chat (the account default applies). The server treats
/// no stored account policy as the AI judge (approve_for_me); an explicit
/// Settings default maps onto the matching mode label.
export function accountDefaultLabel(p: ApprovalPolicy | null): string {
  if (p?.default === "ask") return APPROVAL_MODE_LABELS.ask;
  if (p?.default === "allow") return APPROVAL_MODE_LABELS.full_access;
  if (p?.default === "never") return "Deny all";
  return APPROVAL_MODE_LABELS.approve_for_me;
}
