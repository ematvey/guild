// The child thread header: the way back to the parent chat, the child's
// session name and its agent. A plain chat renders none of this.

import { ArrowLeft } from "lucide-react";
import type { ChatTree } from "../../transport";

export function ChildThreadHeader({
  tree,
  onBack,
}: {
  tree: ChatTree | null;
  onBack: (chatId: string) => void;
}) {
  const parent = tree?.parent ?? null;
  if (!tree || !parent) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        onClick={() => onBack(parent.chat_id)}
        aria-label={`Back to ${parent.title}`}
        title={`Back to ${parent.title}`}
        className="flex min-w-0 shrink-0 items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5 shrink-0" />
        <span className="max-w-40 truncate">{parent.title}</span>
      </button>
      <span className="min-w-0 truncate font-medium">{tree.title}</span>
      {tree.agent_name && (
        <span className="max-w-40 shrink-0 truncate text-2xs text-muted-foreground">{tree.agent_name}</span>
      )}
    </div>
  );
}
