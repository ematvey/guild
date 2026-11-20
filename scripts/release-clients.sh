#!/usr/bin/env bash
# Cross-build all six signed desktop artifacts into OUTPUT_DIR.
# Local entry point: node scripts/release.mjs preview [build-number].
# The preview orchestrator stamps versions in a disposable worktree.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${GUILD_RELEASE_STAGED:-}" == 1 ]] || { exec node scripts/release.mjs preview "$@"; }
VERSION="${VERSION:?set VERSION}"
OUTPUT_DIR="${OUTPUT_DIR:?set OUTPUT_DIR}"
export VITE_DEFAULT_SERVER_URL=""
export SDKROOT="${SDKROOT:-$HOME/macos-sdks/MacOSX11.3.sdk}"
UPDATER_KEY="${UPDATER_KEY:-$HOME/.tauri/guild.key}"
export TAURI_SIGNING_PRIVATE_KEY="$UPDATER_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
[[ "$(node scripts/release.mjs version)" == "$VERSION" ]] || { echo "build versions differ" >&2; exit 1; }
# Every tool the three platform builds call, checked before the first
# compile so a missing one costs seconds and not a build.
NEEDED_TOOLS=(cargo rustup zig cargo-zigbuild cargo-xwin makensis llvm-rc
  linuxdeploy dmg mkfs.hfsplus fsck.hfsplus 7z jq)
missing=()
for t in "${NEEDED_TOOLS[@]}"; do
  command -v "$t" >/dev/null || missing+=("$t")
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: not on PATH: ${missing[*]}" >&2
  exit 1
fi
if [[ ! -d "$SDKROOT" ]]; then
  echo "ERROR: macOS SDK not found at $SDKROOT (set SDKROOT)" >&2
  exit 1
fi

# The compatibility gate: a schema change an installed client cannot read
# must not ship, and must not become the next baseline.
echo "==> protocol compatibility check"
node protocol/check.mjs

echo "==> building the single client binary (GUI + engine)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc >/dev/null

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# Signs a file with the tauri updater key; echoes the signature content.
sign() { # file -> stdout signature
  local sig="$1.sig"
  # env -u: -f conflicts with TAURI_SIGNING_PRIVATE_KEY inherited from above
  (cd apps/desktop && env -u TAURI_SIGNING_PRIVATE_KEY npx tauri signer sign \
    -f "$UPDATER_KEY" --password "" --app-version "$VERSION" "$1" >/dev/null)
  cat "$sig"
  rm -f "$sig"
}

publish() { # platform src filename signature
  local src="$2" filename="$3" signature="$4"
  mkdir -p "$OUTPUT_DIR"
  cp "$src" "$OUTPUT_DIR/$filename"
  printf '%s\n' "$signature" > "$OUTPUT_DIR/$filename.sig"
  echo "==> collected $1: $filename"
}

# ---- windows-x86_64: official NSIS installer, cross-built via cargo-xwin ----
echo "==> windows: tauri build (cargo-xwin) + NSIS bundling"
(cd apps/desktop && npm run build >/dev/null)
(cd apps/desktop && timeout 3600 npm run tauri build -- \
  --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis >/dev/null)
WIN_SETUP="target/x86_64-pc-windows-msvc/release/bundle/nsis/Guild_${VERSION}_x64-setup.exe"
cp "$WIN_SETUP" "$STAGE/"
WIN_SIG=$(sign "$STAGE/Guild_${VERSION}_x64-setup.exe")
publish windows-x86_64 "$STAGE/Guild_${VERSION}_x64-setup.exe" "Guild_${VERSION}_x64-setup.exe" "$WIN_SIG"

# ---- linux-x86_64: AppImage via linuxdeploy ----
echo "==> linux: AppImage via linuxdeploy"
# native build: the GUI links the host webkit2gtk, so zig cross-linking with
# a glibc floor does not apply; linuxdeploy bundles the libs instead
cargo build --release -p guild-desktop --features tauri/custom-protocol >/dev/null
AD="$STAGE/guild.AppDir"
mkdir -p "$AD/usr/bin" "$AD/usr/share/icons/hicolor/128x128/apps" "$AD/usr/share/applications"
cp target/release/guild-desktop "$AD/usr/bin/guild"
cp apps/desktop/src-tauri/icons/128x128.png "$AD/usr/share/icons/hicolor/128x128/apps/guild.png"
cat > "$AD/usr/share/applications/guild.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Guild
Comment=Guild client (GUI + engine)
Exec=guild
Icon=guild
Categories=Development;Office;
EOF
cp "$AD/usr/share/applications/guild.desktop" "$AD/guild.desktop"
cp apps/desktop/src-tauri/icons/128x128.png "$AD/guild.png"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 \
  linuxdeploy --appdir "$AD" --output appimage >/dev/null
# linuxdeploy emits the AppImage inside the AppDir (absolute --appdir) or in CWD
APPIMG=$(find "$AD" "$STAGE" "$(pwd)" -maxdepth 3 -name "Guild*x86_64.AppImage" 2>/dev/null | head -1)
if [[ -z "$APPIMG" ]]; then echo "AppImage build failed" >&2; exit 1; fi
[[ "$APPIMG" == "$STAGE/Guild-x86_64.AppImage" ]] || mv "$APPIMG" "$STAGE/"
LINUX_SIG=$(sign "$STAGE/Guild-${VERSION}-x86_64.AppImage")
publish linux-x86_64 "$STAGE/Guild-${VERSION}-x86_64.AppImage" "Guild-${VERSION}-x86_64.AppImage" "$LINUX_SIG"

