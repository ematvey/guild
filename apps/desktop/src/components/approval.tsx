import { useState } from "react";
import { Button } from "./button";

export function ApprovalModal({
  tool,
  args,
  onDecide,
}: {
  tool: string;
  args: string;
  onDecide: (approve: boolean, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <h3 className="text-sm font-semibold">Allow {tool}?</h3>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-300">
          {args}
        </pre>
        <input
          className="mt-3 h-9 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 text-sm"
          placeholder="Reason (if denying)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onDecide(false, reason || "denied")}>
            Deny
          </Button>
          <Button onClick={() => onDecide(true, "")}>Approve</Button>
        </div>
      </div>
    </div>
  );
}
