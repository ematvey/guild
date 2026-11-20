# Guild client distribution

How the Guild client is built, packaged, published, and verified. Everything
below runs on a Linux build host — no Windows or macOS machine is required
(with documented caveats for Apple signing).

## 1. Architecture: one binary, one process

The client is a **single executable** (`guild-desktop` crate → shipped as
`Guild`/`Guild.exe`/`guild`) running the **single-process design**: the GUI process hosts the
engine itself. There is no headless daemon in the product flow and no
automatic daemon spawn — a CLI verb without a running app fails with
"Guild app is not running" instead of forking a headless engine.

| Invocation | Behaviour |
|---|---|
| `Guild` (no args) | GUI: hosts everything in-process — the engine (session, JSON-RPC dispatch), the per-user CLI socket (Unix socket on Linux/macOS, named pipe on Windows), and the member WebSocket link all live in this one process; no separate daemon process is spawned or attached to |
| `Guild daemon` | the same engine headless on the local socket; nothing spawns it automatically — manual fallback for debugging, or the unit's ExecStart on headless hosts |
| `Guild daemon install [--linger]` | Linux: install/upgrade the daemon as a systemd **user unit** (`guild-daemon.service`, `Restart=always` + `RestartSec=5s`, enabled at login); works while a Guild app is running — the app's in-process socket host is retired via `daemon.shutdown` (the handshake verifies the owner is a Guild daemon) and defers to the unit, reclaiming the socket when the unit stops; verifies the retired host's socket actually released before `enable --now` and that the unit's daemon is reachable after; `--linger` best-effort enables `loginctl enable-linger` |
| `Guild daemon status` / `uninstall` | unit state / stop + remove the unit |
| `Guild login --url U --email E --password P` (or `--token CODE`) | CLI verb via the running app's local socket (the GUI, or the unit daemon on headless hosts — no spawn fallback); login validates and persists the session to `~/.config/guild/token.json` |
| `Guild chat --model M "text"` | CLI verb via the running app's local socket (streams the reply through it) |
| `Guild publish --kind K --dir D --version V` | CLI verb via the running app's local socket |
| `Guild install --slug S [--project P]` | CLI verb via the running app's local socket (`--project` defaults to `.`) |
| `Guild verify --file F --sig SIG --key KEY` | offline ed25519 verification of a downloaded release artifact (no socket, no network) |

The engine loop is the library code in `guild-app-server::jsonrpc_loop`
(the desktop crate links the app-server library). The webview is a pure UI:
HTTP request/response plus per-turn replay over in-process std pipes — the
same dispatch surface the CLI socket serves, backed by the same `Shared`
(session, machine-link watch channel). The GUI holds three server routes by
design: the in-process engine dispatch, the member WebSocket (presence,
client-tool dispatch, fan-out), and the updater's direct fetch of the public
`/api/v1/updates/latest.json` + release artifacts — that endpoint is public
and unauthenticated, installs are gated by the baked-in minisign pubkey, and
no session token travels from the GUI (the documented exception to the
one-cloud-route rule). The session token lives only in the process
(`~/.config/guild/token.json`), never in the webview.

Daemon lifecycle: the GUI hosts the daemon in-process (single-process
model — no spawn fallback); on Linux a host can instead run it as the
`guild-daemon.service` user unit (`Guild daemon install`). The two
coexist: the process hosting the CLI socket runs the machine link, the
unit owns the executor while it is active, the GUI defers (its host task
parks, no second link) and reclaims the socket when the unit stops;
whoever hosts, auth stays propagated — the daemon re-seeds its link
config from token.json changes, so a pair or sign-out in the GUI reaches
the link whichever process owns it. Either
way one engine owns the session and all agent runs, is shared by every
client connection, and exits on `daemon.shutdown` — which a
version-mismatched client invokes on attach (handshake on `daemon.hello`
carries the daemon's build version; under the unit, `Restart=always`
re-spawns the daemon 5 s later).

Documented exception to the one-cloud-route rule: the Tauri updater plugin
in the GUI fetches `/api/v1/updates/latest.json` + release artifacts
directly — that endpoint is public and unauthenticated, and the plugin
requires in-GUI binary handling. No session token travels from the GUI.

The socket/pipe path can be overridden for development with
`GUILD_DAEMON_SOCKET`.

