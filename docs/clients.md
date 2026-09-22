# Guild client distribution

How the Guild client is built, packaged, published, and verified. Everything
below runs on a Linux build host — no Windows or macOS machine is required
(with documented caveats for Apple signing).

## 1. Architecture: one binary, one process

The client is a **single executable** (`guild-desktop` crate → shipped as
`Guild`/`Guild.exe`/`guild`) running the **single-process design**
(docs/specs/2026-09-13-single-process-desktop.md): the GUI process hosts the
engine itself. There is no headless daemon in the product flow and no
automatic daemon spawn — a CLI verb without a running app fails with
"Guild app is not running" instead of forking a headless engine.

| Invocation | Behaviour |
|---|---|
| `Guild` (no args) | GUI: hosts everything in-process — the engine (session, JSON-RPC dispatch), the per-user CLI socket (Unix socket on Linux/macOS, named pipe on Windows), and the member WebSocket link all live in this one process |
| `Guild daemon` | manual fallback: the same engine headless on the local socket (`run_daemon`); nothing spawns it automatically — useful for debugging |
| `Guild daemon install [--linger]` / `status` / `uninstall` | Linux: install/upgrade the daemon as a systemd **user unit** (`guild-daemon.service`, `Restart=on-failure`, enabled at login); retires an unsupervised daemon first; `--linger` best-effort enables `loginctl enable-linger` for headless hosts. Supervised boot persistence for the executor — a headless-host option, not part of the GUI flow |
| `Guild login --url U --email E --password P` (or `--token CODE`) | CLI verb via the running app's local socket (requires the GUI up — no spawn fallback); login validates and persists the session to `~/.config/guild/token.json` |
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

The socket/pipe path can be overridden for development with
`GUILD_DAEMON_SOCKET`.

## 2. Web mode + admin console (product flow)

The same chat frontend runs in two hosts:

- **Desktop (Tauri)**: engine login → full agent view (project, tools,
  approvals). The header has an **Admin console ↗** link that opens the
  system browser at `<server>/admin/#tk=<session-token>` — the token travels
  in the URL fragment (never sent to the server), the console stores it
  locally, so no re-login (pin/re-login happens only if the session is
  revoked).
- **Web** (served by the guild-server binary): the SAME frontend at `/` —
  it detects the browser (no `__TAURI_INTERNALS__`), uses same-origin
  fetch/SSE instead of the engine, and runs in **chat mode** (streaming
  gateway chat; agent mode with local tools stays desktop-only — tools run
  on the machine that has the project).
- **Admin console**: the separate webui app at `/admin` (Users, Usage,
  Registry, Gateway, Downloads). Same origin + the same localStorage token
  key → auth is shared with the chat app seamlessly in web mode; its
  "Guild" title links back to `/`.

Serving: the guild-server binary embeds both frontends (`/` = chat app from
`apps/desktop/dist`, `/admin` = admin console from `apps/webui/dist`, built
with `base: /admin/`). The Dockerfile has node stages for both.

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
   VITE_DEFAULT_SERVER_URL=https://guild.example.org npm run build
   ```
   (then run the packaging script — the value is inside the shipped binary).
3. Fallback: `http://localhost:18080`.

The field stays editable, so any URL can always be typed at login.

## 3. Build-host toolchain

| Tool | Purpose | Setup |
|---|---|---|
| rustup targets | cross std libs | `rustup target add aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc` |
| zig + cargo-zigbuild | macOS/Linux cross-linking (libc + frameworks without Xcode/gcc per target) | `pacman -S zig; cargo install cargo-zigbuild` |
| macOS SDK | Apple headers/frameworks for the macOS builds | tar.xz from phracker/MacOSX-SDKs → `~/macos-sdks/MacOSX11.3.sdk` (script uses `SDKROOT` env, default that path) |
| mingw-w64-gcc | Windows-gnu targets (engine CLI builds) | `pacman -S mingw-w64-gcc` |
| cargo-xwin | MSVC-target Windows builds (GUI) — downloads the Windows SDK/CRT automatically | `cargo install --locked cargo-xwin` |
| NSIS (makensis) | Windows installer bundling | not in Arch repos: extract `nsis` + `nsis-common` debs from Ubuntu archive into `/usr/share/nsis` + `makensis` on PATH (see `~/opt/nsis`) |
| llvm + lld | `llvm-rc` (Windows resource compile), `lld-link` | `pacman -S llvm lld` |
| linuxdeploy | AppImage assembly (bundles webkit2gtk libs) | `~/opt/linuxdeploy/linuxdeploy-x86_64.AppImage` (continuous release) |
| hfsprogs | HFS+ format + fsck for macOS DMGs | AUR `hfsprogs` (`paru -S hfsprogs`) |
| libdmg-hfsplus | wraps the raw HFS+ image into a real UDIF `.dmg` | `~/opt/libdmg-hfsplus` — built with two local patches: cmake ≥3.5 and an OpenSSL-3 `filevault_stub.c` (encrypted-DMG support removed) |
| dmg2img | DMG round-trip verification | `~/opt/dmg2img` |
| webkit2gtk-4.1 | Linux GUI build | `pacman -S webkit2gtk-4.1` |

## 4. Release process

One script does everything (idempotent — republishing replaces existing
artifacts of the same version/platform). When running it detached
(systemd-run), pass the interactive PATH explicitly — `cargo-xwin` lives in
`~/.cargo/bin`, which the systemd user environment lacks:

```bash
BASE=http://localhost:18080 TOKEN=<admin-session-token> VERSION=0.1.0 \
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
   binary carries a valid linker-generated ad-hoc signature
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

## 5. Downloading + verifying clients

- UI: **Downloads** view — per-artifact **Download** (mints a short-lived
  HMAC-signed URL server-side), **copy curl**, **copy verify**; the signing
  key is displayed (pin it out-of-band after first use).
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
| darwin-aarch64 / darwin-x86_64 | build + Mach-O format + .app/DMG structure verified (fsck, plist, dmg2img); ad-hoc signature page hashes verified; **never executed** — needs a Mac |
| macOS signing | ad-hoc (linker-generated, valid); Developer ID + notarization via `rcodesign` when `GUILD_APPLE_CERT_P12`/`GUILD_APPLE_API_KEY` are provided; quarantined ad-hoc downloads still hit Gatekeeper — user workaround `xattr -dr com.apple.quarantine <path to Guild.app>` |

## 7. Release scripts

| Script | Publishes |
|---|---|
| `scripts/release-clients.sh` | one combined GUI+engine distribution per OS (exe / AppImage / 2 DMGs) — **the only script needed** |
| `scripts/release-desktop.sh` | (superseded) separate desktop-only artifacts |

Both are idempotent: they delete and replace existing artifacts of the same
version/platform, verify sha256 server-side, and abort on any mismatch.

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

Release flow (per release): bump the version, run
`BASE=… TOKEN=… VERSION=… scripts/release-clients.sh` — it signs each
artifact (AppImage, NSIS setup.exe, DMGs, `.app.tar.gz` updater bundles) and
publishes signatures alongside. Debug builds never self-update
(`GUILD_UPDATER_FORCE=1` opts in for testing).
