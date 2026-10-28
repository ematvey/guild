#!/usr/bin/env bash
# Linker wrapper for the macOS cross-build: drops repeated framework flags
# before zig's Mach-O linker sees them.
#
# rustc passes one `-framework X` per crate that links the framework, and the
# zig linker writes one LC_LOAD_DYLIB per flag. dyld on macOS 26 refuses to
# start a process whose load commands name the same dylib twice, so the flags
# are deduplicated here.
#
# GUILD_ZIG_TARGET selects the zig target triple (aarch64-macos-none or
# x86_64-macos-none); cargo-zigbuild supplies the SDK through SDKROOT.
set -euo pipefail

target="${GUILD_ZIG_TARGET:?set GUILD_ZIG_TARGET, e.g. aarch64-macos-none}"

args=()
seen=" "
i=0
while (($#)); do
  case "$1" in
    -framework|-needed_framework|-weak_framework)
      if [[ -n "${2:-}" ]]; then
        key="$1:$2"
        if [[ "$seen" == *" $key "* ]]; then
          shift 2
          continue
        fi
        seen+="$key "
        args+=("$1" "$2")
        shift 2
        continue
      fi
      ;;
  esac
  args+=("$1")
  shift
done

exec cargo-zigbuild zig cc -- -g -fno-sanitize=all -target "$target" "${args[@]}"