# ---- macos: .app + drag-and-drop DMG (hfsprogs + libdmg-hfsplus) ----
echo "==> macos: .app + DMG"
# The zigbuild binary is ad-hoc signed by the linker. Without a Developer ID
# signature macOS Gatekeeper reports a quarantined download as "damaged"; the
# user-side workaround is
#   xattr -dr com.apple.quarantine /Applications/Guild.app
# With GUILD_APPLE_CERT_P12 set (Developer ID Application certificate) the
# artifacts are Developer ID-signed and the DMG is notarized + stapled via
# rcodesign, which removes the Gatekeeper dialog entirely.
make_app() { # binpath out_plist_dir
  local bindir="$1"
  local app="$2"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$bindir" "$app/Contents/MacOS/Guild"
  cp apps/desktop/src-tauri/icons/icon.icns "$app/Contents/Resources/icon.icns"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Guild</string>
  <key>CFBundleDisplayName</key><string>Guild</string>
  <key>CFBundleIdentifier</key><string>org.guild.desktop</string>
  <key>CFBundleExecutable</key><string>Guild</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF
}

build_dmg() { # arch
  local arch="$1"
  local bin="target/$arch-apple-darwin/release/guild-desktop"
  # rustc passes one `-framework X` per crate that links the framework, and
  # the zig Mach-O linker writes one LC_LOAD_DYLIB per flag. dyld on macOS 26
  # refuses to start a process whose load commands name the same dylib twice,
  # so the linker wrapper drops the repeated flags.
  local zig_target="${arch}-macos-none"
  local linker_var="CARGO_TARGET_$(echo "$arch" | tr 'a-z-' 'A-Z_')_APPLE_DARWIN_LINKER"
  env "$linker_var=$PWD/scripts/zig-link-dedup.sh" GUILD_ZIG_TARGET="$zig_target" \
    cargo zigbuild --release -p guild-desktop --features tauri/custom-protocol --target "$arch-apple-darwin" >/dev/null
  local APP="$STAGE/Guild.app"
  rm -rf "$APP"
  make_app "$bin" "$APP"
  # Developer ID-sign the bundle when a cert is provided; otherwise the
  # linker's ad-hoc signature ships as-is
  if [[ -n "${GUILD_APPLE_CERT_P12:-}" ]]; then
    command -v rcodesign >/dev/null || { echo "rcodesign not found (cargo install apple-codesign)" >&2; exit 1; }
    rcodesign sign --p12-file "$GUILD_APPLE_CERT_P12" --p12-password "${GUILD_APPLE_CERT_PASSWORD:-}" "$APP"
  fi
  local raw="$STAGE/Guild-$VERSION-macos-$arch.raw.dmg"
  rm -f "$raw"
  dd if=/dev/zero of="$raw" bs=1M count=64 status=none
  mkfs.hfsplus -v "Guild" "$raw" >/dev/null 2>&1
  sudo -n mkdir -p /mnt/guild-dmg
  sudo -n mount -t hfsplus -o loop "$raw" /mnt/guild-dmg
  sudo -n cp -R "$APP" /mnt/guild-dmg/Guild.app
  sudo -n ln -s /Applications /mnt/guild-dmg/Applications
  sudo -n umount /mnt/guild-dmg
  fsck.hfsplus "$raw" >/dev/null 2>&1 || { echo "HFS+ fsck failed for $arch" >&2; exit 1; }
  dmg build "$raw" "$STAGE/Guild-$VERSION-macos-$arch.dmg" >/dev/null 2>&1
  # notarize + staple the DMG so quarantined downloads open without the
  # Gatekeeper dialog (notarization covers the .app inside; the .app.tar.gz
  # updater artifact is installed without a quarantine flag, so it needs no
  # ticket)
  if [[ -n "${GUILD_APPLE_CERT_P12:-}" ]]; then
    rcodesign notary-submit --api-key-path "${GUILD_APPLE_API_KEY:?GUILD_APPLE_API_KEY required for notarization}" --wait "$STAGE/Guild-$VERSION-macos-$arch.dmg"
    rcodesign staple "$STAGE/Guild-$VERSION-macos-$arch.dmg"
  fi
  # updater bundle: tar.gz of the .app (what the tauri updater installs)
  (cd "$STAGE" && tar -czf "Guild-$VERSION-macos-$arch.app.tar.gz" Guild.app)
  DMG_SIG=$(sign "$STAGE/Guild-$VERSION-macos-$arch.dmg")
  TAR_SIG=$(sign "$STAGE/Guild-$VERSION-macos-$arch.app.tar.gz")
  publish "darwin-$arch" "$STAGE/Guild-$VERSION-macos-$arch.dmg" "Guild-$VERSION-macos-$arch.dmg" "$DMG_SIG"
  publish "darwin-$arch" "$STAGE/Guild-$VERSION-macos-$arch.app.tar.gz" "Guild-$VERSION-macos-$arch.app.tar.gz" "$TAR_SIG"
}
build_dmg aarch64
build_dmg x86_64

node scripts/release.mjs assemble "$OUTPUT_DIR" "$VERSION" "$GITHUB_REPOSITORY" "$RELEASE_SOURCE_COMMIT"
echo "==> all six signed artifacts ready: $OUTPUT_DIR"
