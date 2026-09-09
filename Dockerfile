# Frontend stages: admin console (webui) + shared chat app (desktop frontend).
FROM node:22 AS webui
WORKDIR /web
COPY apps/webui/package.json apps/webui/package-lock.json* ./
RUN npm install
COPY apps/webui ./
RUN npm run build

FROM node:22 AS chatapp
WORKDIR /app
COPY apps/desktop/package.json apps/desktop/package-lock.json* ./
RUN npm install
COPY apps/desktop ./
RUN npm run build

# Build stage: compile guild-server from the workspace.
FROM rust:1.97 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
COPY apps/desktop/src-tauri ./apps/desktop/src-tauri
COPY --from=webui /web/dist ./apps/webui/dist
COPY --from=chatapp /app/dist ./apps/desktop/dist
RUN cargo build --release -p guild-server

# Runtime stage.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/guild-server /usr/local/bin/guild-server
EXPOSE 8080
ENTRYPOINT ["guild-server"]
