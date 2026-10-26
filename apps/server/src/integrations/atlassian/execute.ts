import { CALL_TIMEOUT_MS, VENDOR_API_MAX_CHARS, secretOrNull, configString, pathSegment, urlencode, fetchTimeout, transportCause, excerpt, clampNumber, callVendorApi, atlassianSite } from "../shared.js";
import type { ToolOutcome, Json } from "../shared.js";

// ---------- atlassian ----------

interface AtlassianCreds {
  site: string;
  email: string;
  token: string;
}

function atlassianCreds(config: Json, secrets: [string, string][]): AtlassianCreds {
  // Site and email are plain settings (config wins, the legacy
  // secret-named rows are the fallback); only the token is a credential.
  const site = atlassianSite(config, secrets);
  const email = configString(config, "email") ?? secretOrNull(secrets, "email");
  if (email === undefined || email === null || email === "") throw new Error("atlassian requires the email setting");
  const token = secretOrNull(secrets, "token");
  if (token === null || token === "") throw new Error("atlassian secret 'token' is not stored");
  return { site, email, token };
}

const ATLASSIAN_JIRA_FIELDS = "summary,status,issuetype,assignee,created";

async function atlassianSendJson(url: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(CALL_TIMEOUT_MS, init));
  } catch (error) {
    throw new Error(`atlassian unreachable: ${transportCause(error)}`);
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error("atlassian body unreadable");
  }
  if (!res.ok) {
    // A short error body helps diagnosis; Atlassian error messages name
    // the bad JQL/CQL — never credential values.
    throw new Error(`atlassian returned ${res.status}: ${excerpt(body)}`);
  }
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new Error("atlassian returned bad json");
  }
}

