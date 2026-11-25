Gives agents web search and page reading through your own Firecrawl server: they search the web, read pages as clean markdown, and list the links on a site.

## What agents can do

- Search the web and get the top results with title, URL, and description.
- Fetch one public page and get its content as markdown.
- Map a site: list the links Firecrawl discovers from a root URL, useful before reading a documentation tree.

All tools only read. Crawl jobs are not exposed.

## Before you start

- A self-hosted [Firecrawl](https://docs.firecrawl.dev/) API that the Guild server can reach over the network. Its root page (`/`) must answer with "Firecrawl API"; Test connection checks for that text.
- An API key only if your instance enforces authentication. The self-hosted default does not.

## Set it up

1. Run Firecrawl (see its self-hosting guide) and note the address Guild reaches it at. A container on the Docker host is reachable at the default, `http://host.docker.internal:13002`.
2. In Guild, install Firecrawl from the integrations page.
3. Enter the API URL, and paste an API key if your instance needs one.
4. Click **Test connection**.
5. Enable the integration.

## Permissions and data

Firecrawl runs with one shared org configuration (`org_secret`); no member identity is passed to it. Search queries and the URLs agents fetch are sent to your Firecrawl server, which then contacts the target sites and its search backend. Guild refuses to fetch or map private and internal addresses, so agents cannot use it to reach hosts on your network.

Firecrawl provides the `web_search` and `web_fetch` traits: its callable tools are `firecrawl_web_search` and `firecrawl_web_fetch`. When several providers are enabled, the org picks one for each.

## Troubleshooting

- **"firecrawl unreachable".** The API URL is wrong or not reachable from the Guild server's network. From inside a container, `localhost` is the container itself; use the host or service name.
- **"unexpected response at / (not a Firecrawl API?)".** The URL points at something else, such as a proxy page or the wrong port.
- **401 or 403 from Firecrawl.** The instance requires an API key, or the key is wrong.
- **"firecrawl error: …" on a fetch.** Firecrawl could not scrape that page. When the deployment sets `GUILD_CURL_FETCH_URL`, `web_fetch` retries the URL through the `curl-fetch` service (a browser-fingerprinted GET), which answers JSON and plain-text endpoints and thin pages. The message carries both reasons when the fallback also fails.
