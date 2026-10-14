#!/bin/sh
# Squid drops to the `proxy` user, which cannot reopen the container's
# stdout; the access log goes through a FIFO it owns and `cat` forwards it.
set -e
rm -f /tmp/access.log
mkfifo -m 600 /tmp/access.log
chown proxy:proxy /tmp/access.log
cat /tmp/access.log &
exec squid -N -f /etc/squid/squid.conf
