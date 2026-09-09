import { useEffect, useState } from "react";
import { api, getToken } from "../api";

type Release = {
  id: string;
  version: string;
  kind: string;
  platform: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  notes: string;
  created_at: string;
};

export default function Downloads() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ releases: Release[] }>("GET", "/api/v1/releases")
      .then((v) => setReleases(v.releases))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)));
  }, []);

  const download = async (id: string) => {
    // mint a short-lived signed URL, then trigger a plain browser download
    const v = await api<{ url: string }>("GET", `/api/v1/releases/${id}/download-url`);
    const a = document.createElement("a");
    a.href = v.url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const curlFor = (id: string) =>
    `curl -sS -o artifact.bin "$(curl -sS -H 'authorization: Bearer $TOKEN' \\
      $BASE/api/v1/releases/${id}/download-url | jq -r .url)"`;

  return (
    <div className="p-6 text-sm">
      <h2 className="mb-4 text-lg font-medium">Client downloads</h2>
      {error && <p className="text-red-400">{error}</p>}
      {releases === null && !error && <p className="text-neutral-500">Loading…</p>}
      {releases?.length === 0 && (
        <p className="text-neutral-500">
          No client builds published yet. Admins upload artifacts via
          <code className="mx-1 rounded bg-neutral-900 px-1">POST /api/v1/admin/releases</code>
          (version, kind: cli|desktop, platform).
        </p>
      )}
      {releases && releases.length > 0 && (
        <table className="w-full text-left">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-2">version</th>
              <th className="py-2">kind</th>
              <th className="py-2">platform</th>
              <th className="py-2">file</th>
              <th className="py-2">size</th>
              <th className="py-2">sha256</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id} className="border-t border-neutral-800">
                <td className="py-2 pr-4">{r.version}</td>
                <td className="py-2 pr-4">{r.kind}</td>
                <td className="py-2 pr-4">{r.platform}</td>
                <td className="py-2 pr-4 font-mono text-xs">{r.filename}</td>
                <td className="py-2 pr-4">{(r.size_bytes / 1024 / 1024).toFixed(1)} MiB</td>
                <td className="py-2 pr-4 font-mono text-xs text-neutral-500" title={r.sha256}>
                  {r.sha256.slice(0, 12)}…
                </td>
                <td className="py-2 text-right">
                  <button
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500"
                    onClick={() => void download(r.id)}
                  >
                    Download
                  </button>
                  <button
                    className="ml-2 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
                    onClick={() => void navigator.clipboard?.writeText(curlFor(r.id))}
                    title="Copy a curl command (uses $TOKEN and $BASE env vars)"
                  >
                    copy curl
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {releases && releases.length > 0 && getToken() && (
        <p className="mt-4 text-xs text-neutral-500">
          Verify after download: <code className="rounded bg-neutral-900 px-1">sha256sum &lt;file&gt;</code> must match the
          checksum above.
        </p>
      )}
    </div>
  );
}
