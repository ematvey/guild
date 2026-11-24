const openai = "/v1/chat/completions";
const anthropic = "/v1/messages";
const text = "guild-agentgateway-probe";
const usage = { input_tokens: 7, output_tokens: 3 };
const json = (value) => JSON.stringify(value);
const postgresProbe = "const socket = require('node:net').connect(5432, 'postgres.guild-experiment.svc.cluster.local'); socket.on('connect', () => process.exit(1)); socket.on('error', blocked); socket.setTimeout(2000, blocked); function blocked() { socket.destroy(); console.log('gateway-postgres-blocked'); }";
const workspaceShell = `cat gateway-probe.txt && printf ' gateway-shell-marker ' && node -e "${postgresProbe}"`;
const data = (value) => `data: ${json(value)}\n\n`;
const event = (type, value) => `event: ${type}\ndata: ${json({ type, ...value })}\n\n`;

Bun.serve({
  port: 8080,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (req.method !== "POST" || (path !== openai && path !== anthropic)) return new Response(null, { status: 404 });
    const body = await req.json();
    const expectedModel = path === openai ? "fixture-openai" : "fixture-anthropic";
    const providerKey = path === openai ? req.headers.get("authorization") : req.headers.get("x-api-key");
    const expectedKey = path === openai ? "Bearer fixture-provider-key" : "fixture-provider-key";
    if (providerKey !== expectedKey) return Response.json({ error: "expected the gateway's provider key" }, { status: 401 });
    if (body.model !== expectedModel || body.stream !== true) return Response.json({ error: "unexpected provider request" }, { status: 400 });
    const lastUser = body.messages.findLast((item) => item.role === "user");
    let stream;
    if (path === openai) {
      const chunk = (delta, finish = null, counts) => data({
        id: "fixture-openai", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: counts ? [] : [{ index: 0, delta, finish_reason: finish }],
        ...(counts ? { usage: counts } : {}),
      });
      const probe = typeof lastUser?.content === "string" && lastUser.content.includes("guild-experiment-mcp-turn");
      const workspaceProbe = probe && lastUser.content.includes("with-workspace");
      const googleProbe = probe && lastUser.content.includes("with-google");
      const priorResult = body.messages.findLast((item) => item.role === "tool");
      let responseChunks;
      if (probe && !priorResult) {
        const code = googleProbe
          ? 'const result = await tools.fixture_echo_allowed({text: "gateway-tool-result"}); await tools.google_workspace_drive_get_file({file_id:"fixture-file",path:"gateway-probe.bin"}); return result;'
          : workspaceProbe
          ? `const result = await tools.fixture_echo_allowed({text: "gateway-tool-result"}); await tools.write({path:"gateway-probe.txt",content:"gateway-workspace-marker"}); const file = await tools.read({path:"gateway-probe.txt"}); const shell = await tools.bash({command:${json(workspaceShell)}}); return {result,file,shell};`
          : 'return await tools.fixture_echo_allowed({text: "gateway-tool-result"});';
        if (!JSON.stringify(body.messages).includes("fixture")) {
          return Response.json({ error: "MCP discovery missing from prompt" }, { status: 400 });
        }
        responseChunks = chunk({ role: "assistant", tool_calls: [{
          index: 0, id: "call_fixture", type: "function", function: {
            name: "codemode",
            arguments: JSON.stringify({ code }),
          },
        }] }) + chunk({}, "tool_calls");
      } else {
        const resultText = JSON.stringify(priorResult) ?? "";
        const content = probe && resultText.includes("gateway-tool-result") &&
          (!workspaceProbe || (resultText.includes("gateway-workspace-marker") && resultText.includes("gateway-shell-marker") && resultText.includes("gateway-postgres-blocked")))
          ? "verified-mcp-turn-finished"
          : text;
        responseChunks = chunk({ role: "assistant" }) + chunk({ content }) + chunk({}, "stop");
      }
      stream = responseChunks +
        chunk({}, null, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) + "data: [DONE]\n\n";
    } else {
      stream = event("message_start", { message: {
        id: "fixture-anthropic", type: "message", role: "assistant", model: body.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 },
      } }) +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }) +
        event("message_stop", {});
    }
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
