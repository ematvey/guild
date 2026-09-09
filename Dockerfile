# Build stage: compile guild-server from the workspace.
FROM rust:1.97 AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY crates ./crates
COPY apps/desktop/src-tauri ./apps/desktop/src-tauri
RUN cargo build --release -p guild-server

# Runtime stage.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/guild-server /usr/local/bin/guild-server
EXPOSE 8080
ENTRYPOINT ["guild-server"]