Pairing: a pairing code (`g1|<server_url>|<secret>`) names the server the
session token goes to. The pairing screen shows that host before Pair, and
the engine refuses a plain `http://` server unless its host is loopback
(`localhost`, `127.0.0.0/8`, `::1` — the local dev stack). A LAN test server
over plain http needs `GUILD_ALLOW_INSECURE_PAIRING=1` in the engine's
environment (the app, or the `guild-daemon` unit).

Trace: the engine, the machine link and the desktop's webview-rpc bridge
write one diagnostic log, `<user cache dir>/guild/guild-trace.log`
(`~/.cache/guild/` on Linux; owner-only, capped at 1 MiB). It is off by
default: turn it on in Settings → About (persisted across launches) or with
`GUILD_DAEMON_TRACE=1` (headless daemons). Lines name methods, ids and
sizes, never request or response payloads.

## 2. Web mode + admin sections (product flow)

The same chat frontend runs in two hosts:

- **Desktop (Tauri)**: engine login → full agent view (project, tools,
  approvals).
- **Web** (served by the TS server): the SAME frontend at `/` —
  it detects the browser (no `__TAURI_INTERNALS__`), uses same-origin
  HTTP plus the member WebSocket instead of the engine, and runs in
  **chat mode** (streaming gateway chat; agent mode with local tools stays
  desktop-only — tools run on the machine that has the project).
- **Admin sections**: workspace-wide Settings pages (General, Usage,
  Assistant, Users, Teams, Models, Integrations, SSO, Registry) are
  admin-gated and share the app's session. There is no separate admin app;
  `/admin` falls through to the chat SPA.

Serving: the TS server embeds the frontend (`/` = chat app from
`apps/desktop/dist`, built in the webui stage of `Dockerfile.server-ts`).

## Tauri release builds need `custom-protocol`

Plain `cargo build --release` produces a DEV-mode binary: Tauri's `dev` cfg is
set whenever the `custom-protocol` feature is off, and the window then tries
to load the vite dev server (`http://localhost:1420`) showing "Connection
refused". Always build release binaries with:

    cargo build --release -p guild-desktop --features tauri/custom-protocol

(`tauri build` sets it automatically; the release script does this for the
AppImage and macOS DMG builds — cross-verified by launching the shipped
artifacts under xvfb.)

## Server URL resolution (in the GUI login form)

Precedence order:

1. **Last successfully used URL** — stored in `localStorage`
   (`guild.serverUrl`) after each successful login (per-machine pref,
   survives restarts, no rebuild needed).
2. **`VITE_DEFAULT_SERVER_URL`** — baked into the frontend bundle at build
   time:
   ```bash
   VITE_DEFAULT_SERVER_URL=https://guild.example.com npm run build
   ```
   (then run the packaging script — the value is inside the shipped binary).
3. Fallback: `http://localhost:18080`.

The field stays editable, so any URL can always be typed at login.

## 3. Build-host toolchain

| Tool | Purpose | Setup |
|---|---|---|
| rustup targets | cross std libs | `rustup target add aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc` |
| zig + cargo-zigbuild | macOS/Linux cross-linking (libc + frameworks without Xcode/gcc per target) | `pacman -S zig; cargo install cargo-zigbuild` |
| macOS SDK | Apple headers/frameworks for the macOS builds | tar.xz from phracker/MacOSX-SDKs, extracted to a local directory (the script reads `SDKROOT`) |
| mingw-w64-gcc | Windows-gnu targets (engine CLI builds) | `pacman -S mingw-w64-gcc` |
| cargo-xwin | MSVC-target Windows builds (GUI) — downloads the Windows SDK/CRT automatically | `cargo install --locked cargo-xwin` |
| NSIS (makensis) | Windows installer bundling | not in Arch repos: extract `nsis` + `nsis-common` debs from Ubuntu archive into a local directory on `PATH` |
| llvm + lld | `llvm-rc` (Windows resource compile), `lld-link` | `pacman -S llvm lld` |
| linuxdeploy | AppImage assembly (bundles webkit2gtk libs) | the `linuxdeploy` AppImage on `PATH` (continuous release) |
| hfsprogs | HFS+ format + fsck for macOS DMGs | AUR `hfsprogs` (`paru -S hfsprogs`) |
| libdmg-hfsplus | wraps the raw HFS+ image into a real UDIF `.dmg` | a local build of `libdmg-hfsplus` — with two patches: cmake ≥3.5 and an OpenSSL-3 `filevault_stub.c` (encrypted-DMG support removed); its `dmg` binary on `PATH` |
| dmg2img | DMG round-trip verification | `dmg2img` on `PATH` |
| webkit2gtk-4.1 | Linux GUI build | `pacman -S webkit2gtk-4.1` |

