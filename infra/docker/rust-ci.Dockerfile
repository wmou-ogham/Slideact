FROM rust:1.88-bookworm

WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY services ./services
COPY migrations ./migrations

RUN cargo fmt --all -- --check
RUN cargo clippy --locked --workspace --all-targets -- -D warnings
RUN cargo test --locked --workspace --all-targets
