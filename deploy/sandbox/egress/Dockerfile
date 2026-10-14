# Sandbox egress proxy: the only route out of the internal `sandbox`
# network. Squid with a hostname allowlist (allowed-domains.txt, mounted by
# compose) and a deny for private/loopback/link-local destinations after
# DNS resolution.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends squid \
  && rm -rf /var/lib/apt/lists/*
COPY squid.conf /etc/squid/squid.conf
COPY allowed-domains.txt /etc/squid/allowed-domains.txt
COPY entrypoint.sh /usr/local/bin/egress-entrypoint
EXPOSE 3128
CMD ["egress-entrypoint"]
