// Status wording and tone for a child thread's header.

export type ChildStatusTone = "running" | "success" | "danger" | "muted";

export function childStatusTone(status: string): ChildStatusTone {
  if (status === "running" || status === "queued") return "running";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "muted";
}

export function childStatusLabel(status: string): string {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "silent") return "Silent";
  if (status === "skipped") return "Skipped";
  if (status === "closed") return "Closed";
  return status;
}
