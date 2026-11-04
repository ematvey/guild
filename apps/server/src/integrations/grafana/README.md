Lets agents answer operational questions from one Grafana instance: query Prometheus metrics and Loki logs, browse dashboards and data sources, and see which alerts are firing.

## What agents can do

- Run a PromQL query, instant or over a time range, against a Prometheus data source.
- Run a LogQL query against a Loki data source and read the newest lines with their labels.
- List data sources with their type and uid.
- List dashboards by title and read one dashboard's title, tags, and panels.
- List the active Grafana alerts with severity, start time, and summary.
- Call any Grafana HTTP API endpoint through the generic `api` tool. This can write, if the token's role allows it.

Every metrics and log answer names the data source it used. Pass a data source by name or uid when the instance has one per region or pipeline.

## Before you start

- A Grafana instance reachable from the Guild server, and an org admin who can create service accounts.
- The names or uids of the Prometheus and Loki data sources agents should use by default.

## Set it up

1. In Grafana, open **Administration → Users and access → Service accounts → Add service account** and give it the **Viewer** role. See [service accounts](https://grafana.com/docs/grafana/latest/administration/service-accounts/).
2. Click **Add service account token** and copy it (`glsa_…`).
3. In Guild, install Grafana from the integrations page.
4. Enter the Grafana URL, the organization id (the `orgId=` value in Grafana URLs, usually `1`), and the default Prometheus and Loki data sources. Paste the token.
5. Click **Test connection**, then enable the integration.

## Permissions and data

All calls use the one shared service-account token (`org_secret`), sent with the configured organization id. Agents read what that service account can read in that organization. With the Viewer role the named tools only read; the `api` tool can change things only as far as the role allows.

## Troubleshooting

- **Test connection passes but every tool fails with 401.** Test connection calls `/api/health`, which does not check the token. Create a new token and paste it again.
- **"datasource … not found".** The default or requested name or uid does not exist in this organization, or the token cannot read data source details. Check the name under **Connections → Data sources**; if the lookup returns 403, give the service account a role that can read data sources.
- **"datasource … is loki, not prometheus".** The query went to the wrong kind of data source; pass the right one.
- **Results from the wrong region.** Pass the region's data source explicitly; the defaults point at one data source each.
