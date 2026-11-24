# Build from the repository root: docker build -f apps/platform/Dockerfile .
FROM rust:1-slim-trixie@sha256:6f14b2b4b278ec0d50aa1d69541c304ce0f95e0f6268487aa9924af1c2e9aebe AS build
# The repository's own layout: the platform depends on the session engine by
# path (../../engine), and the engine's crates take their settings from its
# workspace file.
WORKDIR /src
COPY engine/Cargo.toml ./engine/
COPY engine/crates ./engine/crates
COPY apps/platform/Cargo.toml apps/platform/Cargo.lock ./apps/platform/
COPY apps/platform/src ./apps/platform/src
COPY apps/platform/migrations ./apps/platform/migrations
COPY apps/platform/examples ./apps/platform/examples
WORKDIR /src/apps/platform
RUN cargo build --release --locked --bin aule-platform

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /tmp aule
COPY --from=build /src/apps/platform/target/release/aule-platform /usr/local/bin/aule-platform
# The skill catalogs, loaded by `serve` at start (see main.rs).
COPY curriculum/*.json /usr/share/aule/curriculum/
USER aule
# The commit it is built from (RELEASING.md), read when it runs. Last, so a new
# one rebuilds no layer and recompiles nothing.
ARG AULE_COMMIT=unknown
ENV AULE_COMMIT=$AULE_COMMIT
ENTRYPOINT ["aule-platform"]
CMD ["serve"]