## 4. Release process

GitHub Releases holds desktop installers, updater bundles, minisign signatures,
`SHA256SUMS`, `release.json` and the Tauri `latest.json`. Every publication contains
six artifacts for four platforms. A draft becomes public only after GitHub's
asset digests and sizes match the local files. Published versions are not replaced.

### Stable releases

Every push to `master` starts **Release clients**, which selects the next patch
version, runs `scripts/bump-version.sh`, creates an SSH-signed version commit,
and builds and publishes the stable GitHub Release. A verified signed version
commit does not trigger another release. A rerun reuses its version commit;
manual dispatch accepts an optional stable version override.

After publication, the workflow opens a version-only PR to `develop` and enables
auto-merge after the required Version policy check. The synchronization edits
version fields in develop's own files and lockfiles, preserving its dependencies
and source changes. A develop build after synchronization previews the next patch.

The repository secret `TAURI_SIGNING_PRIVATE_KEY` contains the existing updater
private key; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` contains its password (empty
for a passwordless key). Keep the existing key so installed clients accept updates.
Repository setup uses `node scripts/release.mjs configure` with repository admin
access. It creates a repository-scoped release deploy key, stores its private key
as `RELEASE_PUSH_KEY` in the `stable-release` Actions environment, and restricts
that environment to `master`. It also installs `.github/release-ruleset.json`,
requiring **Version policy** on `develop` and `master`, and enables GitHub release
immutability. `.github/master-release-ruleset.json` requires PRs to master and
blocks force pushes and deletion; the release deploy key has the automation exception. The deploy key can push the validated release version commit through
the branch rule. Version commits are SSH-signed with that key; the policy checks
its public key from `RELEASE_SIGNING_PUBLIC_KEY`, checks that only product version
files changed, and validates the synchronized version increase. A commit author
or message alone grants no release exception. Repository setup enables PR auto-merge and permits Actions to create synchronization
PRs; the sync job has explicit pull-request write permission. Setup is idempotent; the key stays
in GitHub's encrypted environment secret, not in the checkout.

Only the master release workflow changes committed product versions. Other
branches keep a stable version and may synchronize a released version from
`master`. The version policy checks the workspace Cargo version and lock entries,
Tauri config, npm package versions and workspace lock entries. It rejects committed
preview stamps and version drift, including changes hidden in lockfiles.

### Preview and local releases

Every push to `develop` starts **Release clients** and publishes a GitHub
prerelease. Manual dispatch on another branch also creates a preview. A preview of `0.6.126` is `0.6.127-dev.<timestamp>`. It is
excluded from GitHub's latest stable release. No source version commit is created.

The local cross-build entry point is:

```bash
node scripts/release.mjs preview
# Explicit build number, with GitHub publication:
PUBLISH=1 node scripts/release.mjs preview 42
```

CI and local defaults use the same millisecond UTC timestamp scale so a later
CI build sorts after a local build. An explicit local build number is also accepted. No hash is needed
in a version. `release.json` records the source commit separately for provenance.
The source tree must be committed; a disposable worktree receives the preview
stamp, installs its own workspace dependencies and shares the build host's npm
and Cargo caches. Artifacts land in
`$OUTPUT_DIR` or the system temporary directory under `guild-releases/<version>`.
The source branch and its version files stay unchanged.

The local builder needs the tools in §3 and the SDK at `$SDKROOT`. Both local and
CI builds use a generic client: the server address is editable at pairing, and
the stored paired server controls updates. The same artifacts can serve several
stacks. Signing and packaging do not publish to a Guild database.

Deploy the matching dev server from the same source commit and artifact directory:

```bash
node scripts/release.mjs deploy-preview /tmp/guild-releases/0.6.127-dev.42 dev
```

This records the preview version in the stack’s ignored Compose `.env`, rebuilds the server image with that version, and starts it. The committed version files stay stable. After the server reports the stamped
version, deployment pins that release for the named installation.

### Approving a release on a server

Configure the stack with `GUILD_RELEASE_REPOSITORY=owner/repository` and
`GUILD_RELEASE_CHANNEL=stable` (the default) or `develop` for dev. Then an admin
approves a published tag whose version does not exceed the running server:

```bash
curl -fsS -X POST "$BASE/api/v1/admin/releases/github" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tag":"client-v0.6.127"}'
```

The server reads only its configured public GitHub repository. It checks the
release channel, all six artifacts, their digests, sizes and signature assets,
then imports the download metadata and approved version in one transaction.
The server's existing release endpoints return GitHub URLs. The paired updater
endpoint serves only the approved complete release; it does not follow GitHub's
latest release automatically. Develop stacks can approve a preview; stable stacks reject it. Approvals are stored separately for stable and develop. Listing, installer download URLs and the updater manifest all enforce the running server version as a ceiling, including after a server downgrade.
Approval changes metadata only and requires no rebuild of the client artifacts.

Verify the stack's `/api/v1/updates/latest.json`: its version must be the approved
version and its `platforms` must contain all four targets with signatures and
GitHub download URLs. Removing an updater artifact suppresses the incomplete
manifest.

### Develop release retention

Daily cleanup keeps the newest ten develop releases, every develop release under
fourteen days old, and every pinned release. Stable releases are never pruned.
Expired develop releases and their tags are deleted together; deleted immutable
tag names are not reused. Intermediate Actions build artifacts expire after three
days. Release workflows queue independently per branch without cancelling builds.

Each installation has its own repository variable, `DEVELOP_RELEASE_PIN_<NAME>`,
whose value is a published `client-v<version>-dev.<build>` tag. Installation names
use letters, numbers and underscores and are case-insensitive. `deploy-preview`
updates its installation pin only after the matching server is live. Other stacks
pin their approved release before it ages out; removing an installation's variable
unpins it. The cleanup cannot discover independently hosted servers.

```bash
node scripts/release.mjs pin staging client-v0.6.127-dev.42
node scripts/release.mjs prune          # show the deletion plan
node scripts/release.mjs prune --apply  # execute the same retention policy
```

The **Prune client previews** workflow applies this policy daily. Manual dispatch
shows the plan unless its `apply` input is selected. Missing/invalid pin values or
release dates abort cleanup. GitHub metadata in a server database is not a pin.

### Protocol baseline

The newest stable `client-v<major>.<minor>.<patch>` tag is the compatibility
baseline for `node protocol/check.mjs`. Preview tags do not replace it. Fetch
full history and tags in release checkouts. CI refuses a missing baseline.

## 5. Downloading and verifying clients

The release API lists approved GitHub artifacts compatible with the server.
`GET /api/v1/releases/{id}/download-url?channel=stable|develop` returns a GitHub
URL. Authenticated `/download` requests redirect there after checking eligibility.
The desktop updater verifies the artifact's minisign signature against its baked
public key. `release.json` and `SHA256SUMS` contain artifact digests for manual
verification. Guild stores metadata and channel approvals; GitHub stores bytes.

## 6. Verification matrix (honest limits)

| Artifact | Verified |
|---|---|
| linux-x86_64 (GUI + engine) | **executed**: GUI runs under xvfb (webkit alive); engine login/chat over stdio |
| windows-x86_64 | installer produced by the official bundler; portable exe launches under wine (WebView2 cannot render in wine — full GUI session needs a real Windows box) |
| darwin-aarch64 / darwin-x86_64 | build + Mach-O format + .app/DMG structure verified (fsck, plist, dmg2img); ad-hoc signature page hashes verified; aarch64 launches on macOS 26.1 (arm64 host); x86_64 not executed |
| macOS signing | ad-hoc (linker-generated, valid); Developer ID + notarization via `rcodesign` when `GUILD_APPLE_CERT_P12`/`GUILD_APPLE_API_KEY` are provided; quarantined ad-hoc downloads still hit Gatekeeper — user workaround `xattr -dr com.apple.quarantine <path to Guild.app>` |

## 7. Release scripts

| Script | Publishes |
|---|---|
| `scripts/release-clients.sh` | one combined GUI+engine distribution per OS (exe / AppImage / 2 DMGs) |

Published GitHub versions are immutable by convention. A new preview gets a new
build number; the publisher only resumes drafts. Enable GitHub release immutability
to enforce asset and tag immutability at the repository level.

## Desktop auto-updater (v0.3.0+)

The desktop app self-updates against the server it is paired/logged into:

Each desktop installation saves a stable/develop preference in its local configuration.
Settings → About changes it; signing out or pairing another server preserves it.
A fresh stable build defaults to stable, and a fresh preview defaults to develop.

1. On launch (and every 15 minutes), the app requests `GET /api/v1/updates/latest.json?channel=stable` or `?channel=develop`
   on the stored server URL. The endpoint is public and serves the Tauri
   updater static-JSON manifest for the server-approved desktop version,
   with per-platform minisign signatures and GitHub download URLs. Without a
   complete eligible approved GitHub release, the endpoint returns 204.
2. The native updater requires `installed < candidate <= server_version` and a matching channel. The server version reaches the UI over `workspace_identity`; a change clears any pending offer. Before applying downloaded bytes, the updater revalidates the current server, channel, version and signature. If the eligible manifest version is newer, the update downloads silently in the
   background (VSCode/Zed-style); a toast "Update to vX ready — Restart to
   update" appears (on any screen, including the pairing screen).
3. Clicking restart applies the update and relaunches. On Windows the NSIS
   installer runs in passive mode and exits the app itself; on macOS/Linux
   the app replaces its own bundle and restarts.

Integrity: every updater artifact is minisign-signed with the keypair at
`~/.tauri/guild.key` (back this up — losing it means already-installed
clients can never be updated again). The public key is baked into the app
config; installs are rejected without a valid signature. Plain-HTTP servers
are allowed (`dangerousInsecureTransportProtocol`) since signatures still
gate every install.

The release workflow signs every artifact. Debug builds do not self-update
(`GUILD_UPDATER_FORCE=1` opts in for testing).

---

## 8. Mobile clients (iOS) — research and the first stage

Status: not built. This section records the shape we chose and the facts that
decide it, so the work starts from a decision and not from a survey.

### 8.1 Shape: an engine-less client, not a second engine

The iOS app is a **client to the server**, the same way web mode is
(`docs/clients.md` §2). It runs no engine, executes no tools, and hosts no
machine link. It bundles its own UI and talks to the paired server over the
same HTTP API and member WebSocket the desktop webview and the browser use.
The local executor stays where the project is.

The product question this shape must answer: what does the app do that Safari
does not? Guideline 4.2 rejects an app that is a repackaged website, and the
guidelines say so directly ("we provide Safari for a great web experience
too"). Push, offline history, Keychain session, and universal links are the
honest answers. Without at least one of them there is no reason to ship.

### 8.2 Stage 1: foreground only — restore state, reconnect the socket

The first stage does no push and no background work. On launch and on every
return to the foreground the client:

1. restores the session (Keychain), and
2. reconnects the member socket and runs the normal `sync` bracket.

That is enough for a usable client. The socket is the source of truth and the
sync bracket already covers everything missed while the app was suspended.
Nothing else in the client changes.

### 8.3 The one code change: split `IS_TAURI` from "has an engine"

`IS_TAURI` (`apps/desktop/src/lib/session.ts`) is read in 58 places across 23
files, and it carries two different meanings today:

- "this host is a Tauri shell", and
- "this host runs a local engine".

An iOS build is Tauri and has no engine, so the second meaning breaks: the
app would call `start_engine`, report a machine identity, and offer
`list_dir`/`wsl_home`. Before any mobile target, split it:

- `IS_TAURI` — the shell exists.
- `HAS_ENGINE` — a local engine exists (desktop only; resolved once at start).

Desktop-only surfaces follow `HAS_ENGINE`: engine attach, machine identity,
local file picker, window title, tray, updater, `opener`. One flag, one
meaning.

### 8.4 iOS constraints that change the deployment, not the client

- **HTTPS is mandatory.** App Transport Security blocks plain HTTP. The dev
  and prod stacks serve `http://…:18080` / `:18081`; an iOS client needs a
  public hostname with a valid certificate in front of them.
