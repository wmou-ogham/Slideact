FROM rust:1.88-bookworm AS builder

WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY services ./services
COPY migrations ./migrations

RUN cargo build --locked --release --workspace

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 slide-helper \
    && useradd --system --uid 10001 --gid slide-helper --home-dir /nonexistent slide-helper

COPY --from=builder /workspace/target/release/slide-helper-api /usr/local/bin/slide-helper-api
COPY --from=builder /workspace/target/release/slide-helper-worker /usr/local/bin/slide-helper-worker

USER slide-helper:slide-helper
EXPOSE 8080 8081
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/usr/local/bin/slide-helper-api"]

