Gives agents web search through your own SearxNG instance, a self-hosted metasearch engine that queries other search engines and merges their results. No vendor account or key is needed.

## What agents can do

- Search the web and get the top results with title, URL, and snippet (up to 10 per query).

The tool only reads.

## Before you start

- A running SearxNG instance that the Guild server can reach over the network.
- JSON output turned on in that instance. SearxNG serves only HTML by default; add `json` to `search.formats` in its `settings.yml`:

  ```yaml
  search:
    formats:
      - html
      - json
  ```

  See [SearxNG search settings](https://docs.searxng.org/admin/settings/settings_search.html).

## Set it up

1. Turn on JSON output as above and restart SearxNG.
2. In Guild, install SearxNG from the integrations page.
3. Enter the instance URL without `/search`, such as `http://searxng:8080` for a container on the same Docker network.
4. Click **Test connection**. Guild runs a test search with `format=json`.
5. Enable the integration.

## Permissions and data

SearxNG uses one shared org setting (`org_secret`) and no credential; no member identity is sent. Search queries go to your instance, which forwards them to the engines it is configured to use.

SearxNG provides the `web_search` trait: its callable tool is `searxng_web_search`. When several search providers are enabled, the org picks one.

## Troubleshooting

- **Test connection fails with 403.** JSON output is off. Add `json` to `search.formats` and restart the instance.
- **"searxng unreachable".** The URL is wrong or not reachable from the Guild server's network. From inside a container, `localhost` is the container itself.
- **Searches return no results.** The engines SearxNG uses are failing or rate-limiting it; check the instance's own logs and engine settings.
- **Test connection fails with 429.** The instance's bot limiter is blocking Guild. Exempt the Guild server's address or turn the limiter off for private use.
