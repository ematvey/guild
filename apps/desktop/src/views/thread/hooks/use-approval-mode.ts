// The composer's per-chat approval mode and the account default label.
import { useEffect, useState, type RefObject } from "react";
import { toast } from "sonner";
import { getApproval, getChatApproval, setChatApproval, type ChatApprovalMode } from "../../../transport";
import { accountDefaultLabel } from "../approval";

export function useApprovalMode({
  chatId,
  justCreatedApprovalRef,
}: {
  chatId: string | null;
  justCreatedApprovalRef: RefObject<string | null>;
}) {
  // Per-chat approval mode (the composer's selector): "default" = the
  // account-level policy from Settings applies. Loaded on chat open,
  // written optimistically on pick.
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode | "default">("default");
  // The account-level approval default (Settings → Approvals), fetched once:
  // the label an unset chat shows on the selector trigger. The server
  // resolves the same value when the turn runs (unset policy = the AI
  // judge), so the label and the behavior stay in step.
  const [accountDefault, setAccountDefault] = useState<string>("Approve for me");
  useEffect(() => {
    let dead = false;
    void getApproval()
      .then((p) => {
        if (!dead) setAccountDefault(accountDefaultLabel(p));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, []);
  useEffect(() => {
    if (!chatId) {
      setApprovalMode("default");
      return;
    }
    if (justCreatedApprovalRef.current === chatId) {
      justCreatedApprovalRef.current = null;
      return;
    }
    let dead = false;
    void getChatApproval(chatId).then((m) => {
      if (!dead) setApprovalMode(m ?? "default");
    });
    return () => {
      dead = true;
    };
  }, [chatId]);
  const pickApprovalMode = (m: ChatApprovalMode | "default") => {
    const prev = approvalMode;
    setApprovalMode(m); // optimistic
    if (!chatId) return; // new thread: the pick applies when the send creates the chat
    void setChatApproval(chatId, m).catch(() => {
      setApprovalMode(prev);
      toast.error("Could not save approval mode");
    });
  };

  return { approvalMode, setApprovalMode, accountDefault, pickApprovalMode };
}
