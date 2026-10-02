//! GeneralSection — workspace identity: display name and logo. Admin-only
//! (the section only appears for admins). The logo rides a public GET, but
//! changes require the bearer.

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { PageHeader } from "../components/page-header";
import { api, ApiError, getToken } from "../admin-api";
import { apiUrl, serverUrl } from "../../../transport";

interface OrgSettings {
  name: string;
  logo_url: string | null;
}

export default function GeneralSection() {
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [logoTick, setLogoTick] = useState(0); // busts the img cache on change
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<OrgSettings>("GET", "/api/v1/org")
      .then((v) => {
        setOrg(v);
        setName(v.name);
      })
      .catch((e) => toast.error(`Could not load workspace settings: ${e.message}`));
  }, []);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api("PUT", "/api/v1/org", { name: trimmed });
      setOrg((o) => (o ? { ...o, name: trimmed } : o));
      toast.success("Workspace name saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
        toast.error("Pick an image up to 2 MB (png, jpeg, webp, gif, svg)");
        return;
      }
      setBusy(true);
      try {
        const token = getToken();
        const res = await fetch(
          apiUrl(`/api/v1/org/logo?content_type=${encodeURIComponent(file.type)}`),
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: file,
          },
        );
        if (!res.ok) {
          const v = await res.json().catch(() => ({}));
          throw new Error(v?.error?.message ?? res.statusText);
        }
        const v = (await res.json()) as { logo_url: string };
        setOrg((o) => (o ? { ...o, logo_url: v.logo_url } : o));
        setLogoTick((t) => t + 1);
        toast.success("Logo updated");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const removeLogo = async () => {
    setBusy(true);
    try {
      await api("DELETE", "/api/v1/org/logo");
      setOrg((o) => (o ? { ...o, logo_url: null } : o));
      toast.success("Logo removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="General"
        description="The workspace's name and logo, shown across the app."
      />
      <div className="flex items-center gap-5">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {org?.logo_url ? (
            <img
              src={`${org.logo_url}?v=${logoTick}`}
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
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" />
              {org?.logo_url ? "Replace logo" : "Upload logo"}
            </Button>
            {org?.logo_url && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void removeLogo()}>
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
          <Input
            id="workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() !== org?.name && void saveName()}
            placeholder="e.g. Acme"
          />
          <Button disabled={busy || !name.trim() || name.trim() === org?.name} onClick={() => void saveName()}>
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
    </div>
  );
}
