import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "../components/button";
import { Input } from "../components/input";

interface RouteRow {
  model: string;
  provider: string;
  enabled: boolean;
}

export default function Gateway() {
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    // model routes live per-org; read via the gateway models list plus admin view
    api<{ models: string[] }>("GET", "/api/v1/gateway/models")
      .then((r) => setRoutes(r.models.map((m) => ({ model: m, provider: "", enabled: true }))))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(reload, [reload]);

  const saveKey = async () => {
    setError(null);
    try {
      await api("POST", "/api/v1/admin/gateway/keys", { provider, base_url: baseUrl, key });
      setKey("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const saveRoute = async () => {
    setError(null);
    try {
      await api("PUT", "/api/v1/admin/gateway/routes", {
        model,
        provider,
        enabled: true,
        price_in: Number(priceIn),
        price_out: Number(priceOut),
      });
      setModel("");
      setPriceIn("");
      setPriceOut("");
      reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="space-y-8 p-6">
      {error && <p className="text-sm text-red-400">{error}</p>}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Provider key</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select className="h-9 rounded-md border border-neutral-700 bg-neutral-900 px-2 text-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
          <Input className="w-64" placeholder="base url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <Input className="w-64" placeholder="api key" type="password" value={key} onChange={(e) => setKey(e.target.value)} />
          <Button onClick={saveKey} disabled={!key}>
            Save key
          </Button>
        </div>
        <p className="text-xs text-neutral-500">Keys are stored encrypted; never sent to clients.</p>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Model route</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-48" placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
          <Input className="w-28" placeholder="price in $/Mtok" value={priceIn} onChange={(e) => setPriceIn(e.target.value)} />
          <Input className="w-28" placeholder="price out $/Mtok" value={priceOut} onChange={(e) => setPriceOut(e.target.value)} />
          <Button onClick={saveRoute} disabled={!model || !priceIn || !priceOut}>
            Save route
          </Button>
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">Exposed models</h3>
        <ul className="space-y-1 font-mono text-xs text-neutral-400">
          {routes.map((r) => (
            <li key={r.model}>{r.model}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
