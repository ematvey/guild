// "Set up a device": explains why the desktop app exists, lists installers
// with the visitor's OS preselected, and issues a pairing code.
import { useEffect, useState } from "react";
import { Copy, Download } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@guild/ui/components/dialog";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { toast } from "sonner";
import { createPairingToken, pairingCode } from "../lib/api/folders";
import { downloadRelease, listReleases, type Release } from "../lib/api/releases";
import { serverUrl } from "../lib/session";
import { formatBytes } from "../lib/format";
import { useTransientFlag } from "../lib/use-transient";
import { compareVersions } from "./skills/version";

type DesktopOs = "mac" | "windows" | "linux";

function detectOs(): DesktopOs {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

const OS_KEY: Record<DesktopOs, string> = { mac: "darwin", windows: "windows", linux: "linux" };

const OS_LABEL: Record<DesktopOs, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

function platformLabel(platform: string): string {
  if (platform === "darwin-aarch64") return "Mac — Apple Silicon";
  if (platform === "darwin-x86_64") return "Mac — Intel";
  if (platform === "windows-x86_64") return "Windows — 64-bit";
  if (platform === "linux-x86_64") return "Linux — 64-bit";
  if (platform === "linux-aarch64") return "Linux — ARM64";
  return platform;
}

export function DeviceSetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [os, setOs] = useState<DesktopOs>("linux");
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairCopied, flashPairCopied] = useTransientFlag(1500);
  const [dlBusy, setDlBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOs(detectOs());
    setReleases(null);
    setPairCode(null);
    listReleases().then((r) => {
      if (r === null) {
        toast.error("Could not load releases");
        return;
      }
      const desktop = r.filter((x) => x.kind === "desktop");
      // show only the latest version's installers, one per platform
      const latest = desktop.reduce<string | null>(
        (acc, x) => (acc === null || compareVersions(x.version, acc) > 0 ? x.version : acc),
        null,
      );
      setReleases(latest === null ? desktop : desktop.filter((x) => x.version === latest));
    });
  }, [open]);

  const installers =
    releases === null
      ? null
      : releases.filter((r) => r.platform.startsWith(OS_KEY[os]) && !r.filename.endsWith(".app.tar.gz"));

  const generatePairing = () => {
    setPairBusy(true);
    createPairingToken(30)
      .then((t) => setPairCode(pairingCode(serverUrl(), t.secret)))
      .finally(() => setPairBusy(false));
  };

  const startDownload = (r: Release) => {
    setDlBusy(r.id);
    downloadRelease(r.id)
      .catch(() => {})
      .finally(() => setDlBusy(null));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set up a device</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 text-left">
          <p className="text-muted-foreground">
            The desktop app runs a Guild agent on your machine — it can work directly in your projects and with your
            files, which the browser chat can't. Chat alone stays right here.
          </p>

          <div>
            <p className="mb-1.5 font-medium text-muted-foreground">1. Download app</p>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
              {(Object.keys(OS_KEY) as DesktopOs[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setOs(k)}
                  className={`rounded-md px-2 py-1.5 outline-none transition-colors ${
                    os === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {OS_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="mt-2 min-w-0 space-y-2">
              {installers === null && [0, 1].map((i) => <SkeletonRows key={i} rows={1} />)}
              {installers !== null && installers.length === 0 && (
                <p className="text-muted-foreground">No {OS_LABEL[os]} installer published yet — check back soon.</p>
              )}
              {installers?.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate" title={r.filename}>
                      {platformLabel(r.platform)}
                    </p>
                    <p className="text-muted-foreground">
                      v{r.version} · {formatBytes(r.size_bytes, { binary: true })}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => startDownload(r)} disabled={dlBusy === r.id}>
                    <Download /> {dlBusy === r.id ? "…" : "Download"}
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {os === "mac" && (
            <div className="mt-2 rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-muted-foreground">
              <p className="text-sm">
                <span className="font-medium text-amber-300">macOS first install:</span> the app is not notarized yet,
                so Gatekeeper may report it as "damaged". Run this once in Terminal after copying it to Applications:
              </p>
              <code className="mt-1.5 block truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                xattr -dr com.apple.quarantine /Applications/Guild.app
              </code>
              <p className="mt-1 text-xs">Updates delivered inside the app are signed and don't need this.</p>
            </div>
          )}

          <div className="mt-6">
            <p className="mb-1.5 font-medium text-muted-foreground">2. Pair with your account</p>
            {pairCode ? (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono" title={pairCode}>
                    {pairCode}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(pairCode);
                      flashPairCopied();
                    }}
                  >
                    <Copy /> {pairCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  Paste into the desktop app's pairing screen. Single-use, expires in 30 minutes.
                </p>
              </div>
            ) : (
              <Button size="sm" onClick={generatePairing} disabled={pairBusy}>
                {pairBusy ? "Generating…" : "Generate pairing code"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
