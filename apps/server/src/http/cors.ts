// CORS — the port of the Rust server's tower-http CorsLayer
// (crates/server/src/http/mod.rs): same-origin requests never hit CORS;
// the desktop webview (tauri://localhost on macOS, http(s)://tauri.localhost
// elsewhere) and the vite dev server are the only cross-origin clients.
// Blanket-permissive CORS would let any page drive an authenticated
// session's API from a browser — keep the allow-list exact.
//
// Preflights (OPTIONS + Access-Control-Request-Method) are answered here
// before routing; actual responses get the ACAO header when the origin is
// allowed. `*` values mirror tower-http's `Any` semantics.

const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    vary: "Origin",
  };
}

type FastifyLike = {
  addHook: (name: string, fn: (req: unknown, reply: unknown, done: () => void) => void) => void;
};

interface ReqLike {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  code(status: number): ReplyLike;
  header(name: string, value: string): ReplyLike;
  send(body?: unknown): unknown;
}

export function registerCors(app: FastifyLike): void {
  app.addHook("onRequest", (rawReq, rawReply, done) => {
    const req = rawReq as ReqLike;
    const reply = rawReply as ReplyLike;
    const originHeader = req.headers["origin"];
    const origin = typeof originHeader === "string" ? originHeader : "";
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      // Preflight: answered in full here (204, like tower-http), before
      // routing — the retired proxy used to forward these to Rust. ACAO
      // rides only for allow-listed origins; the rest fail in the browser.
      reply.code(204);
      if (ALLOWED_ORIGINS.has(origin)) {
        for (const [name, value] of Object.entries(corsHeaders(origin))) reply.header(name, value);
      }
      reply.send();
      return;
    }
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      done();
      return;
    }
    for (const [name, value] of Object.entries(corsHeaders(origin))) reply.header(name, value);
    done();
  });
}
