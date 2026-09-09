# Frontend stages: admin console (webui) + shared chat app (desktop frontend).
# Both apps depend on the shared @guild/ui kit (packages/ui); deps are hoisted
# into a single root install via npm workspaces.
FROM node:22 AS webui
WORKDIR /web
COPY package.json package-lock.json ./
COPY packages/ui ./packages/ui
COPY apps/webui ./apps/webui
RUN npm ci --workspace apps/webui --no-audit --no-fund
RUN npm run build --workspace apps/webui

FROM node:22 AS chatapp
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ui ./packages/ui
COPY apps/desktop ./apps/desktop
RUN npm ci --workspace apps/desktop --no-audit --no-fund
RUN npm run build --workspace apps/desktop

# Build stage: compile guild-server from the workspace.
FROM rust:1.97 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
COPY apps/desktop/src-tauri ./apps/desktop/src-tauri
COPY --from=webui /web/apps/webui/dist ./apps/webui/dist
COPY --from=chatapp /app/apps/desktop/dist ./apps/desktop/dist
RUN cargo build --release -p guild-server

# Runtime stage.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/guild-server /usr/local/bin/guild-server
EXPOSE 8080
ENTRYPOINT ["guild-server"]
