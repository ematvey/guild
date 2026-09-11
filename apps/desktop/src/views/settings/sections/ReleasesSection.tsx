//! Releases section — admin side of the client-release flow (from the
//! /admin console Downloads view): list releases, upload an artifact,
//! delete one. User-facing download links stay in the Downloads view.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken, ApiError } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";

type Release = {
  id: string;
  version: string;
  kind: string;
  platform: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
};

const KINDS = ["cli", "desktop"] as const;
const PLATFORMS = [
  "linux-x86_64",
  "linux-aarch64",
  "darwin-x86_64",
  "darwin-aarch64",
  "windows-x86_64",
] as const;

/// Raw binary upload: query params carry metadata, body is the artifact.
async function uploadRelease(
  file: File,
  meta: { version: string; kind: string; platform: string; notes: string },
): Promise<void> {
  const q = new URLSearchParams({
    version: meta.version,
    kind: meta.kind,
    platform: meta.platform,
    filename: file.name,
    ...(meta.notes ? { notes: meta.notes } : {}),
  });
  const res = await fetch(`/api/v1/admin/releases?${q}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: file,
  });
  if (!res.ok) {
    const v = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(v?.error?.code ?? "unknown", v?.error?.message ?? res.statusText);
  }
}

export default function ReleasesSection() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ releases: Release[] }>("GET", "/api/v1/releases")
      .then((r) => {
        setReleases(r.releases ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(reload, [reload]);

  const remove = async (id: string) => {
    setError(null);
    try {
      await api("DELETE", `/api/v1/admin/releases/${id}`);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6 pt-2">
      <UploadForm onDone={reload} onError={setError} />

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Published releases
        </h3>
        {releases === null && !error ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : releases !== null && releases.length === 0 ? (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            No client builds published yet — upload one above.
          </p>
        ) : (
          releases !== null && (
            <div className="space-y-2">
              {releases.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{r.version}</span>
                      <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {r.kind} · {r.platform}
                      </span>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={r.filename}>
                      {r.filename} · {(r.size_bytes / 1024 / 1024).toFixed(1)} MiB · sha256{" "}
                      {r.sha256.slice(0, 12)}…
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    onClick={() => void remove(r.id)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Artifacts are ed25519-signed at upload. Users download them from the Downloads page via
        short-lived signed links.
      </p>
    </div>
  );
}

function UploadForm({
  onDone,
  onError,
}: {
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [version, setVersion] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("cli");
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("linux-x86_64");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setLocalError(null);
    if (!file) {
      setLocalError("pick an artifact file first");
      return;
    }
    if (!version.trim()) {
      setLocalError("version is required");
      return;
    }
    setBusy(true);
    try {
      await uploadRelease(file, { version: version.trim(), kind, platform, notes });
      setVersion("");
      setNotes("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLocalError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Upload a release
      </h3>
      <div className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Version
            </span>
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="1.2.3"
              className="h-8 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Kind
            </span>
            <div className="flex gap-2">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-sm capitalize transition-colors ${
                    kind === k
                      ? "border-foreground/40 bg-accent text-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-accent/50"
                  }`}
                  onClick={() => setKind(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Platform
          </span>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
            className="h-8 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Release notes (optional)
          </span>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="what changed in this build"
            className="h-8 text-sm"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Artifact file
          </span>
          <input
            ref={fileRef}
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-accent/70"
          />
          <span className="text-xs text-muted-foreground">
            Up to 512 MiB; the filename is kept as-is.
          </span>
        </label>
        {localError && <p className="text-xs text-destructive">{localError}</p>}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? "Uploading…" : "Upload"}
          </Button>
          {file && !busy && (
            <span className="text-xs text-muted-foreground">
              {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MiB)
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