- **No iOS build on the Linux host.** `tauri ios build` needs Xcode,
  CocoaPods, and a provisioning profile. The whole release story in §4 is
  "no Mac required" — that stops at iOS. A Mac or a cloud Mac is a new
  requirement for this target only.
- **No OTA UI.** Guideline 2.5.2 requires a self-contained bundle, so iOS
  does not get the fast UI fix loop the desktop has. Every UI change is a
  review cycle.

### 8.5 App Store rules that apply to this client

| Rule | Applies because | What to do |
|---|---|---|
| 4.2 Minimum Functionality | Client to our own service | Add native value: push, offline, Keychain, links |
| 2.5.2 | UI must be self-contained | Bundle the UI. No downloaded UI bundle |
| 4.8 | SSO/OIDC login buttons exist | Add Sign in with Apple, or ship password login only |
| 5.1.1(v) | The app creates accounts | Provide in-app account deletion |
| 3.1.1 | Any digital purchase inside the app | Use IAP, or keep purchases out of the app |
| 1.2 | Agent output and multi-user chat are user content | Report, block, and filter mechanisms |
| 5.1 | Data collection | `PrivacyInfo.xcprivacy` + required-reason APIs |
| 2.1 | Review needs a live backend | Keep a demo account alive during review |

4.8 is the one that surprises teams: one third-party login button pulls in
Sign in with Apple.

