import { LIST_TIMEOUT_MS, VENDOR_API_MAX_CHARS, secretOrNull, pathSegment, fetchTimeout, transportCause, excerpt, clampNumber, callVendorApi, githubApiUrl } from "../shared.js";
import type { ToolOutcome, Json } from "../shared.js";

// ---------- github ----------

const GITHUB_USER_AGENT = "guild-integration-github";

/** Maps an HTTP failure to the tool-error contract: auth errors, missing
 *  resources, and validation rejections get specific wording; anything
 *  else carries the status and a body excerpt. */
function githubMapError(status: number, body: string): string {
  const head = excerpt(body);
  switch (status) {
    case 401:
    case 403:
      return `github auth failed (${status})`;
    case 404:
      return "github: not found";
    case 422:
      return `github rejected the request: ${head}`;
    default:
      return `github returned ${status}: ${head}`;
  }
}

interface GithubRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "user-agent": GITHUB_USER_AGENT,
    accept: "application/vnd.github+json",
  };
}

async function githubSend(url: string, init: GithubRequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, init as RequestInit));
  } catch (error) {
    throw new Error(`github unreachable: ${transportCause(error)}`);
  }
  const status = res.status;
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error("github returned an unreadable body");
  }
  if (!(status >= 200 && status < 300)) {
    throw new Error(githubMapError(status, body));
  }
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new Error("github returned bad json");
  }
}

/** The contents-API path for one file: owner/repo as encoded segments, and
 *  the file path as `/`-separated encoded parts — a `..` segment is
 *  rejected (it traverses to another repo path with the org credential). */
function githubFilePath(owner: string, repo: string, filePath: string): string {
  const parts = filePath
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => pathSegment(p));
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}/contents/${parts.join("/")}`;
}

function githubRepoLine(i: number, hit: Json): string {
  const fullName = typeof hit["full_name"] === "string" ? hit["full_name"] : "(unnamed)";
  const url = typeof hit["html_url"] === "string" ? hit["html_url"] : "";
  const language = typeof hit["language"] === "string" ? hit["language"] : "";
  const stars = typeof hit["stargazers_count"] === "number" ? hit["stargazers_count"] : 0;
  const description = typeof hit["description"] === "string" ? hit["description"] : "";
  return `${i + 1}. ${fullName} (${language === "" ? "?" : language}, ★${stars}) ${url}\n   ${description}\n`;
}

export async function githubExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("github secret 'token' is not stored");
  const api = githubApiUrl(config);
  if (tool === "api") {
    return callVendorApi(api, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, [
      ["User-Agent", GITHUB_USER_AGENT],
      ["Accept", "application/vnd.github+json"],
    ]);
  }
  switch (tool) {
    case "search_repositories": {
      const query = args["query"];
      if (typeof query !== "string") throw new Error("search_repositories requires query");
      const perPage = clampNumber(args, "per_page", 10, 50);
      const url = new URL(`${api}/search/repositories`);
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const hits = Array.isArray(body["items"]) ? (body["items"] as Json[]) : [];
      let content = hits.map((hit, i) => githubRepoLine(i, hit)).join("");
      if (content === "") content = "No repositories matched.";
      return {
        content,
        meta: {
          kind: "github",
          search: "repositories",
          total_count: typeof body["total_count"] === "number" ? body["total_count"] : hits.length,
        },
      };
    }
    case "list_issues": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("list_issues requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("list_issues requires repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const url = new URL(`${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/issues`);
      url.searchParams.set("state", state);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const issues = Array.isArray(body) ? body : [];
      let content = "";
      for (const issue of issues) {
        // GitHub returns pull requests here too — skip them.
        if (issue["pull_request"] !== null && typeof issue["pull_request"] === "object") continue;
        const number = typeof issue["number"] === "number" ? issue["number"] : 0;
        const title = typeof issue["title"] === "string" ? issue["title"] : "";
        const issueState = typeof issue["state"] === "string" ? issue["state"] : "?";
        const author = ((issue["user"] ?? {}) as Json)["login"];
        content += `#${number} [${issueState}] ${title} (@${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No issues.";
      return { content };
    }
    case "list_pulls": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("list_pulls requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("list_pulls requires repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const url = new URL(`${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/pulls`);
      url.searchParams.set("state", state);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const pulls = Array.isArray(body) ? body : [];
      let content = "";
      for (const pr of pulls) {
        const number = typeof pr["number"] === "number" ? pr["number"] : 0;
        const title = typeof pr["title"] === "string" ? pr["title"] : "";
        const prState = typeof pr["state"] === "string" ? pr["state"] : "?";
        const head = (((pr["head"] ?? {}) as Json)["ref"] ?? "?") as string;
        const base = (((pr["base"] ?? {}) as Json)["ref"] ?? "?") as string;
        const author = ((pr["user"] ?? {}) as Json)["login"];
        content += `#${number} [${prState}] ${title} (${typeof head === "string" ? head : "?"}→${typeof base === "string" ? base : "?"}, @${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No pull requests.";
      return { content };
    }
    case "get_file": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("get_file requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("get_file requires repo");
      const filePath = args["path"];
      if (typeof filePath !== "string") throw new Error("get_file requires path");
      const url = new URL(`${api}${githubFilePath(owner, repo, filePath)}`);
      if (typeof args["ref"] === "string") url.searchParams.set("ref", args["ref"]);
      const entry = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      // GitHub nulls `content` for files above the contents-API size cap;
      // `encoding` is base64 for regular files.
      const encoded = typeof entry["content"] === "string" ? entry["content"] : null;
      const encoding = typeof entry["encoding"] === "string" ? entry["encoding"] : null;
      let text: string;
      if (encoding === "base64" && encoded !== null) {
        try {
          const bytes = Buffer.from(encoded.replace(/\n/g, ""), "base64");
          text = bytes.toString("utf8");
          if (Buffer.from(text, "utf8").equals(bytes) === false) {
            throw new Error("github file is not utf-8 text");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "github file is not utf-8 text") throw error;
          throw new Error(`github file undecodable: ${(error as Error).message}`);
        }
      } else if (encoding === "none" && encoded !== null) {
        text = encoded;
      } else {
        throw new Error("github file too large for the contents API");
      }
      return {
        content: text,
        meta: { kind: "github", file: typeof entry["path"] === "string" ? entry["path"] : filePath },
      };
    }
    case "create_issue": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("create_issue requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("create_issue requires repo");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("create_issue requires title");
      const payload: Json = { title };
      if (typeof args["body"] === "string") payload["body"] = args["body"];
      if (Array.isArray(args["labels"])) payload["labels"] = args["labels"];
      const url = `${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/issues`;
      let res: Response;
      try {
        res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, {
          method: "POST",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        throw new Error(`github unreachable: ${transportCause(error)}`);
      }
      const status = res.status;
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new Error("github returned an unreadable body");
      }
      if (!(status >= 200 && status < 300)) throw new Error(githubMapError(status, text));
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        throw new Error("github returned bad json");
      }
      const number = typeof body["number"] === "number" ? body["number"] : 0;
      const issueUrl = typeof body["html_url"] === "string" ? body["html_url"] : "";
      return {
        content: `Created issue #${number}: ${issueUrl}`,
        meta: { number, url: issueUrl },
      };
    }
    default:
      throw new Error(`github integration has no tool ${tool}`);
  }
}

