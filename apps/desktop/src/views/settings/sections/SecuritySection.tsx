//! SecuritySection — workspace security choices. Admin-only. Today: whether
//! remote images in agent content (Generated UI and chat markdown) load at
//! once, behind a click, or never. The value is the member socket's
//! workspace-identity frame: a write here comes back as a push, to this
//! pane and to every member's client, and the clients obey it.

import { useState } from "react";
import { toast } from "sonner";
import type { RemoteImagesPolicy } from "@guild/wire/types";
import { Skeleton } from "@guild/ui/components/skeleton";
import { PageHeader } from "../../../components/page-header";
import { ApiError } from "../../../lib/api/request";
import { putOrgRemoteImages } from "../../../lib/api/settings";
import { useWorkspaceIdentity } from "../../../lib/workspace-store";

const OPTIONS: { value: RemoteImagesPolicy; title: string; detail: string }[] = [
  {
    value: "auto",
    title: "Load automatically",
    detail: "Remote images in agent replies show as soon as they arrive.",
  },
  {
    value: "click",
    title: "Load on click",
    detail: "A remote image shows as a placeholder with its domain until the reader clicks it.",
  },
  {
    value: "never",
    title: "Never load",
    detail: "Remote images show only their description and domain.",
  },
];

export default function SecuritySection() {
  const identity = useWorkspaceIdentity();
  const current = identity === null ? null : (identity.remote_images ?? "auto");
  const [saving, setSaving] = useState<RemoteImagesPolicy | null>(null);

  const choose = async (policy: RemoteImagesPolicy) => {
    if (policy === current || saving !== null) return;
    setSaving(policy);
    try {
      await putOrgRemoteImages(policy);
      toast.success("Remote image setting saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Security" description="Workspace-wide choices about what agent content may do." />
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Remote images</h3>
          <p className="text-xs text-muted-foreground">
            Images an agent links from the web (in replies and Generated UI). Loading one sends a request to the server
            that hosts it, and that server sees the full URL. Content the agent read (a web page, an email, a document)
            can steer it into writing an image URL that carries data out, so loading remote images on their own is a
            trade-off. Files the agent sends with send_file and inline images always show.
          </p>
        </div>
        {current === null ? (
          <Skeleton className="h-36 w-full rounded-lg" />
        ) : (
          <div role="radiogroup" aria-label="Remote images" className="space-y-1.5">
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2"
              >
                <input
                  type="radio"
                  name="remote-images"
                  className="mt-0.5 size-4 accent-foreground"
                  checked={(saving ?? current) === o.value}
                  disabled={saving !== null}
                  onChange={() => void choose(o.value)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{o.title}</span>
                  <span className="block text-xs text-muted-foreground">{o.detail}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