### 8.6 Push: APNs is the only path

Every remote wake-up on iOS ends at APNs — alert push, silent push, Web Push
(Safari, Home Screen web app), PushKit, Live Activity updates. There is no
second network. Background fetch and background `URLSession` are not delivery
paths: the OS decides when they run, and the user can disable them.

The socket cannot substitute. A backgrounded app is suspended after about 30
seconds; TCP connections do not survive it. Declaring `voip` or `audio` to
keep a socket alive violates 2.5.4 and loses the entitlement.

So when push arrives, the server gains a second transport beside the socket,
not a second event system:

```
thread event -> notify(event)
                  |- WS connected? -> frame (as today)
                  '- not connected -> prefs, mute, quiet hours -> APNs
```

Server work this implies:

- **Device registry** — `user_id`, `device_id`, `apns_token`, `platform`,
  `last_seen`. Register on every launch; delete the row on `410 Unregistered`.
- **APNs auth** — token-based (`.p8`, ES256, key id + team id), rotatable
  without a client release.
- **Preference model** — per category, per-thread mute, quiet hours. Without
  it an agent that emits 40 events sends 40 pushes and Apple throttles the
  app.
- **Presence gate** — a live WS on any device means frame, not push.
- **Coalescing** — one push per thread per window,
  `apns-collapse-id = thread:<id>`.
