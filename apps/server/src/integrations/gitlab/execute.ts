import {
  LIST_TIMEOUT_MS,
  VENDOR_API_MAX_CHARS,
  secretOrNull,
  pathSegment,
  requestJson,
  excerpt,
  clampNumber,
  callVendorApi,
  gitlabBaseUrl,
  type JsonRequestErrors,
} from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

// ---------- gitlab ----------

/** Maps an HTTP failure to the tool-error contract: auth errors, missing
 *  resources, and validation rejections get specific wording; anything
 *  else carries the status and a body excerpt. */
function gitlabMapError(status: number, body: string): string {
  const head = excerpt(body);
  switch (status) {
    case 401:
      return "gitlab auth failed (401)";
    case 404:
      return "gitlab: not found (project or resource)";
    case 400:
      return `gitlab rejected the request: ${head}`;
    default:
      return `gitlab returned ${status}: ${head}`;
  }
}

const GITLAB_ERRORS: JsonRequestErrors = {
  unreachable: (cause) => `gitlab unreachable: ${cause}`,
  unreadable: () => "gitlab returned an unreadable body",
  status: gitlabMapError,
  badJson: () => "gitlab returned bad json",
};

function gitlabSend(url: string, init: RequestInit): Promise<JsonObject> {
  return requestJson(url, init, LIST_TIMEOUT_MS, GITLAB_ERRORS);
}

function gitlabGet(base: string, token: string, path: string, query: [string, string][]): Promise<JsonObject> {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of query) url.searchParams.set(k, v);
  return gitlabSend(url.toString(), { method: "GET", headers: { "PRIVATE-TOKEN": token } });
}

export async function gitlabExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("gitlab secret 'token' is not stored");
  const base = gitlabBaseUrl(config);
  if (tool === "api") {
    return callVendorApi(base, { kind: "private_token", token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "list_projects": {
      const search = typeof args["search"] === "string" ? args["search"] : "";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const query: [string, string][] = [
        ["membership", "true"],
        ["order_by", "last_activity_at"],
        ["per_page", String(perPage)],
      ];
      if (search !== "") query.push(["search", search]);
      const body = await gitlabGet(base, token, "/projects", query);
      const projects = Array.isArray(body) ? body : [];
      let content = "";
      for (const [i, project] of projects.entries()) {
        const name = typeof project["name"] === "string" ? project["name"] : "(unnamed)";
        const path = typeof project["path_with_namespace"] === "string" ? project["path_with_namespace"] : "";
        const url = typeof project["web_url"] === "string" ? project["web_url"] : "";
        const description = typeof project["description"] === "string" ? project["description"] : "";
        content += `${i + 1}. ${name} (${path}) ${url}\n   ${description}\n`;
      }
      if (content === "") content = "No projects.";
      return { content };
    }
    case "list_issues": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("list_issues requires project");
      const state = typeof args["state"] === "string" ? args["state"] : "opened";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const body = await gitlabGet(base, token, `/projects/${pathSegment(project)}/issues`, [
        ["state", state],
        ["per_page", String(perPage)],
      ]);
      const issues = Array.isArray(body) ? body : [];
      let content = "";
      for (const issue of issues) {
        const iid = typeof issue["iid"] === "number" ? issue["iid"] : 0;
        const title = typeof issue["title"] === "string" ? issue["title"] : "";
        const state = typeof issue["state"] === "string" ? issue["state"] : "?";
        const author = ((issue["author"] ?? {}) as JsonObject)["username"];
        content += `!${iid} [${state}] ${title} (@${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No issues.";
      return { content };
    }
    case "list_mrs": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("list_mrs requires project");
      const state = typeof args["state"] === "string" ? args["state"] : "opened";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const body = await gitlabGet(base, token, `/projects/${pathSegment(project)}/merge_requests`, [
        ["state", state],
        ["per_page", String(perPage)],
      ]);
      const mrs = Array.isArray(body) ? body : [];
      let content = "";
      for (const mr of mrs) {
        const iid = typeof mr["iid"] === "number" ? mr["iid"] : 0;
        const title = typeof mr["title"] === "string" ? mr["title"] : "";
        const state = typeof mr["state"] === "string" ? mr["state"] : "?";
        const source = typeof mr["source_branch"] === "string" ? mr["source_branch"] : "?";
        const target = typeof mr["target_branch"] === "string" ? mr["target_branch"] : "?";
        const author = ((mr["author"] ?? {}) as JsonObject)["username"];
        content += `!${iid} [${state}] ${title} (${source}→${target}, @${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No merge requests.";
      return { content };
    }
    case "create_issue": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("create_issue requires project");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("create_issue requires title");
      const payload: JsonObject = { title };
      if (typeof args["description"] === "string") payload["description"] = args["description"];
      const body = await gitlabSend(`${base}/projects/${pathSegment(project)}/issues`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const iid = typeof body["iid"] === "number" ? body["iid"] : 0;
      const url = typeof body["web_url"] === "string" ? body["web_url"] : "";
      return {
        content: `Created issue !${iid}: ${url}`,
        meta: { iid, url },
      };
    }
    default:
      throw new Error(`gitlab integration has no tool ${tool}`);
  }
}
