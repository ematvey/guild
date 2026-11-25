# Guild

Guild is a self-hosted AI workspace for organizations. It replaces services
like Codex and Cowork, and the organization keeps control of the data and the
models.

Your chat history, skills, integration credentials, provider keys and usage
records live on your own server. No vendor sees them.

## What you get

- **Chat with any model.** Members talk to the org gateway. Provider keys stay
  on the server.
- **Work happens on your machines.** The desktop app runs tools in the project
  folder you choose. A chat with no folder runs in a server sandbox.
- **Runs survive a restart.** Long work continues from its last recorded step.
  Stop a run at any point.
- **Projects.** A project is a named folder on a machine. A chat binds to it
  and gets the folder's files and instructions.
- **Skills.** Package reusable instructions, and call one by name with
  `/name`.
- **Integrations.** Connect MCP servers as org-wide connectors, with per-tool
  curation and secrets held by admins.
- **Registry.** Publish a skill or integration, review it, then install it
  across the org.
- **Approvals.** Control which tool calls need a member's yes, and which the
  exec policy blocks.
- **Routines.** Give a persistent agent a prompt on a schedule.
- **Usage and cost.** See spend per org, team, member and model. Set monthly
  quotas on model routes.
- **Every surface.** A desktop app for Windows, Linux and macOS, a browser
  chat client, admin pages, and a CLI for scripts.

## Start here

Deploy the server on Kubernetes with the Helm chart in
[`deploy/kubernetes`](deploy/kubernetes/README.md): build the server image,
load it into the cluster, then `helm upgrade --install guild` with your
values. `deploy/kubernetes/README.md` is the full procedure.

```bash
docker build -f Dockerfile.server-ts -t guild-server-ts:<commit> .
# load the image into the cluster, then install or upgrade the chart
curl -s https://guild.example.com/api/v1/health     # {"status":"ok"}
```

Create the first admin, then add a provider key and a model route:

```bash
curl -s -X POST https://guild.example.com/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.org","password":"<password>"}'
```

The admin API calls and the rest of the HTTP examples are in
[`docs/api.md`](docs/api.md). Deployment details, ports and teardown are in
[`deploy/README.md`](deploy/README.md).

Then open the web UI at the server address, or install the desktop app for the
machine that should run tools.

## Build the desktop app

```bash
cd apps/desktop && npm install
npm run tauri dev
```

A client release publishes a Windows installer, a Linux AppImage and a macOS
DMG to the server's release registry. The process is in
[`docs/clients.md`](docs/clients.md).

## Development

One gate checks the repo:

```bash
scripts/check.sh          # all checks
scripts/check.sh --fast   # skip cargo and server tests
```

It needs `cargo-nextest`. It runs the test suites, clippy, fmt, biome,
the protocol check, the coherence check and the typecheck, then prints a
summary. Format before you commit with `cargo fmt --all` and
`./node_modules/.bin/biome check --write .`.

The code lives in these places:

| Path | What it holds |
| --- | --- |
| `apps/desktop` | Tauri desktop client and the web SPA |
| `apps/server` | Cloud server, HTTP API, SQL migrations |
| `crates/app-server` | Local engine binary |
| `crates/guild-core` | Tools and the registry bundle codec |
| `crates/protocol` | Shared Rust wire types |
| `packages/wire` | TypeScript wire types |
| `packages/ui` | Shared component kit |
| `packages/genui` | Generated UI component library |
| `packages/integration-sdk` | Integration plugin contract and CLI |
| `protocol` | Wire schemas, fixtures and the compatibility check |
| `deploy/kubernetes` | Helm chart and cluster manifests |

## Documentation

- [`docs/PRD.md`](docs/PRD.md) — what the product is and does.
- [`docs/domain/`](docs/domain/README.md) — the domain model, in reading
  order.
- [`docs/SRS.md`](docs/SRS.md) — the system contracts.
- [`docs/api.md`](docs/api.md) — HTTP and CLI examples.
- [`docs/deploy-nuances.md`](docs/deploy-nuances.md) — deploy recipes.
- [`docs/clients.md`](docs/clients.md) — client builds and releases.
- [`docs/type-scale.md`](docs/type-scale.md) — text roles and sizes.
