import { langfuseBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { langfuseExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "langfuse",
    title: "Langfuse",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Langfuse LLM observability: list and inspect traces, list prompts",
    description:
      "Adds LLM observability to chats. List recent traces, read one trace in " +
      "full, and fetch a prompt by name and version.\n\n" +
      'Use it to answer "why did the agent do that" questions: the trace carries ' +
      "the model calls, the token counts, and the tool spans of a run.",
    docs_url: "https://langfuse.com/docs",
    categories: ["observability"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "Langfuse URL",
        required: false,
        default: "https://cloud.langfuse.com",
        help: "Override for self-hosted Langfuse",
        placeholder: "https://langfuse.example.com",
      },
      {
        name: "public_key",
        kind: "secret",
        label: "Public key",
        required: true,
        default: null,
        help: null,
        placeholder: "pk-lf-…",
      },
      {
        name: "secret_key",
        kind: "secret",
        label: "Secret key",
        required: true,
        default: null,
        help: null,
        placeholder: "sk-lf-…",
      },
    ],
    tools: [
      {
        name: "list_traces",
        class: "read",
        description: "List recent Langfuse traces (id, name, timestamp).",
        parameters: {
          type: "object",
          properties: { limit: { type: "number", description: "1-50 traces, default 10" } },
        },
      },
      {
        name: "get_trace",
        class: "read",
        description: "Fetch one Langfuse trace with its full body by id.",
        parameters: {
          type: "object",
          properties: { trace_id: { type: "string" } },
          required: ["trace_id"],
        },
      },
      {
        name: "get_prompt",
        class: "read",
        description: "Fetch one Langfuse prompt by name (latest or a specific version).",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Prompt name" },
            version: { type: "number", description: "Specific version (default: latest)" },
          },
          required: ["name"],
        },
      },
      apiTool("Langfuse"),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    const base = langfuseBaseUrl(config, secrets);
    const public_key = secret(secrets, "public_key");
    const secret_key = secret(secrets, "secret_key");
    const basic = Buffer.from(`${public_key}:${secret_key}`).toString("base64");
    await probe(
      fetch(
        `${base}/api/public/projects`,
        fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Basic ${basic}` } }),
      ),
      "langfuse",
    );
  },
  execute: langfuseExecute,
};

export default plugin;