- **Badge** — unread count computed server-side, matching the sidebar count.
- **Payload policy** — content or a generic nudge, per user, default generic
  for agent output.

Push event set stays small: mention, approval waiting, run finished, run
failed, subagent failed, new message in a thread you are in. Skill and
release events stay in the inbox.

APNs facts to design around: 4 KB payload, priority 10 requires a visible
alert, silent pushes are budgeted (a few per hour, unpublished) and may be
dropped, no delivery guarantee and no ordering, a limited offline queue.
Push is a hint; the app syncs on open.

Traps that cost days: sandbox vs production endpoint (`BadDeviceToken` from a
debug token), `apns-push-type` missing or wrong, `410` never handled so stale
tokens pile up, and carrying state in a push that the app cannot re-fetch.

### 8.7 The cheaper experiment

iOS 16.4+ supports Web Push for web apps added to the Home Screen. It runs
through APNs, so it needs the same device registry and APNs credentials, and
it needs no Xcode, no review, and no new client. Build the push service
against a Home Screen web app first. If the notifications prove useful, the
native client is a UX upgrade over a proven channel.

### 8.7.1 Add to Home Screen — what ships

The install is a server-side property, not a client feature. The web build
already carries it:

| Piece | Where |
|---|---|
| `manifest.webmanifest` — name, `start_url`, `scope: "/"`, `display: standalone`, 192/512/maskable icons | `apps/desktop/public/` |
| `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | `apps/desktop/public/` |
| `<link rel="manifest">`, the three `apple-mobile-web-app-*` metas, `theme-color` | `apps/desktop/index.html` |
| `application/manifest+json` and `no-cache` on non-hashed files | `apps/server/src/http/web.ts` (`MIME`, `serveFile`) |

The service worker (`apps/desktop/public/sw.js`) receives Web Push and
answers an offline launch from a shell cache. The shell is network-first, so
an online launch always gets the current bundle and a deploy never leaves a
stale shell behind. Without a cached shell, Android and desktop Chrome may
not offer their own install prompt; their "Add to Home screen" menu item
still works.

**The steps are browser-specific, so the UI detects instead of assuming.**
`installState()` in `apps/desktop/src/lib/session.ts` (the module that already
answers "which host am I in" with `IS_TAURI`) is pure over an injected surface
and answers one question with five answers:

- `installed` — `navigator.standalone` or `(display-mode: standalone)`.
- `ios-safari` — iOS/iPadOS, not installed: the Share-sheet steps apply.
  iPadOS reports `MacIntel`, so the touch count decides.
- `ios-browser` — Chrome, Firefox, Edge, Opera or DuckDuckGo on iOS. They wrap
  WebKit but cannot install a web app, and their copy gets no push. The UI
  says so instead of showing steps that cannot work.
- `android` — Chrome on Android: installable from the browser menu.
- `other` — desktop: nothing to install, nothing to say.

Three surfaces render the same `InstallSteps`:

- **`/install`** — the guide as its own route (`InstallGuide` in
  `apps/desktop/src/views/thread/ThreadOverlays.tsx`), so a help link or a
  colleague can share the address. Chat-independent, like `/onboard`.
- **A floating prompt** — one dismissible line on any screen, signed in or
  not, at the top on a phone and bottom-right on a wide screen
  (`localStorage` key `guild.installHintDismissed`). A signed-in user never
  sees the login card, so this is the only place the offer reaches them
  without opening Help.
- **The onboarding guide** — an "On your phone" section, added only when
  `installOffered()` is true.

`InstallSteps` itself lives in `apps/desktop/src/views/onboarding.tsx`: the
steps are onboarding, and three surfaces render the same block.

Each shows a "check again" button that re-reads the surface, because the
`standalone` flag and the media query change only on a fresh launch — the
honest check is a re-read, not an assumption.

Still missing, and deliberately so: the service worker, a VAPID key pair per
org origin, subscription storage, and the `push` handler. Those belong to the
push model decision (§8.6), not to the install step.

#### Viewport: no `viewport-fit=cover`

The installed app does **not** ask for full-bleed. `apps/desktop/index.html`
carries a plain viewport (`width=device-width, initial-scale=1.0,
maximum-scale=1, user-scalable=no`) and the status bar style is `black`, not
`black-translucent`.

Measured on iOS 26, iPhone 16 Pro Max (440×956, insets 62/34): with `cover`
the first launch is correct (`innerHeight` 956), but after the Google SSO
sheet is presented and dismissed the page keeps a height of 894 while still
being drawn from y=0 — the 62pt status-bar inset is subtracted twice. The
strip below the page cannot be laid out from CSS, so the composer and the
drawer sit 62pt too high. A document reload does not repair it; only killing
the app does. `apple-mobile-web-app-status-bar-style` does not help either: iOS
takes that value at install time, and a meta change alone is ignored.

Without `cover` the page is inset from the bars, `env()` reports 0, and the
strip cannot appear. The `max()` paddings on the header, drawer and composer
already reduce to their minimum when `env()` is 0, so nothing else changes.
`viewport-fit` is read from the document on every load, which is why it wins
where the status-bar style does not.

### 8.8 Not doing: a remote UI bundle

We considered and rejected shipping the client as a small shell that loads
the UI from the server (Tauri supports it: `frontendDist` may be a URL). It
moves the trust boundary — remote JavaScript plus the `invoke` bridge reaches
`list_dir`, `wsl_home`, `rpc_request`, and `install_update` — and it collides
with Apple's rules: 2.5.2 forbids downloaded code that changes features, 4.2
rejects a thin shell, and 2.4.5(iv) forbids it on the Mac App Store outright.
A signed, locally cached bundle would be defensible, but it is still a
downloaded UI with no review. Keep the UI in the bundle.

### 8.9 Sources

- Apple, App Review Guidelines — <https://developer.apple.com/app-store/review/guidelines/>
- Tauri, capabilities and remote API access — <https://v2.tauri.app/security/capabilities/>
- Tauri, config reference (`frontendDist`) — <https://v2.tauri.app/reference/config/>
- Expo, EAS Update (accepted OTA practice) — <https://docs.expo.dev/eas-update/introduction/>
- Google Play, Spam policy — <https://support.google.com/googleplay/android-developer/answer/9899034>
