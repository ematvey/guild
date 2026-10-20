#!/bin/sh
# JuiceFS sidecar entrypoint.
#
# The volume must be mounted in the *host* mount namespace: the server and the
# sandbox runner bind the host directory, and the runner hands per-agent
# subpaths of it to sandbox containers through the Docker daemon, which
# resolves bind sources on the host. A FUSE mount created inside this
# container's own namespace is invisible to both (mount propagation of a FUSE
# mount is not reliable here), so this script installs the client binary on the
# host once and mounts from the host namespace via nsenter.
#
# The container runs with pid: host and privileged: true, which is what makes
# nsenter into PID 1's namespaces possible.
set -eu

log() {
  printf 'juicefs: %s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

self_pid=$$
host_bin=/usr/local/bin/juicefs
host_lib=/usr/local/lib/juicefs
mountpoint=/mnt/guild
volume_name="${GUILD_JUICE_VOLUME:-guild-workspaces}"
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

# The host process resolves the same host.docker.internal name the compose
# services use; on the host that name must point at the loopback services.
nsenter -t 1 -m -- sh -c '
  grep -q "host.docker.internal" /etc/hosts ||
    printf "127.0.0.1 host.docker.internal\n" >> /etc/hosts
'

if juicefs status "$meta_url" >/dev/null 2>&1; then
  log "volume already formatted; skipping format"
else
  log "formatting volume $volume_name"
  set -- format --storage "$storage" --bucket "$bucket_url"
  if [ -n "$access_key" ]; then set -- "$@" --access-key "$access_key"; fi
  if [ -n "$secret_key" ]; then set -- "$@" --secret-key "$secret_key"; fi
  juicefs "$@" "$meta_url" "$volume_name"
fi

# Install (or refresh) the host-side client. The binary is copied because the
# FUSE helper re-execs its own absolute path, which does not exist in the host
# namespace; the shared libraries are symlinked to this container's root, which
# the host can read through /proc/<pid>/root while the container runs.
nsenter -t 1 -m -- mkdir -p /usr/local/bin "$host_lib"
if ! nsenter -t 1 -m -- test -x "$host_bin" ||
  [ "$(nsenter -t 1 -m -- md5sum "$host_bin" | cut -d' ' -f1)" != "$(md5sum /usr/local/bin/juicefs | cut -d' ' -f1)" ]; then
  log "installing the client at $host_bin"
  nsenter -t 1 -m -- cp "/proc/$self_pid/root/usr/local/bin/juicefs" "$host_bin"
fi
for dir in /usr/lib /usr/lib/x86_64-linux-gnu /usr/lib/ceph; do
  for lib in "/proc/$self_pid/root$dir"/*.so*; do
    [ -e "$lib" ] || continue
    nsenter -t 1 -m -- ln -sf "$lib" "$host_lib/"
  done
done

# A previous run may have left a stale FUSE mount on the host.
if nsenter -t 1 -m -- findmnt -n -o FSTYPE "$mountpoint" 2>/dev/null | grep -q '^fuse'; then
  log "unmounting the stale host mount"
  nsenter -t 1 -m -- umount "$mountpoint" >/dev/null 2>&1 ||
    nsenter -t 1 -m -- umount -l "$mountpoint" >/dev/null 2>&1 ||
    true
fi

log "mounting $meta_url at $mountpoint (host namespace)"
nsenter -t 1 -m -n -- env LD_LIBRARY_PATH="$host_lib" "$host_bin" mount "$meta_url" "$mountpoint" &
mount_pid=$!

cleanup() {
  nsenter -t 1 -m -- umount "$mountpoint" >/dev/null 2>&1 || true
  kill "$mount_pid" >/dev/null 2>&1 || true
}
trap cleanup TERM INT EXIT

i=0
while [ "$i" -lt 60 ]; do
  if nsenter -t 1 -m -- findmnt -n -o FSTYPE "$mountpoint" 2>/dev/null | grep -q '^fuse'; then
    log "volume is ready at $mountpoint"
    break
  fi
  if ! kill -0 "$mount_pid" 2>/dev/null; then
    die "mount process exited before the volume became ready"
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 60 ] || die "timed out waiting for the mount"

# Per-agent workspace quota: every agent directory under agents/<org>/<id>
# gets the same capacity. Setting it repeatedly is idempotent and covers
# agents created while this sidecar is running.
quota_gib="${GUILD_AGENT_WORKSPACE_GIB:-50}"
quota_interval="${GUILD_AGENT_QUOTA_INTERVAL:-300}"
# The mount lives in the host namespace, so the sweep must run there too.
nsenter -t 1 -m -- sh -c '
  while true; do
    for dir in "$1"/agents/*/*; do
      [ -d "$dir" ] || continue
      rel=${dir#"$1"}
      LD_LIBRARY_PATH="$2" "$3" quota set "$4" \
        --path "$rel" --capacity "$5" >/dev/null 2>&1 || true
    done
    sleep "$6"
  done
' sh "$mountpoint" "$host_lib" "$host_bin" "$meta_url" "$quota_gib" "$quota_interval" &
quota_pid=$!

cleanup_quota() {
  kill "$quota_pid" >/dev/null 2>&1 || true
}
trap 'cleanup_quota; cleanup' TERM INT EXIT

wait "$mount_pid"
