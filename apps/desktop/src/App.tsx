import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import AgentView from "./views/AgentView";
import { Input } from "./components/input";
import { Button } from "./components/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/card";

function Login({ onLoggedIn }: { onLoggedIn: (email: string) => void }) {
  const [url, setUrl] = useState("http://localhost:18080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("start_engine");
      const res = await invoke<any>("rpc_request", {
        method: "login",
        params: { base_url: url, email, password },
      });
      if (res.error) {
        setError(res.error.message ?? "login failed");
      } else {
        onLoggedIn(res.result?.user?.email ?? email);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-100">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Guild</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input placeholder="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button onClick={submit} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function App() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    invoke("start_engine").catch(() => {});
  }, []);
  return email ? <AgentView email={email} /> : <Login onLoggedIn={setEmail} />;
}
