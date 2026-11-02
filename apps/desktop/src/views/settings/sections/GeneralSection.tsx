//! GeneralSection — workspace identity: display name, logo, and the
//! workspace telemetry switch. Admin-only (the section only appears for
//! admins). The values are the member socket's workspace-identity frame:
//! every write here comes back as a push, to this pane and to every other
//! member's client. Telemetry is the org's decision: members have no local
//! control, and the clients obey the pushed value.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Input } from "@guild/ui/components/input";
import { PageHeader } from "../../../components/page-header";
import { ApiError } from "../../../lib/api/request";
import { apiUrl, serverUrl } from "../../../lib/session";
import { deleteOrgLogo, putOrgName, putOrgTelemetry, uploadOrgLogo } from "../../../lib/api/settings";
import { useWorkspaceIdentity } from "../../../lib/workspace-store";

/** The name field after a push: it takes the pushed name unless the admin
 *  has edited away from the name shown before (`shownBefore`, null before
 *  the first push). */
export function followPushedName(current: string, shownBefore: string | null, pushed: string): string {
  return shownBefore === null || current === shownBefore ? pushed : current;
}

export default function GeneralSection() {
  const identity = useWorkspaceIdentity();
  const org =
    identity === null
      ? null
      : { name: identity.name, logo_url: identity.logo_url ?? null, telemetry: identity.telemetry };
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoTick, setLogoTick] = useState(0); // busts the img cache on change
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The field follows the pushed name until the admin edits it: a rename
  // from another client lands here unless a draft would be overwritten. The
  // updater compares against the name shown before this push, captured now:
  // React may run it after the ref has moved on.
  const pushedName = identity?.name ?? null;
  const shownNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (pushedName === null) return;
    const shownBefore = shownNameRef.current;
    shownNameRef.current = pushedName;
    setName((current) => followPushedName(current, shownBefore, pushedName));
  }, [pushedName]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await putOrgName(trimmed);
      toast.success("Workspace name saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      toast.error("Pick an image up to 2 MB (png, jpeg, webp, gif, svg)");
      return;
    }
    setBusy(true);
    try {
      await uploadOrgLogo(file);
      setLogoTick((t) => t + 1);
      toast.success("Logo updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleTelemetry = async () => {
    if (org === null) return;
    const next = !org.telemetry;
    setTelemetryBusy(true);
    try {
      await putOrgTelemetry(next);
      toast.success(next ? "Telemetry on for this workspace" : "Telemetry off for this workspace");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setTelemetryBusy(false);
    }
  };

  const removeLogo = async () => {
    setBusy(true);
    try {
      await deleteOrgLogo();
      toast.success("Logo removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="General" description="The workspace's name and logo, shown across the app." />
      <div className="flex items-center gap-5" aria-busy={!org}>
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {!org ? (
            <Skeleton className="size-full" />
          ) : org?.logo_url ? (
            <img
              src={`${apiUrl(org.logo_url)}?v=${logoTick}`}
              alt="Workspace logo"
              className="size-full object-contain"
            />
          ) : (
            <span className="text-sm text-muted-foreground">no logo</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadLogo(f);
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy || !org} onClick={() => fileRef.current?.click()}>
              <ImagePlus className="size-4" />
              {!org ? <Skeleton className="h-3 w-20" /> : org.logo_url ? "Replace logo" : "Upload logo"}
            </Button>
            {org?.logo_url && (
              <Button size="sm" variant="outline" disabled={busy || !org} onClick={() => void removeLogo()}>
                <Trash2 className="size-4" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">png, jpeg, webp, gif or svg · up to 2 MB</p>
        </div>
      </div>
      <div className="max-w-md space-y-2">
        <label className="text-sm font-medium" htmlFor="workspace-name">
          Workspace name
        </label>
        <div className="flex gap-2">
          {!org ? (
            <div
              role="status"
              aria-label="Loading workspace name"
              className="flex h-9 flex-1 items-center rounded-md border border-border px-3"
            >
              <Skeleton className="h-3 w-36" />
            </div>
          ) : (
            <Input
              disabled={!org}
              id="workspace-name"
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && name.trim() !== org?.name && void saveName()}
              placeholder="e.g. your-org"
            />
          )}
          <Button disabled={busy || !org || !name.trim() || name.trim() === org?.name} onClick={() => void saveName()}>
            Save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Shown wherever the workspace is named; the server address stays unchanged.
        </p>
      </div>
      <div className="max-w-md space-y-2">
        <label className="text-sm font-medium" htmlFor="workspace-url">
          Workspace URL
        </label>
        <Input id="workspace-url" value={serverUrl()} readOnly disabled />
        <p className="text-xs text-muted-foreground">
          Where this workspace's server lives — fixed at sign-in, not changeable here.
        </p>
      </div>
      <div className="max-w-md space-y-2">
        <span className="text-sm font-medium">Telemetry</span>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {org === null
              ? "Loading…"
              : org.telemetry
                ? "On — clients send app diagnostics (errors, socket trace, performance) to this workspace's collector."
                : "Off — clients collect and send nothing."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={telemetryBusy || org === null}
            onClick={() => void toggleTelemetry()}
          >
            {org?.telemetry ? "Turn off" : "Turn on"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Applies to every member of this workspace, live. There is no per-device switch.
        </p>
      </div>
    </div>
  );
}
