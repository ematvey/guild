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
| libdmg-hfsplus | wraps the raw HFS+ image into a real UDIF `.dmg` | a local build of `libdmg-hfsplus` — with two patches: cmake ≥3.5 and an OpenSSL-3 `filevault_stub.c` (encrypted-DMG support removed) |
| dmg2img | DMG round-trip verification | `dmg2img` on `PATH` |
| webkit2gtk-4.1 | Linux GUI build | `pacman -S webkit2gtk-4.1` |

## 4. Release process

One script does everything (idempotent — republishing replaces existing
artifacts of the same version/platform). When running it detached
(systemd-run), pass the interactive PATH explicitly — `cargo-xwin` lives in
`~/.cargo/bin`, which the systemd user environment lacks:

```bash
BASE=http://localhost:18080 TOKEN=<admin-session-token> VERSION=0.1.0 \
  VITE_DEFAULT_SERVER_URL=https://guild.example.com \
  scripts/release-clients.sh
```

Per-platform pipeline:

### Windows → `Guild_<VERSION>_x64-setup.exe`
Official Tauri NSIS installer, cross-built:
1. `npm run build` (frontend → `dist/`)
2. `npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis`
   (cargo-xwin downloads the MSVC CRT/SDK on first run; `llvm-rc` compiles the
   resource file; the tauri bundler runs `makensis`)
3. Output: `target/x86_64-pc-windows-msvc/release/bundle/nsis/…-setup.exe`
   (installers get shortcuts + uninstaller; WebView2 bootstrapper included)

### Linux → `Guild-<VERSION>_x86_64.AppImage`
1. `cargo build --release -p guild-desktop` (native; the GUI links the host
   webkit2gtk, so a glibc floor pin does not apply — AppImage targets modern
   distros)
2. AppDir: `usr/bin/guild` + `guild.desktop` + hicolor icon
3. `linuxdeploy --appdir <AppDir> --output appimage` (with
   `APPIMAGE_EXTRACT_AND_RUN=1`) — bundles all non-base libs; output lands in
   the linuxdeploy process CWD

### macOS → `Guild-<VERSION>-macos-{aarch64,x86_64}.dmg`
1. `cargo zigbuild --release -p guild-desktop --target <arch>-apple-darwin`
   (WKWebView/AppKit link against the SDK; no Mac needed to *build*) — the
   binary carries a valid linker-generated ad-hoc signature. The link runs
   through `scripts/zig-link-dedup.sh`, which drops repeated `-framework`
   flags: rustc passes one per crate, the zig linker writes one LC_LOAD_DYLIB
   per flag, and dyld on macOS 26 aborts on a dylib named twice
2. Hand-assemble `Guild.app` (`Contents/MacOS/Guild`, `Info.plist`,
   `Resources/icon.icns`) — Tauri's bundler refuses to bundle off-host. With
   `GUILD_APPLE_CERT_P12` (+ `GUILD_APPLE_CERT_PASSWORD`) set, the bundle is
   Developer ID-signed via `rcodesign` before packaging
3. 64 MB raw image → `mkfs.hfsplus` → loop-mount → copy `Guild.app` +
   `Applications` symlink → unmount → `fsck.hfsplus` must pass
4. Wrap into UDIF: `libdmg-hfsplus/build/dmg/dmg build raw.dmg out.dmg`
5. Verify: `dmg2img` round-trip + `7z l` shows `Guild.app` and `Applications`
6. With `GUILD_APPLE_CERT_P12` + `GUILD_APPLE_API_KEY` (App Store Connect API
   key JSON for `rcodesign`) set: notarize the DMG (`rcodesign notary-submit
   --wait`) and staple it. Requires an Apple Developer account ($99/yr); the
   `.app.tar.gz` updater artifact is signed but not stapled — the updater
   installs it without a quarantine flag, so no ticket is needed. Without the
   cert, quarantined downloads trip Gatekeeper's "damaged" dialog; on the
   user's Mac the workaround is
   `xattr -dr com.apple.quarantine /Applications/Guild.app`

`tauri.conf.json` has `"bundle": { "targets": "all" }`; per-run targets are
chosen with `--bundles`/`--output` flags.

### Publishing
Each artifact is uploaded via `POST /api/v1/admin/releases` (admin session
token). The server records size + **sha256**, and **ed25519-signs the
sha256 digest** with a server key (auto-generated once, persisted in
`server_kv`; override with `GUILD_RELEASE_SIGNING_SEED`). The script asserts
the server-computed sha256 matches the local file before declaring success.

### The client tag
Before it builds anything the script refuses a dirty working tree, runs
`node protocol/check.mjs` and aborts on a failure, and refuses a
`client-v<VERSION>` tag that already marks a different commit (a shipped
version is never re-tagged; bump `VERSION`). After the last upload it tags
HEAD `client-v<VERSION>` (annotated) and pushes the tag to `origin` when
that remote exists (`NO_PUSH_TAG=1` keeps it local). The newest
`client-v*` tag is the compatibility baseline: `node protocol/check.mjs`
loads `protocol/*.schema.json` from it and fails when the working tree
removes or retypes anything a shipped client reads from the server
(variants, properties, enum values, required-ness), or requires a property
a shipped client does not send. With no tag reachable (a fresh or shallow
clone: `git fetch --tags`) the comparison is skipped with a warning, and
fails when `CI` is set.

## 5. Downloading + verifying clients

- No UI view: desktop releases are dev-controlled, not admin-controlled.
  The API lists them and mints download URLs.
- CLI:
  ```bash
  URL=$(curl -sS -H "authorization: Bearer $TOKEN" \
        "$BASE/api/v1/releases/$ID/download-url" | jq -r .url)
  curl -sS "$BASE$URL" -o artifact
  guild verify --file artifact --sig <hex> --key <signing-key-hex>
  ```
- `verify` checks the ed25519 signature over the file's sha256 — tamper-proof
  offline once the signing key is pinned.

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

It is idempotent: it deletes and replaces existing artifacts of the same
version/platform, verifies sha256 server-side, and aborts on any mismatch.

## Desktop auto-updater (v0.3.0+)

The desktop app self-updates against the server it is paired/logged into:

1. On launch (and every 15 minutes), the app requests `GET /api/v1/updates/latest.json`
   on the stored server URL. The endpoint is public and serves the Tauri
   updater static-JSON manifest for the newest **fully signed** desktop
   version: per-platform minisign signatures + short-lived signed download
   URLs (24h expiry).
2. If the manifest version is newer, the update downloads silently in the
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

Release flow (per release): bump the version everywhere first with
`scripts/bump-version.sh <version>` (see `docs/deploy-nuances.md` §10 for
the full list of places it must land), then run
`BASE=… TOKEN=… VERSION=… scripts/release-clients.sh` — it signs each
artifact (AppImage, NSIS setup.exe, DMGs, `.app.tar.gz` updater bundles) and
publishes signatures alongside. Debug builds never self-update
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

No service worker ships. A previous build had one and it was retired on
purpose: the browser gets pure-network loads, so a deploy can never leave a
stale shell behind. The cost is that Android and desktop Chrome may not offer
their own install prompt; their "Add to Home screen" menu item still works.
Web Push is the one thing that will require a service worker later — when it
lands, it must not cache the shell, only receive `push` events.

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
