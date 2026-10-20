#!/bin/sh
# JuiceFS sidecar entrypoint: format the volume once, then mount it in the
# foreground into the host-shared mountpoint. The mount propagates to the
# host (rshared), where the guild_workspaces volume binds it.
set -eu

log() {
  printf 'juicefs: %s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

mountpoint="${GUILD_JUICE_MOUNT:-/mnt/juicefs}"
volume_name="${GUILD_JUICE_VOLUME:-guild}"
storage="${GUILD_JUICE_STORAGE:-s3}"

meta_url="${GUILD_JUICE_META_URL:-}"
if [ -z "$meta_url" ]; then
  [ -n "${GUILD_DATABASE_URL:-}" ] || die "set GUILD_JUICE_META_URL or GUILD_DATABASE_URL"
  # Same Postgres credentials as the stack, dedicated database.
  meta_url="${GUILD_DATABASE_URL%/*}/guild_meta"
fi

bucket="${GUILD_JUICE_BUCKET:-guild-workspaces}"
case "$bucket" in
  *://*) bucket_url="$bucket" ;;
  *)
    s3_url="${GUILD_JUICE_S3_URL:-${GUILD_S3_URL:-}}"
    [ -n "$s3_url" ] || die "set GUILD_JUICE_BUCKET to a URL or set GUILD_JUICE_S3_URL"
    bucket_url="${s3_url%/}/$bucket"
    ;;
esac

access_key="${GUILD_JUICE_ACCESS_KEY:-${GUILD_S3_ACCESS_KEY_ID:-}}"
secret_key="${GUILD_JUICE_SECRET_KEY:-${GUILD_S3_SECRET_ACCESS_KEY:-}}"

# A previous container may have left a stale FUSE mount on the host.
fusermount -u "$mountpoint" >/dev/null 2>&1 ||
  fusermount3 -u "$mountpoint" >/dev/null 2>&1 ||
  umount "$mountpoint" >/dev/null 2>&1 ||
  true
mkdir -p "$mountpoint"

if juicefs status "$meta_url" >/dev/null 2>&1; then
  log "volume already formatted; skipping format"
else
  log "formatting volume $volume_name"
  set -- format --storage "$storage" --bucket "$bucket_url"
  if [ -n "$access_key" ]; then set -- "$@" --access-key "$access_key"; fi
  if [ -n "$secret_key" ]; then set -- "$@" --secret-key "$secret_key"; fi
  juicefs "$@" "$meta_url" "$volume_name"
fi

log "mounting $meta_url at $mountpoint"
exec juicefs mount "$meta_url" "$mountpoint"