function atlassianAuth(creds: AtlassianCreds): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString("base64")}` };
}

/** One line of a search result: `KEY — summary [Status] (Assignee)`. */
function jiraLine(issue: Json): string {
  const key = typeof issue["key"] === "string" ? issue["key"] : "?";
  const fields = (issue["fields"] ?? {}) as Json;
  const summary = typeof fields["summary"] === "string" ? fields["summary"] : "";
  const status = (fields["status"] ?? {}) as Json;
  const statusName = typeof status["name"] === "string" ? status["name"] : "";
  const assignee = (fields["assignee"] ?? {}) as Json;
  const assigneeName = typeof assignee["displayName"] === "string" ? assignee["displayName"] : "";
  let line = `${key} — ${summary}`;
  if (statusName !== "") line += ` [${statusName}]`;
  if (assigneeName !== "") line += ` (${assigneeName})`;
  return line;
}

/** Flattens one Jira issue into a readable block with a browse URL. */
function jiraIssueBlock(creds: AtlassianCreds, issue: Json): string {
  const key = typeof issue["key"] === "string" ? issue["key"] : "?";
  const fields = (issue["fields"] ?? {}) as Json;
  const status = (fields["status"] ?? {}) as Json;
  const itype = (fields["issuetype"] ?? {}) as Json;
  const assignee = (fields["assignee"] ?? {}) as Json;
  const statusName = typeof status["name"] === "string" ? status["name"] : "";
  const typeName = typeof itype["name"] === "string" ? itype["name"] : "";
  const assigneeName = typeof assignee["displayName"] === "string" ? assignee["displayName"] : "";
  const created = typeof fields["created"] === "string" ? fields["created"] : "";
  let block = `${key} — ${typeof fields["summary"] === "string" ? fields["summary"] : ""}`;
  const facts: string[] = [];
  if (typeName !== "") facts.push(`type: ${typeName}`);
  if (statusName !== "") facts.push(`status: ${statusName}`);
  if (assigneeName !== "") facts.push(`assignee: ${assigneeName}`);
  if (created !== "") facts.push(`created: ${created}`);
  if (facts.length > 0) block += `\n${facts.join(" | ")}\n`;
  block += `${creds.site}/browse/${key}`;
  return block;
}

/** Strips storage-format XHTML tags and collapses whitespace to plain
 *  text. */
function storageToText(value: string): string {
  let text = "";
  let inTag = false;
  for (const c of value) {
    if (c === "<") {
      // Tag boundaries separate words — keep one space per tag.
      if (!text.endsWith(" ") && text !== "") text += " ";
      inTag = true;
    } else if (c === ">") {
      inTag = false;
    } else if (!inTag) {
      text += c;
    }
  }
  return text.split(/\s+/).filter((s) => s !== "").join(" ");
}

export async function atlassianExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const creds = atlassianCreds(config, secrets);
  const auth = atlassianAuth(creds);
  if (tool === "api") {
    return callVendorApi(creds.site, { kind: "basic", user: creds.email, pass: creds.token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "jira_search": {
      const jql = args["jql"];
      if (typeof jql !== "string") throw new Error("jira_search requires jql");
      const maxResults = clampNumber(args, "max_results", 10, 50);
      const body = await atlassianSendJson(`${creds.site}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          jql,
          maxResults,
          fields: ["summary", "status", "issuetype", "assignee"],
        }),
      });
      const issues = Array.isArray(body["issues"]) ? (body["issues"] as Json[]) : [];
      const truncated = issues.length > maxResults;
      let content = issues.slice(0, maxResults).map(jiraLine).join("\n");
      if (content === "") content = "No issues match the query.";
      return {
        content,
        meta: { kind: "jira_search", count: Math.min(issues.length, maxResults), truncated },
      };
    }
    case "jira_get_issue": {
      const key = args["issue_key"];
      if (typeof key !== "string") throw new Error("jira_get_issue requires issue_key");
      const issue = await atlassianSendJson(
        `${creds.site}/rest/api/3/issue/${pathSegment(key)}?fields=${urlencode(ATLASSIAN_JIRA_FIELDS)}`,
        { headers: auth },
      );
      return {
        content: jiraIssueBlock(creds, issue),
        meta: {
          kind: "jira_issue",
          key: issue["key"] ?? null,
          url: `${creds.site}/browse/${typeof issue["key"] === "string" ? issue["key"] : key}`,
        },
      };
    }
    case "confluence_search": {
      const cql = args["cql"];
      if (typeof cql !== "string") throw new Error("confluence_search requires cql");
      const limit = clampNumber(args, "limit", 10, 50);
      const url = new URL(`${creds.site}/wiki/rest/api/search`);
      url.searchParams.set("cql", cql);
      url.searchParams.set("limit", String(limit));
      const resp = await atlassianSendJson(url.toString(), { headers: auth });
      const results = Array.isArray(resp["results"]) ? (resp["results"] as Json[]) : [];
      const truncated = results.length > limit;
      let content = results
        .slice(0, limit)
        .map((r) => {
          const inner = (r["content"] ?? {}) as Json;
          const title = typeof inner["title"] === "string" ? inner["title"] : "(untitled)";
          const id = typeof inner["id"] === "string" ? inner["id"] : "?";
          const excerptText = typeof r["excerpt"] === "string" ? r["excerpt"] : "";
          return excerptText === "" ? `${title} (id ${id})` : `${title} (id ${id}): ${excerptText}`;
        })
        .join("\n");
      if (content === "") content = "No results match the query.";
      return {
        content,
        meta: { kind: "confluence_search", count: Math.min(results.length, limit), truncated },
      };
    }
    case "confluence_get_page": {
      const pageId = args["page_id"];
      if (typeof pageId !== "string") throw new Error("confluence_get_page requires page_id");
      const page = await atlassianSendJson(
        `${creds.site}/wiki/rest/api/content/${pathSegment(pageId)}?expand=${urlencode("body.storage")}`,
        { headers: auth },
      );
      const title = typeof page["title"] === "string" ? page["title"] : "";
      const body = (page["body"] ?? {}) as Json;
      const storage = (body["storage"] ?? {}) as Json;
      const storageValue = typeof storage["value"] === "string" ? storage["value"] : "";
      const links = (page["_links"] ?? {}) as Json;
      const webui = typeof links["webui"] === "string" ? links["webui"] : "";
      let content = title;
      const text = storageToText(storageValue);
      if (text !== "") content += `\n\n${text}`;
      if (webui !== "") content += `\n\n${creds.site}${webui}`;
      return { content, meta: { kind: "confluence_page", id: page["id"] ?? null, title } };
    }
    case "confluence_create_page": {
      const spaceKey = args["space_key"];
      if (typeof spaceKey !== "string") throw new Error("confluence_create_page requires space_key");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("confluence_create_page requires title");
      const value = args["content"];
      if (typeof value !== "string") throw new Error("confluence_create_page requires content");
      const page = await atlassianSendJson(`${creds.site}/wiki/rest/api/content`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          type: "page",
          title,
          space: { key: spaceKey },
          body: { storage: { value, representation: "storage" } },
        }),
      });
      const id = typeof page["id"] === "string" ? page["id"] : "";
      const links = (page["_links"] ?? {}) as Json;
      const webui = typeof links["webui"] === "string" ? links["webui"] : "";
      const url = webui === "" ? null : `${creds.site}${webui}`;
      let content = `Created page ${id} (${title})`;
      if (url !== null) content += `\n${url}`;
      const meta: Json = {
        kind: "confluence_page_created",
        id,
        title: typeof page["title"] === "string" ? page["title"] : title,
      };
      if (url !== null) meta["url"] = url;
      return { content, meta };
    }
    default:
      throw new Error(`atlassian integration has no tool ${tool}`);
  }
}

