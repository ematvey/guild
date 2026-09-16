# Frontend build stage: the shared web app depends on the @guild/ui kit
# (packages/ui); deps are hoisted into a single root install via npm workspaces.
FROM node:22 AS chatapp
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ui ./packages/ui
# The client type-imports the protocol's TS bindings (crates/protocol/bindings).
COPY crates/protocol/bindings ./crates/protocol/bindings
COPY apps/desktop ./apps/desktop
RUN npm ci --workspace apps/desktop --no-audit --no-fund
RUN npm run build --workspace apps/desktop

# Build stage: compile guild-server from the workspace.
FROM rust:1.97 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
COPY apps/desktop/src-tauri ./apps/desktop/src-tauri
COPY --from=chatapp /app/apps/desktop/dist ./apps/desktop/dist
RUN cargo build --release -p guild-server

# Runtime stage.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/guild-server /usr/local/bin/guild-server
EXPOSE 8080
ENTRYPOINT ["guild-server"]
